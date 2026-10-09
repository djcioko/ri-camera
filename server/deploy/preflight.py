#!/usr/bin/env python3
"""Read-only checks. Never prints nginx contents or private configuration."""
import grp
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import subprocess
import sys

from nginx_config import ConfigurationError, inspect_dump, patch_vhost


class PreflightError(RuntimeError):
    pass


def run(argv, *, timeout=30):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, timeout=timeout)
    if result.returncode:
        # nginx -T and other tools may echo secrets on error. Do not log contents.
        raise PreflightError(f"Comanda {Path(argv[0]).name} a eșuat; verificați în terminalul VPS-ului.")
    return result.stdout


def inspect():
    if os.geteuid() != 0:
        raise PreflightError("Rulați verificarea cu sudo pe VPS (citește configurația Nginx activă).")
    if sys.version_info < (3, 12):
        raise PreflightError(f"Python {sys.version_info.major}.{sys.version_info.minor} este prea vechi. Rulați sudo bash server/scripts/setup_python.sh pentru runtime-ul separat.")
    try:
        import ensurepip, venv
    except ImportError:
        raise PreflightError("Lipsește venv/ensurepip. Rulați sudo bash server/scripts/setup_python.sh pentru runtime-ul separat.")
    if platform.system() != "Linux" or not Path("/run/systemd/system").is_dir():
        raise PreflightError("Este necesar Linux cu systemd activ.")
    for name in ("nginx", "systemctl", "systemd-analyze", "ffmpeg", "ffprobe", "curl", "git", "useradd"):
        if shutil.which(name) is None:
            raise PreflightError(f"Lipsește {name}; instalați dependența înainte de activare.")
    version = int(run(["systemctl", "--version"]).split()[1])
    if version < 245:
        raise PreflightError("Este necesar systemd 245+ pentru limitele serviciului.")
    libc, release = platform.libc_ver()
    if libc != "glibc" or tuple(map(int, release.split(".")[:2])) < (2, 28):
        raise PreflightError("Wheels-urile Python fixate necesită glibc 2.28+.")
    if platform.machine() not in {"x86_64", "aarch64"}:
        raise PreflightError("Arhitectură nevalidată; este necesară verificarea manuală a dependențelor.")
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        memory[key] = int(value.split()[0]) * 1024
    if (os.cpu_count() or 0) < 2 or memory["MemTotal"] < 6 * 1024**3 or memory["MemAvailable"] < 3 * 1024**3:
        raise PreflightError("Pragul de instalare este 2 CPU, 6 GiB RAM total și 3 GiB RAM disponibili; VPS-ul nu îl îndeplinește acum.")
    # /opt, /var/lib and /etc may live on different mounts.
    for path, needed in (("/opt", 2 * 1024**3), ("/var/lib", 9 * 1024**3), ("/etc", 10 * 1024**2)):
        if shutil.disk_usage(path).free < needed:
            raise PreflightError(f"Spațiu insuficient pe volumul {path}; nu se șterg date existente.")
    if shutil.disk_usage("/var/lib").free < 10 * 1024**3:
        raise PreflightError("Sunt necesari 10 GiB liberi pe volumul /var/lib pentru instalare și rezervă.")
    filters = run(["ffmpeg", "-hide_banner", "-filters"])
    encoders = run(["ffmpeg", "-hide_banner", "-encoders"])
    if not re.search(r"\bass\b", filters) or not re.search(r"\blibx264\b", encoders) or not re.search(r"\baac\b", encoders):
        raise PreflightError("FFmpeg necesită libass, libx264 și encoderul AAC.")
    ffmpeg_version = run(["ffmpeg", "-version"]).splitlines()[0]
    version_match = re.search(r"ffmpeg version (\d+)\.", ffmpeg_version)
    if not version_match or int(version_match[1]) < 6:
        raise PreflightError("Este necesar FFmpeg 6+; versiunea disponibilă nu a fost acceptată.")
    dump = run(["nginx", "-T"])
    selected = inspect_dump(dump)
    path = Path(selected["vhost"]).resolve(strict=True)
    if not path.is_relative_to(Path("/etc/nginx")) or not path.is_file():
        raise PreflightError("Vhost-ul activ nu este un fișier din /etc/nginx; verificare manuală necesară.")
    text = path.read_text()
    patch_vhost(text, "djcioko.ro")
    group = grp.getgrnam(selected["nginx_group"])
    user = pwd.getpwnam(selected["nginx_user"])
    if user.pw_uid == 0 or group.gr_gid == 0:
        raise PreflightError("Nginx trebuie să aibă worker fără drepturi root.")
    # Check indirect includes for an already-owned route; our managed snippet is allowed.
    from nginx_config import split_dump, parse, walk, INCLUDE
    for source, content in split_dump(dump).items():
        if Path(source).resolve() in {path, Path(INCLUDE)}:
            continue
        for node in walk(parse(content)):
            if node["args"][0] == "location" and any("ri-subtitles" in arg for arg in node["args"][1:]):
                raise PreflightError("O altă configurație activă conține ruta ri-subtitles; verificare manuală necesară.")
    return {**selected, "vhost": str(path), "python": sys.executable, "ffmpeg": ffmpeg_version,
            "cpu": os.cpu_count(), "ramGiB": round(memory["MemTotal"] / 1024**3, 2),
            "availableRamGiB": round(memory["MemAvailable"] / 1024**3, 2),
            "freeDataGiB": round(shutil.disk_usage("/var/lib").free / 1024**3, 2)}


if __name__ == "__main__":
    try:
        print(json.dumps({"readyForInstall": True, **inspect()}, indent=2))
    except (PreflightError, ConfigurationError, OSError, KeyError, ValueError, subprocess.TimeoutExpired) as error:
        sys.exit(f"Verificare oprită: {error}")
