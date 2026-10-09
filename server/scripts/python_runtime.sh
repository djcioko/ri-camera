#!/usr/bin/env bash
# Shared, read-only interpreter discovery. Source this file from a Bash script.

ri_check_python() {
  "$1" -I -c '
import os, sys
from pathlib import Path
if sys.version_info < (3, 12) or sys.implementation.name != "cpython":
    raise SystemExit(1)
import ensurepip, sqlite3, ssl, venv, sysconfig, _ssl, _sqlite3
paths = (os.path.realpath(sys.executable), os.path.realpath(sys.base_prefix))
protected = ("/root", "/home", "/run/user")
if any(path == base or path.startswith(base + "/") for path in paths for base in protected):
    raise SystemExit(1)

def require_public_path(name, mode):
    path = Path(name).resolve()
    try:
        if path.stat().st_mode & mode != mode:
            raise SystemExit(1)
        if any(parent.stat().st_mode & 0o001 == 0 for parent in path.parents):
            raise SystemExit(1)
    except OSError:
        raise SystemExit(1)

# Root importing successfully does not prove the dedicated user can start it.
require_public_path(paths[0], 0o005)
require_public_path(paths[1], 0o001)
require_public_path(sysconfig.get_path("stdlib"), 0o001)
for module in (ensurepip, sqlite3, ssl, venv, _ssl, _sqlite3):
    if getattr(module, "__file__", None):
        require_public_path(module.__file__, 0o004)
print(paths[0])
' 2>/dev/null
}

ri_resolve_python() {
  local ri_candidate ri_path
  if [[ -n ${RI_PYTHON_BIN:-} ]]; then
    if ri_check_python "$RI_PYTHON_BIN"; then return 0; fi
    printf '%s\n' 'RI_PYTHON_BIN nu indică un CPython 3.12+ cu venv/ensurepip accesibil serviciului. Verificați calea explicită.' >&2
    return 1
  fi
  for ri_candidate in "${RI_RUNTIME_ROOT:-/opt/ri-subtitles/runtime}/bin/python3.12" python3.12 python3.13 python3.14 python3; do
    if ri_path=$(command -v -- "$ri_candidate" 2>/dev/null) && ri_check_python "$ri_path"; then
      return 0
    fi
  done
  printf '%s\n' 'Nu am găsit CPython 3.12+ cu venv/ensurepip accesibil serviciului. Rulați: sudo bash server/scripts/setup_python.sh' >&2
  return 1
}
