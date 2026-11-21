#!/usr/bin/env bash
set -euo pipefail
kiosk_root="${XDG_CONFIG_HOME:-$HOME/.config}/quietspace-kiosk"
kiosk_config="${QUIETSPACE_KIOSK_CONFIG:-$kiosk_root/kiosk.json}"
[[ -r "$kiosk_config" ]] || { echo 'QuietSpace kiosk config missing. Run install.sh first.' >&2; exit 1; }
mapfile -t kiosk_values < <(python3 - "$kiosk_config" <<'PY'
import json,sys,urllib.parse
c=json.load(open(sys.argv[1]));u=urllib.parse.urlsplit(c['url'])
if u.scheme!='https' or u.username or u.password or not u.hostname:raise SystemExit('Invalid trusted HTTPS kiosk URL')
print(c['url']);print(c['browser'])
PY
)
[[ ${#kiosk_values[@]} == 2 ]] || exit 1
kiosk_url="${kiosk_values[0]}"
kiosk_browser="${kiosk_values[1]}"
command -v "$kiosk_browser" >/dev/null
command -v flock >/dev/null
kiosk_profile="${XDG_DATA_HOME:-$HOME/.local/share}/quietspace-kiosk/chromium"
mkdir -p "$kiosk_profile" "$kiosk_root"
chmod 700 "$kiosk_profile" "$kiosk_root"
exec 9>"$kiosk_root/kiosk.lock"
flock -n 9 || exit 0
kiosk_pid=''
kiosk_observer=''
trap 'if [[ -n "$kiosk_observer" ]]; then kill "$kiosk_observer" 2>/dev/null || true; fi; if [[ -n "$kiosk_pid" ]]; then kill "$kiosk_pid" 2>/dev/null || true; fi; exit 0' TERM INT
while true; do
  until curl --silent --fail --location --max-redirs 3 --proto '=https' --proto-redir '=https' --max-time 12 --output /dev/null "$kiosk_url"; do
    sleep 5
  done
  "$kiosk_browser" --user-data-dir="$kiosk_profile" --remote-debugging-port=0 --disable-background-timer-throttling --kiosk --no-first-run --noerrdialogs --disable-session-crashed-bubble "$kiosk_url" &
  kiosk_pid=$!
  python3 "$kiosk_root/health.py" watch --profile "$kiosk_profile" --url "$kiosk_url" --pid "$kiosk_pid" --output "$kiosk_root/health.json" &
  kiosk_observer=$!
  wait "$kiosk_pid" || true
  kill "$kiosk_observer" 2>/dev/null || true
  wait "$kiosk_observer" 2>/dev/null || true
  kiosk_observer=''
  kiosk_pid=''
  sleep 3
done
