#!/usr/bin/env bash
# Run as the Pi desktop user via SSH, not as root. Installs only kiosk assets/policy.
set -euo pipefail
if [[ $EUID == 0 ]]; then echo 'Run as the desktop user; sudo is used only for Chromium policy installation.' >&2; exit 1; fi
kiosk_url="${1:-}"
[[ -n "$kiosk_url" ]] || { echo 'Usage: ./install.sh https://YOUR_PERMANENT_HOST/webpages/index.html?room_id=ACTUAL_ID' >&2; exit 1; }
kiosk_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
kiosk_browser="${QUIETSPACE_CHROMIUM:-}"
if [[ -z "$kiosk_browser" ]]; then
  if command -v chromium >/dev/null; then kiosk_browser=chromium; elif command -v chromium-browser >/dev/null; then kiosk_browser=chromium-browser; else echo 'Install Chromium before setup.' >&2; exit 1; fi
fi
for kiosk_dependency in python3 curl flock; do command -v "$kiosk_dependency" >/dev/null; done
kiosk_root="${XDG_CONFIG_HOME:-$HOME/.config}/quietspace-kiosk"
mkdir -p "$kiosk_root"
chmod 700 "$kiosk_root"
kiosk_temporary="$(mktemp -d)"
trap 'rm -rf -- "$kiosk_temporary"' EXIT
python3 "$kiosk_source/configure.py" --url "$kiosk_url" --browser "$kiosk_browser" --output "$kiosk_temporary/kiosk.json" --policy "$kiosk_temporary/microphone.json"
install -m 600 "$kiosk_temporary/kiosk.json" "$kiosk_root/kiosk.json"
install -m 700 "$kiosk_source/launch.sh" "$kiosk_root/launch.sh"
install -m 600 "$kiosk_source/health.py" "$kiosk_root/health.py"
kiosk_policy_dir="${QUIETSPACE_POLICY_DIR:-/etc/chromium/policies/managed}"
if [[ "$kiosk_browser" == chromium-browser && -z "${QUIETSPACE_POLICY_DIR:-}" ]]; then kiosk_policy_dir=/etc/chromium-browser/policies/managed; fi
sudo install -d -m 755 "$kiosk_policy_dir"
sudo install -m 644 "$kiosk_temporary/microphone.json" "$kiosk_policy_dir/quietspace-microphone.json"
# XDG desktop autostart is supported by LXDE. labwc may need its explicit hook below.
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
python3 - "$kiosk_root/launch.sh" "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/quietspace-kiosk.desktop" <<'PY'
import pathlib,sys
launcher=sys.argv[1].replace('\\','\\\\').replace('"','\\"')
pathlib.Path(sys.argv[2]).write_text('[Desktop Entry]\nType=Application\nName=QuietSpace Kiosk\nExec="'+launcher+'"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n')
PY
if command -v labwc >/dev/null; then
  mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/labwc"
  kiosk_labwc="${XDG_CONFIG_HOME:-$HOME/.config}/labwc/autostart"
  touch "$kiosk_labwc"
  if ! grep -q 'quietspace-kiosk/launch.sh' "$kiosk_labwc"; then
    printf '\n"%s/launch.sh" & # QuietSpace kiosk\n' "$kiosk_root" >> "$kiosk_labwc"
  fi
fi
printf 'Kiosk installed for %s.\nPolicy: %s/quietspace-microphone.json\n' "$USER" "$kiosk_policy_dir"
echo 'Enable Desktop Autologin with sudo raspi-config, verify chrome://policy, then reboot.'
echo 'The first device enrollment still requires its private key; the script never stores that key.'
