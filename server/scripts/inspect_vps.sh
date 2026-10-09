#!/usr/bin/env bash
set -euo pipefail
ri_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ri_python_bin=${RI_PYTHON_BIN:-python3}
exec "$ri_python_bin" "$ri_script_dir/../deploy/preflight.py"
