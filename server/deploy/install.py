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


def uds_request(method, path, code=None):
    connection = http.client.HTTPConnection("localhost", timeout=5)
    connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.sock.settimeout(5)
    connection.sock.connect("/run/ri-subtitles/api.sock")
    try:
        connection.request(method, path, headers={"Authorization": "Bearer " + code} if code else {})
        response = connection.getresponse()
        body = response.read(65537)
        if len(body) > 65536:
            raise PreflightError("Răspuns de verificare neașteptat de mare.")
        return response.status, json.loads(body)
    finally:
        connection.close()


def wait_ready():
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        try:
            status, health = uds_request("GET", "/v1/health")
            if status == 200 and health.get("ready") is True:
                return
        except (OSError, ValueError, http.client.HTTPException):
            pass
        time.sleep(0.5)
    raise PreflightError("Serviciul nu a confirmat readiness pe socket în 40 secunde.")


def read_marker_for_host(host):
    host = validate_host(host)
    previous = json.loads(MARKER.read_text()) if MARKER.exists() else {}
    if previous.get("host", DEFAULT_HOST) != host and MARKER.exists():
        raise PreflightError("Instalarea existentă folosește alt domeniu; host-ul nu poate fi schimbat prin actualizare.")
    return previous


def verify_https(host):
    host = validate_host(host)
    url = f"https://{host}/api/ri-subtitles/v1/health"
    common = ["curl", "--fail", "--silent", "--show-error", "--max-time", "15"]
    for label, options in (("locală", ["--noproxy", "*", "--resolve", f"{host}:443:127.0.0.1"]), ("publică", [])):
        health = json.loads(run(common + options + [url], timeout=20))
        if health.get("ready") is not True:
            raise PreflightError(f"Ruta HTTPS {label} nu confirmă readiness.")


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
    if service_env.exists():
        code_lines = [line.split("=", 1)[1] for line in service_env.read_text().splitlines() if line.startswith("RI_SUBTITLES_ACCESS_CODE=")]
        if len(code_lines) != 1 or len(code_lines[0]) < 32:
            raise PreflightError("Codul privat existent nu este valid; nu este înlocuit automat.")
        code = code_lines[0]
    else:
        code = secrets.token_urlsafe(32)
    env_text = (f"RI_SUBTITLES_ACCESS_CODE={code}\n"
                "RI_SUBTITLES_DATA_DIR=/var/lib/ri-subtitles\n"
                f"RI_SUBTITLES_MODEL_DIR={MODEL}\n"
                f"RI_SUBTITLES_FONT_PATH={release}/assets/subtitles-font.ttf\n"
                "RI_SUBTITLES_ALLOWED_ORIGINS=https://djcioko.github.io\n")
    # Existing operator-set limits persist across upgrades.
    if service_env.exists():
        required = {line.split("=", 1)[0] for line in env_text.splitlines()}
        env_text += "\n".join(line for line in service_env.read_text().splitlines()
                              if line.startswith("RI_SUBTITLES_") and line.split("=", 1)[0] not in required) + "\n"
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
        if uds_request("GET", "/v1/jobs/" + "0" * 32)[0] != 401 or uds_request("GET", "/v1/jobs/" + "0" * 32, code)[0] != 404:
            raise PreflightError("Verificarea autentificării API a eșuat.")
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
    print("Codul de acces rămâne în /etc/ri-subtitles/service.env; nu îl includeți în rapoarte sau mesaje.")


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
