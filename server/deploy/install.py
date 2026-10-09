#!/usr/bin/env python3
"""Install the reviewed git revision on the chosen VPS, with scoped rollback."""
import argparse
import datetime
import fcntl
import grp
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import resource
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time

from nginx_config import DEFAULT_HOST, INCLUDE, inspect_dump, patch_vhost, validate_host
from preflight import inspect, PreflightError, run


BASE = Path("/opt/ri-subtitles")
CONFIG = Path("/etc/ri-subtitles")
MODEL_REVISION = "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"
MODEL = Path("/var/lib/ri-subtitles-model") / MODEL_REVISION
MARKER = CONFIG / "installation.json"
SERVICE = Path("/etc/systemd/system/ri-subtitles.service")
SOCKET = Path("/etc/systemd/system/ri-subtitles.socket")
PROBE_MAX_BYTES = 65536


class ProbeError(PreflightError):
    def __init__(self, message, *, retryable=True):
        super().__init__(message)
        self.retryable = retryable


def probe_metadata(phase, status, content_type, size, curl_exit=None):
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    # Print known media types only, never arbitrary response header contents.
    safe_type = mime if mime in {"application/json", "text/html", "text/plain", "application/octet-stream"} else ("other" if mime else "none")
    suffix = f" curl={curl_exit}" if curl_exit is not None else ""
    return f"{phase}: HTTP={status} type={safe_type} bytes={size}{suffix}"


def decode_probe(body, status, content_type, phase, *, expected_status=None, require_ready=False, curl_exit=None):
    detail = probe_metadata(phase, status, content_type, len(body), curl_exit)
    if len(body) > PROBE_MAX_BYTES:
        raise ProbeError(f"{detail}; răspuns prea mare.")
    if expected_status is not None and status != expected_status:
        raise ProbeError(f"{detail}; status HTTP neașteptat (așteptat {expected_status}).")
    if (content_type or "").split(";", 1)[0].strip().lower() != "application/json":
        raise ProbeError(f"{detail}; tipul răspunsului nu este JSON.")
    try:
        value = json.loads(body)
    except (ValueError, UnicodeError):
        raise ProbeError(f"{detail}; corp JSON invalid.") from None
    if not isinstance(value, dict):
        raise ProbeError(f"{detail}; este necesar un obiect JSON.")
    if require_ready and value.get("ready") is not True:
        raise ProbeError(f"{detail}; ready nu este true.")
    if require_ready and value.get("access") != "public":
        raise ProbeError(f"{detail}; accesul public fără cod nu este confirmat.")
    return value


def atomic_write(path, data, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    previous = path.stat() if path.exists() else None
    fd, temporary = tempfile.mkstemp(prefix=".ri-subtitles-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, stat.S_IMODE(previous.st_mode) if previous else mode)
        if previous:
            os.chown(temporary, previous.st_uid, previous.st_gid)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def check_private(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise PreflightError(f"{path} trebuie să fie fișier root-only cu modul 0600.")


def state(unit, action):
    return subprocess.run(["systemctl", action, "--quiet", unit], stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0


def uds_request(method, path, *, phase="UDS", expected_status=None, require_ready=False):
    connection = http.client.HTTPConnection("localhost", timeout=5)
    try:
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(5)
        connection.sock.connect("/run/ri-subtitles/api.sock")
        connection.request(method, path)
        response = connection.getresponse()
        body = response.read(PROBE_MAX_BYTES + 1)
        return response.status, decode_probe(body, response.status, response.getheader("Content-Type"), phase,
                                            expected_status=expected_status, require_ready=require_ready)
    except (OSError, http.client.HTTPException):
        raise ProbeError(f"{phase}: HTTP=0 type=none bytes=0; comunicarea pe socket a eșuat.") from None
    finally:
        connection.close()


def wait_ready():
    print("Verificare: UDS health.", flush=True)
    deadline = time.monotonic() + 40
    last = "UDS health: încă nu există un răspuns."
    while time.monotonic() < deadline:
        try:
            uds_request("GET", "/v1/health", phase="UDS health", expected_status=200, require_ready=True)
            return
        except PreflightError as error:
            last = str(error)
        time.sleep(0.5)
    raise PreflightError(f"Serviciul nu a confirmat readiness pe socket în 40 secunde. {last}")


def read_marker_for_host(host):
    host = validate_host(host)
    previous = json.loads(MARKER.read_text()) if MARKER.exists() else {}
    if previous.get("host", DEFAULT_HOST) != host and MARKER.exists():
        raise PreflightError("Instalarea existentă folosește alt domeniu; host-ul nu poate fi schimbat prin actualizare.")
    return previous


def limit_probe_files():
    # Child-only cap also covers chunked replies with older curl versions.
    _, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
    limit = PROBE_MAX_BYTES + 1 if hard == resource.RLIM_INFINITY else min(PROBE_MAX_BYTES + 1, hard)
    resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))


def https_probe(url, options, phase, timeout):
    with tempfile.TemporaryDirectory(prefix="ri-subtitles-probe-") as temporary:
        output = Path(temporary) / "body"
        command = ["curl", "--disable", "--silent", "--show-error", "--max-time", str(timeout),
                   "--max-filesize", str(PROBE_MAX_BYTES), "--output", str(output),
                   "--write-out", "%{http_code}\n%{content_type}\n"] + options + [url]
        try:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                                    timeout=timeout + 1, preexec_fn=limit_probe_files)
        except subprocess.TimeoutExpired:
            raise ProbeError(f"{phase}: HTTP=0 type=none bytes=0 curl=timeout.") from None
        except OSError:
            raise ProbeError(f"{phase}: HTTP=0 type=none bytes=0 curl=unavailable.", retryable=False) from None
        metadata = result.stdout.splitlines()
        status = int(metadata[0]) if metadata and len(metadata[0]) == 3 and metadata[0].isdigit() else 0
        content_type = metadata[1] if len(metadata) > 1 else ""
        body = b""
        if output.is_file():
            with output.open("rb") as handle:
                body = handle.read(PROBE_MAX_BYTES + 1)
        if result.returncode:
            detail = probe_metadata(phase, status, content_type, len(body), result.returncode)
            raise ProbeError(f"{detail}; cererea curl a eșuat.", retryable=result.returncode not in {2, 3, 35, 51, 58, 60, 77, 82, 83, 90, 91})
        return decode_probe(body, status, content_type, phase, expected_status=200, require_ready=True, curl_exit=0)


def verify_https(host):
    host = validate_host(host)
    url = f"https://{host}/api/ri-subtitles/v1/health"
    for phase, options in (("HTTPS local", ["--noproxy", "*", "--resolve", f"{host}:443:127.0.0.1"]), ("HTTPS public", [])):
        print(f"Verificare: {phase}.", flush=True)
        deadline = time.monotonic() + 20
        last = f"{phase}: încă nu există un răspuns."
        while (remaining := deadline - time.monotonic()) > 0:
            try:
                https_probe(url, options, phase, min(5, remaining))
                break
            except ProbeError as error:
                last = str(error)
                if not error.retryable:
                    raise
            if (remaining := deadline - time.monotonic()) > 0:
                time.sleep(min(0.5, remaining))
        else:
            raise PreflightError(f"{phase} nu confirmă readiness în 20 secunde. {last}")


def create_release(source):
    revision = run(["git", "-C", str(source), "rev-parse", "HEAD"]).strip()
    if len(revision) != 40 or any(char not in "0123456789abcdef" for char in revision):
        raise PreflightError("Revizia Git nu este validă.")
    if run(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no", "--", "server", "assets/subtitles-font.ttf"]):
        raise PreflightError("Fișierele de instalare au modificări necomise. Folosiți checkout-ul reviziei aprobate.")
    release = BASE / "releases" / revision
    complete = release / "release.json"
    if release.exists():
        if complete.is_file() and json.loads(complete.read_text()).get("revision") == revision:
            return release, revision
        raise PreflightError(f"Există o instalare incompletă la {release}; inspectați directorul înainte de reluare.")
    release.mkdir(parents=True, mode=0o755)
    files = run(["git", "-C", str(source), "ls-tree", "-r", "--name-only", revision, "--", "server", "assets/subtitles-font.ttf", "assets/subtitles-font-LICENSE.txt"]).splitlines()
    for name in files:
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise PreflightError("Cale Git nesigură în pachet.")
        target = release / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(["git", "-C", str(source), "show", revision + ":" + name],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        atomic_write(target, result.stdout)
    subprocess.run([sys.executable, "-m", "venv", str(release / ".venv")], check=True)
    interpreter = str(release / ".venv/bin/python")
    subprocess.run([interpreter, "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
                    "--only-binary=:all:", "-r", str(release / "server/requirements.lock.txt")], check=True)
    subprocess.run([interpreter, "-m", "pip", "check"], check=True)
    atomic_write(complete, json.dumps({"revision": revision}).encode())
    return release, revision


def service_environment(release, previous=""):
    text = ("RI_SUBTITLES_DATA_DIR=/var/lib/ri-subtitles\n"
            f"RI_SUBTITLES_MODEL_DIR={MODEL}\n"
            f"RI_SUBTITLES_FONT_PATH={release}/assets/subtitles-font.ttf\n"
            "RI_SUBTITLES_ALLOWED_ORIGINS=https://djcioko.github.io\n")
    # Preserve operator-set limits while retiring the former shared credential.
    replaced = {line.split("=", 1)[0] for line in text.splitlines()} | {"RI_SUBTITLES_ACCESS_CODE"}
    optional = [line for line in previous.splitlines()
                if line.startswith("RI_SUBTITLES_") and line.split("=", 1)[0] not in replaced]
    return text + ("\n".join(optional) + "\n" if optional else "")


def install(source, host=DEFAULT_HOST):
    host = validate_host(host)
    read_marker_for_host(host)
    info = inspect(host)
    print("Verificare inițială acceptată. Vhost TLS:", info["vhost"], flush=True)
    managed = MARKER.exists()
    previous_marker = read_marker_for_host(host)
    paths = [Path(info["vhost"]), Path(INCLUDE), SERVICE, SOCKET, CONFIG / "service.env", MARKER]
    initial_contents = {path: path.read_bytes() if path.is_file() else None for path in paths}
    for path in paths[1:]:
        if path.is_symlink():
            raise PreflightError(f"Nu se înlocuiește un fișier gestionat care este symlink: {path}")
        if path.exists() and not managed:
            raise PreflightError(f"Există deja {path} fără marcajul instalatorului; verificare manuală necesară.")
    if managed:
        for name, digest in previous_marker.get("managedFiles", {}).items():
            path = Path(name)
            if path not in paths or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise PreflightError("O configurație gestionată a fost modificată; revizuire manuală înainte de actualizare.")
        check_private(CONFIG / "service.env")
    old_status = {unit: {"active": state(unit, "is-active"), "enabled": state(unit, "is-enabled")}
                  for unit in ("ri-subtitles.service", "ri-subtitles.socket")}
    if not managed and any(any(values.values()) for values in old_status.values()):
        raise PreflightError("Numele ri-subtitles este deja folosit de un serviciu negestionat.")
    CONFIG.mkdir(mode=0o700, exist_ok=True)
    os.chmod(CONFIG, 0o700)
    BASE.mkdir(mode=0o755, exist_ok=True)
    release, revision = create_release(source)
    interpreter = str(release / ".venv/bin/python")
    MODEL.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    MODEL.parent.chmod(0o755)
    print("Instalez/verific modelul vocal fixat (aproximativ 1,62 GB).", flush=True)
    subprocess.run([interpreter, str(release / "server/scripts/download_model.py"), "--model-dir", str(MODEL)], check=True)
    environment = {**os.environ, "HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "ORT_DISABLE_TELEMETRY": "1", "OMP_NUM_THREADS": "2"}
    account_marker = BASE / "account.json"
    try:
        account = pwd.getpwnam("ri-subtitles")
        identity = json.loads(account_marker.read_text()) if account_marker.exists() else {}
        if (account.pw_uid == 0 or identity.get("uid") != account.pw_uid or identity.get("gid") != account.pw_gid
                or account.pw_shell not in {"/usr/sbin/nologin", "/sbin/nologin", "/bin/false"}):
            raise PreflightError("Contul ri-subtitles existent nu este contul dedicat al acestui instalator.")
    except KeyError:
        subprocess.run(["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent",
                        "--shell", "/usr/sbin/nologin", "ri-subtitles"], check=True)
        account = pwd.getpwnam("ri-subtitles")
        atomic_write(account_marker, json.dumps({"uid": account.pw_uid, "gid": account.pw_gid}).encode(), 0o600)
    # Load the actual offline model AS THE SERVICE USER, before modifying any
    # active unit or vhost. A root-only permission success is insufficient.
    subprocess.run([interpreter, "-c", "import ctranslate2; from faster_whisper import WhisperModel; "
                    "assert 'int8' in ctranslate2.get_supported_compute_types('cpu'); "
                    "WhisperModel(__import__('sys').argv[1], device='cpu', compute_type='int8', cpu_threads=2, num_workers=1, local_files_only=True)", str(MODEL)],
                   env=environment, cwd=release, user=account.pw_uid, group=account.pw_gid, extra_groups=(), check=True, timeout=180)
    service_env = CONFIG / "service.env"
    env_text = service_environment(release, service_env.read_text() if service_env.exists() else "")
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = Path("/var/backups/ri-subtitles") / (timestamp + "-" + secrets.token_hex(3))
    backup.mkdir(parents=True, mode=0o700)
    os.chmod(backup.parent, 0o700)
    saved = {}
    for index, path in enumerate(paths):
        copy = backup / str(index)
        if path.exists():
            shutil.copy2(path, copy)
            os.chmod(copy, 0o600)
            saved[path] = (copy, path.stat())
        else:
            saved[path] = None
    atomic_write(backup / "restore-map.json", json.dumps({str(path): str(value[0]) if value else None
                 for path, value in saved.items()}, indent=2).encode(), 0o600)
    old_link = os.readlink(BASE / "current") if (BASE / "current").is_symlink() else None
    if (BASE / "current").exists() and old_link is None:
        raise PreflightError("/opt/ri-subtitles/current există și nu este symlink; nu se înlocuiește.")
    vhost_original = paths[0].read_bytes()
    contents = {
        paths[0]: patch_vhost(vhost_original.decode(), host).encode(),
        Path(INCLUDE): (release / "server/deploy/ri-subtitles.nginx.conf").read_text().replace("@API_HOST@", host).encode(),
        SERVICE: (release / "server/deploy/ri-subtitles.service.in").read_text().replace("/opt/ri-subtitles/current", str(release)).encode(),
        SOCKET: (release / "server/deploy/ri-subtitles.socket.in").read_text().replace("@NGINX_GROUP@", info["nginx_group"]).encode(),
        service_env: env_text.encode(),
    }
    changed = False
    try:
        # Detect a concurrent administrator edit after preflight/model setup.
        current_info = inspect_dump(run(["nginx", "-T"]), host)
        if (Path(current_info["vhost"]).resolve() != paths[0] or current_info["nginx_group"] != info["nginx_group"]
                or any((path.read_bytes() if path.is_file() else None) != value for path, value in initial_contents.items())):
            raise PreflightError("Configurația activă s-a schimbat în timpul instalării; reluați verificarea.")
        changed = True
        for path, data in contents.items():
            atomic_write(path, data, 0o600 if path == service_env else 0o644)
        (BASE / "current").unlink(missing_ok=True)
        (BASE / "current").symlink_to(release)
        run(["nginx", "-t"])
        run(["systemd-analyze", "verify", str(SERVICE), str(SOCKET)])
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "ri-subtitles.socket", "ri-subtitles.service"])
        run(["systemctl", "start", "ri-subtitles.socket"])
        run(["systemctl", "restart", "ri-subtitles.service"])
        wait_ready()
        print("Verificare: UDS acces public fără cod (404 pentru lucrare inexistentă).", flush=True)
        uds_request("GET", "/v1/jobs/" + "0" * 32, phase="UDS public fără cod", expected_status=404)
        run(["systemctl", "reload", "nginx"])
        verify_https(host)
        if not state("ri-subtitles.service", "is-active") or not state("ri-subtitles.socket", "is-active"):
            raise PreflightError("Serviciul sau socketul nu este activ.")
        atomic_write(MARKER, json.dumps({"revision": revision, "host": host, "vhost": info["vhost"], "backup": str(backup),
                    "managedFiles": {str(path): hashlib.sha256(data).hexdigest() for path, data in contents.items()
                                     if path != paths[0] and path != service_env}}, indent=2).encode(), 0o600)
    except BaseException:
        if changed:
            print("Activarea a eșuat. Restaurez numai configurațiile serviciului și vhost-ul salvat.", file=sys.stderr)
            subprocess.run(["systemctl", "stop", "ri-subtitles.service", "ri-subtitles.socket"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for unit, values in old_status.items():
                if not values["enabled"]:
                    subprocess.run(["systemctl", "disable", unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for path, value in saved.items():
                if value:
                    copy, metadata = value
                    atomic_write(path, copy.read_bytes())
                    os.chmod(path, stat.S_IMODE(metadata.st_mode))
                    os.chown(path, metadata.st_uid, metadata.st_gid)
                else:
                    path.unlink(missing_ok=True)
            (BASE / "current").unlink(missing_ok=True)
            if old_link is not None:
                (BASE / "current").symlink_to(old_link)
            run(["systemctl", "daemon-reload"])
            for unit, values in old_status.items():
                if values["enabled"]:
                    run(["systemctl", "enable", unit])
            if old_status["ri-subtitles.socket"]["active"]:
                run(["systemctl", "start", "ri-subtitles.socket"])
            if old_status["ri-subtitles.service"]["active"]:
                run(["systemctl", "start", "ri-subtitles.service"])
            run(["nginx", "-t"])
            run(["systemctl", "reload", "nginx"])
            print("Configurațiile anterioare au fost restaurate. Backup:", backup, file=sys.stderr)
        raise
    print("Serviciul de subtitrare este activ și verificat prin socket și HTTPS.")
    print("Revizie:", revision)
    print("Backup privat:", backup)
    print("Acces public activ: subtitrarea funcționează fără cod de acces.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--host", type=validate_host, default=DEFAULT_HOST, help="Domeniul explicit al vhost-ului TLS.")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.exit(1, "Rulați instalatorul cu sudo în terminalul VPS-ului.\n")
    try:
        read_marker_for_host(args.host)
    except (PreflightError, OSError, ValueError) as error:
        parser.exit(1, f"Instalarea a fost oprită: {error}\n")
    # Code/model directories are public-readable; each private path is explicitly
    # created with 0700/0600 below, independent of the caller's umask.
    os.umask(0o022)
    lock_path = Path("/run/lock/ri-subtitles-install.lock")
    with lock_path.open("w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "Altă instalare ri-subtitles este în desfășurare.\n")
        try:
            install(args.source_root.resolve(), args.host)
        except Exception as error:
            # Do not print subprocess output or private configuration.
            if isinstance(error, subprocess.CalledProcessError):
                parser.exit(1, "Instalarea a fost oprită: o comandă a eșuat. Consultați ieșirea locală de mai sus.\n")
            parser.exit(1, f"Instalarea a fost oprită: {error}\n")


if __name__ == "__main__":
    main()
