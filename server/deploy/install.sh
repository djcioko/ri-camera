#!/usr/bin/env bash
set -euo pipefail
ri_deploy_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ri_python_bin=${RI_PYTHON_BIN:-python3}
exec "$ri_python_bin" "$ri_deploy_dir/install.py" --source-root "$ri_deploy_dir/../.." "$@"
