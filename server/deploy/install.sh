#!/usr/bin/env bash
set -euo pipefail
ri_deploy_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$ri_deploy_dir/../scripts/python_runtime.sh"
ri_python_bin=$(ri_resolve_python)
exec "$ri_python_bin" "$ri_deploy_dir/install.py" --source-root "$ri_deploy_dir/../.." "$@"
