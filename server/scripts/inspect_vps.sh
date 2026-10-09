#!/usr/bin/env bash
set -euo pipefail
ri_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$ri_script_dir/python_runtime.sh"
ri_python_bin=$(ri_resolve_python)
exec "$ri_python_bin" "$ri_script_dir/../deploy/preflight.py"
