#!/usr/bin/env bash
# Explicit preparation of a persistent, app-owned Python; never changes system Python.
set -euo pipefail
umask 022
ri_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source "$ri_script_dir/python_runtime.sh"

ri_fail() { printf 'Pregătire Python oprită: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || ri_fail 'Rulați cu sudo bash server/scripts/setup_python.sh.'

if ri_python_bin=$(ri_resolve_python 2>/dev/null); then
  printf 'Python compatibil deja disponibil: %s\n' "$ri_python_bin"
  "$ri_python_bin" --version
  exit 0
fi
# An explicit operator choice must not be silently replaced.
if [[ -n ${RI_PYTHON_BIN:-} ]]; then ri_resolve_python; exit 1; fi

for ri_tool in curl tar sha256sum uname getconf readlink stat install dirname df awk mktemp chmod mv ln rm flock; do
  command -v "$ri_tool" >/dev/null || ri_fail "Lipsește comanda $ri_tool. Pregătirea nu instalează pachete ale sistemului."
done
[[ $(uname -s) == Linux ]] || ri_fail 'Runtime-ul separat este disponibil pentru Linux.'
ri_glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || ri_fail 'Este necesar glibc 2.28+.'
[[ $ri_glibc =~ ^glibc\ ([0-9]+)\.([0-9]+)$ ]] || ri_fail 'Este necesar glibc 2.28+.'
(( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 28) )) || ri_fail 'Este necesar glibc 2.28+.'

# Pinned upstream artifacts, independently checked against uv 0.12.24 metadata:
# https://github.com/astral-sh/uv/blob/0.12.24/crates/uv-python-managed/download-metadata.json
ri_arch=$(uname -m)
case "$ri_arch" in
  x86_64) ri_sha256=731af898886c5f821890dc901eca3c651cca8e51fa7308c159d12a1194aeac91 ;;
  aarch64) ri_sha256=6541297dd1798dec8b98c3ad7492808a5b9d1c126801ceb2011e7754cd20d1ce ;;
  *) ri_fail "Arhitectură neacceptată pentru runtime: $ri_arch." ;;
esac
ri_url="https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-${ri_arch}-unknown-linux-gnu-install_only_stripped.tar.gz"
ri_runtime_root=${RI_RUNTIME_ROOT:-/opt/ri-subtitles/runtime}
[[ $ri_runtime_root =~ ^/[A-Za-z0-9._/-]+$ && $ri_runtime_root != / ]] || ri_fail 'Directorul runtime trebuie să fie o cale absolută simplă.'
[[ $(readlink -m -- "$ri_runtime_root") == "$ri_runtime_root" ]] || ri_fail 'Calea runtime nu poate conține symlinkuri sau componente relative.'
case "$ri_runtime_root/" in
  /root/*|/home/*|/run/user/*) ri_fail 'Directorul ales este ascuns serviciului de ProtectHome.' ;;
esac

# Create only missing directories. Existing parents must already be safe and
# traversable by the dedicated service user; their permissions are not changed.
ri_prepare_directory() {
  local ri_dir=$1 ri_owner ri_mode
  [[ ! -L $ri_dir ]] || ri_fail "Directorul nu poate fi symlink: $ri_dir"
  if [[ ! -e $ri_dir ]]; then
    ri_prepare_directory "$(dirname -- "$ri_dir")"
    install -d -m 0755 -- "$ri_dir"
  fi
  [[ -d $ri_dir ]] || ri_fail "Calea există și nu este director: $ri_dir"
  read -r ri_owner ri_mode < <(stat -c '%u %a' -- "$ri_dir")
  [[ $ri_owner == 0 ]] && (( (8#$ri_mode & 0022) == 0 && (8#$ri_mode & 0001) != 0 )) || ri_fail "Directorul trebuie deținut de root, accesibil serviciului și fără scriere publică: $ri_dir"
}
# Check every existing ancestor, including when the runtime directory exists.
ri_parent=$ri_runtime_root
while :; do
  ri_prepare_directory "$ri_parent"
  [[ $ri_parent == / ]] && break
  ri_parent=$(dirname -- "$ri_parent")
done
ri_prepare_directory "$ri_runtime_root/bin"
ri_prepare_directory "$ri_runtime_root/python"
[[ ! -L $ri_runtime_root/.setup.lock ]] || ri_fail 'Fișierul de blocare nu poate fi symlink.'
exec 9> "$ri_runtime_root/.setup.lock"
flock -n 9 || ri_fail 'O altă pregătire Python rulează deja. Așteptați finalizarea ei.'

ri_version_root="$ri_runtime_root/python/cpython-3.12.15-20261003-$ri_arch"
ri_binary="$ri_version_root/bin/python3.12"
ri_link="$ri_runtime_root/bin/python3.12"
if [[ -e $ri_link || -L $ri_link ]]; then
  [[ -L $ri_link && $(readlink -- "$ri_link") == "$ri_binary" ]] || ri_fail "Nu înlocuiesc un executabil existent: $ri_link"
fi
ri_stage=$(mktemp -d "$ri_runtime_root/.python-setup.XXXXXX")
trap 'rm -rf -- "$ri_stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Only public upstream artifacts are staged here. Traversal is needed for the
# same access checks that apply to the final service runtime.
chmod 0755 "$ri_stage"

if [[ -e $ri_version_root || -L $ri_version_root ]]; then
  [[ ! -L $ri_version_root && -f $ri_version_root/.ri-runtime-sha256 ]] || ri_fail "Există un runtime nerecunoscut la $ri_version_root; nu îl suprascriu."
  [[ $(< "$ri_version_root/.ri-runtime-sha256") == "$ri_sha256" ]] || ri_fail 'Marcajul runtime-ului existent nu corespunde versiunii fixate.'
else
  ri_free_kib=$(df -Pk "$ri_runtime_root" | awk 'NR == 2 {print $4}')
  [[ $ri_free_kib =~ ^[0-9]+$ ]] && (( ri_free_kib >= 1048576 )) || ri_fail 'Este necesar minimum 1 GiB liber pentru pregătirea runtime-ului.'
  printf 'Descarc Python 3.12.15 separat pentru subtitrări (%s). Verific SHA-256 înainte de extragere.\n' "$ri_arch"
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 20 --max-time 300 --retry 2 --max-filesize 104857600 \
    --output "$ri_stage/python.tar.gz" "$ri_url"
  printf '%s  %s\n' "$ri_sha256" "$ri_stage/python.tar.gz" | sha256sum --check --status || ri_fail 'SHA-256 nu corespunde. Arhiva nu a fost extrasă.'
  tar -xzf "$ri_stage/python.tar.gz" -C "$ri_stage" --no-same-owner --no-same-permissions
  ri_check_python "$ri_stage/python/bin/python3.12" >/dev/null || ri_fail 'Python-ul descărcat nu poate încărca ssl, sqlite3, venv și ensurepip pe acest server.'
  printf '%s\n' "$ri_sha256" > "$ri_stage/python/.ri-runtime-sha256"
  mv -T -- "$ri_stage/python" "$ri_version_root"
fi

# Validate at the final persistent location: release venvs keep this base path.
ri_check_python "$ri_binary" >/dev/null || ri_fail 'Runtime-ul persistent nu trece verificarea importurilor.'
"$ri_binary" -I -m venv "$ri_stage/probe-venv"
"$ri_stage/probe-venv/bin/python" -I -m pip --version
ln -s -- "$ri_binary" "$ri_stage/python3.12"
mv -T -- "$ri_stage/python3.12" "$ri_link"
printf 'Runtime Python pregătit: %s\n' "$ri_binary"
printf '%s\n' 'Python-ul sistemului și configurațiile serviciilor nu au fost modificate.'
