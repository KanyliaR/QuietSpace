# QuietSpace Raspberry Pi kiosk

This small package runs Chromium against the existing Azure-hosted room display. It installs **no Node.js backend or MySQL database** on the Pi. Device keys are entered once in the display and exchanged for a persistent HttpOnly server session; no key is embedded in startup files, URLs, policies or logs.

Supported setup: Raspberry Pi OS **Desktop**, Chromium/Chromium Browser, Python 3, curl and flock (util-linux). The installer creates XDG desktop autostart for LXDE and appends an idempotent labwc autostart hook when labwc is installed. It does not replace an existing desktop configuration. Both hooks may run; a user-owned lock prevents overlapping launcher instances. Desktop Autologin must be enabled. Raspberry Pi OS Lite without a graphical desktop is not configured by this package.

## One-time SSH setup

From the machine holding this repository, substitute your existing SSH account/host:

```sh
export PI_SSH='YOUR_DESKTOP_USER@YOUR_PI_HOST'
ssh "$PI_SSH" 'cat /etc/os-release; command -v chromium || command -v chromium-browser; command -v labwc || true'
scp -r scripts/pi-kiosk "$PI_SSH:~/quietspace-pi-kiosk"
ssh "$PI_SSH" 'sudo apt-get update && sudo apt-get install -y chromium curl python3 util-linux'
```

If your distribution supplies `chromium-browser` instead, install that supported package. Run setup **as the actual desktop user**, not root; sudo is used only to install Chromium policy. No SD-card removal is involved.

Set the permanent HTTPS origin and existing room display route. Replace the placeholder host below with your actual Azure deployment hostname; this repository does not establish that hostname. Do not use a temporary Quick Tunnel URL. These examples use the verified internal IDs in the current pilot database:

```sh
# On the Pi assigned to Room 232 (internal ID 1):
ssh -t "$PI_SSH" 'bash ~/quietspace-pi-kiosk/install.sh "https://YOUR_PERMANENT_QUIETSPACE_HOST/webpages/index.html?room_id=1"'

# On the separate Pi assigned to Room 234 (internal ID 3), use that Pi's SSH target:
ssh -t "$PI_SSH" 'bash ~/quietspace-pi-kiosk/install.sh "https://YOUR_PERMANENT_QUIETSPACE_HOST/webpages/index.html?room_id=3"'
```

Run **one** matching command per physical Pi, not both against the same browser profile. No kiosk or device is required for Room 233. The installer validates HTTPS, the existing `/` or `/webpages/index.html` route, and one positive `room_id`. It rejects embedded credentials, wildcard origins and key-bearing query parameters. It does not register a device.

Enable graphical Desktop Autologin through SSH:

```sh
ssh -t "$PI_SSH" 'sudo raspi-config'
```

Choose **System Options → Boot / Auto Login → Desktop Autologin** (menu wording can vary by Raspberry Pi OS version). The script intentionally does not change desktop login behavior without this operator step. Verify the correct desktop user and graphical session before rebooting.

## Register only the intended devices

Run these on the **application/backend host** with its existing database environment, not on the Pi:

```sh
npm run migrate
npm run device:register -- 1 "Room 232 Raspberry Pi"
npm run device:register -- 3 "Room 234 Raspberry Pi"
```

The mappings verified locally are `1 → Room 232`, `2 → Room 233`, `3 → Room 234`. Confirm the Azure database's actual IDs with `SELECT id,room_name FROM rooms ORDER BY id;` before registering there. The migration preserves whatever IDs an existing deployment uses. Never substitute public room number 232 for internal ID 1. Do not register internal ID 2 for the initial two-device demonstration.

Registration continues to generate a random key once and store only its hash. Transfer each private key securely to the operator of the matching device; do not paste it into SSH command arguments, URLs, kiosk JSON or a publicly readable file. In the Pi kiosk click **Connect Room Microphone**, enter the matching key, and allow the microphone if needed. The page authenticates room assignment, initializes capture, sends a real reading and receives a health acknowledgement before hiding setup/preview controls.

## Permissions and startup verification

The installer writes `quietspace-microphone.json` under `/etc/chromium/policies/managed` (or `/etc/chromium-browser/policies/managed` for that binary). It blocks microphone grants for unrelated origins and allows microphone capture and media autoplay only for the exact configured HTTPS QuietSpace origin. It does not pass global fake-UI/media permission flags. Policies are machine-wide on this dedicated kiosk; avoid installing them on a general-purpose workstation.

On the Pi, inspect **chrome://policy**, select Reload policies, and verify `AudioCaptureAllowed`, `AudioCaptureAllowedUrls`, `AutoplayAllowed`, and `AutoplayAllowlist` are recognized without errors. If your Chromium package uses another managed-policy directory, rerun with `QUIETSPACE_POLICY_DIR` pointing to that supported directory; verify effective policies rather than assuming they loaded. Browser build/platform restrictions may still require one operator gesture for AudioContext activation.

The launcher uses a persistent profile under `~/.local/share/quietspace-kiosk/chromium` (mode 700). Its configuration is `~/.config/quietspace-kiosk/kiosk.json` (mode 600). This JSON contains the URL, origin and browser binary, **no credentials**. Do not use incognito/guest mode or erase the profile between boots. The device cookie is HttpOnly, SameSite Strict, Secure in production, and revalidated against enabled device/room records on every API request. It has a rolling 90-day lifetime refreshed by authorized configuration checks. An offline device beyond that lifetime, an erased profile, a changed HTTPS origin, a revoked device or explicit disconnect requires enrollment again. Revoked keys are never automatically retried or stored for reenrollment.

After initial setup:

```sh
ssh "$PI_SSH" 'sudo reboot'
# After the Pi returns:
ssh "$PI_SSH" 'pgrep -af "quietspace-kiosk|chromium"'
```

Check physically/on a remote desktop that Chromium opened fullscreen, the Study Room heading is correct, monitoring resumed, controls disappeared only after capture/backend acknowledgement, and the Library Admin Overview shows that device as active. Multiple Chromium helper processes are normal; there should be one launcher/profile instance. Power-cycle testing, USB microphone behavior and actual policies require physical Pi verification and were **not tested on Pi hardware here**.

The launcher waits for a successful HTTPS response before starting Chromium, retries temporary network/server failures and relaunches after browser exit/crash. Once loaded, the display's existing control checks stop capture during connection loss/admin pauses and resume authorized capture when service returns. A rare Chromium top-level network error page may still require Reload or browser restart; no startup script can guarantee browser capture or recovery under all network/driver conditions.

## Maintenance and troubleshooting

- **Controls remain visible:** monitoring is not yet operational. Check device assignment, cookie, valid HTTPS certificate, microphone selection/permission and backend connectivity. Do not assume capture succeeded because the button was clicked.
- **Microphone blocked or AudioContext suspended:** confirm the exact policy origin, reload Chromium after a policy change, check chrome://policy/site permissions and the USB input in Pi OS audio settings. A user gesture may be required if the installed browser does not apply these policies as expected. Setup remains visible when startup fails.
- **Wrong room:** use the correct internal `room_id`; the server rejects mismatched config queries and mutation bodies. Do not copy profiles between Pis.
- **Paused:** Library Admin per-room and global monitoring controls remain authoritative; policies and persistent login do not bypass them.
- **Operator maintenance:** while signed in as Library Admin, open the same room display with `&maintenance=1`. Server-validated admin identity reveals maintenance controls, including **Disconnect Device**. Normal public operation hides controls. Log out of the staff account afterward. Disconnect removes the persistent device session; reenroll with an authorized device key. Revocation is performed against the existing `room_devices.enabled` field by an authorized backend operator; revocation takes effect even if an old cookie survives.
- **No registered device / Offline / Microphone Error:** these are distinct Overview states. Room 233 stays valid without a device; no fabricated active status is shown from historical readings.
- **Need to change URL/origin:** rerun the installer with the new permanent URL so both config and scoped policy update. A changed origin needs new browser enrollment and possibly microphone permission.
- **Browser crash/duplicate windows:** the launch loop restarts Chromium and flock prevents duplicate launchers. Stop the launcher before manual maintenance; do not remove Chromium Singleton files while a profile is running.
- **Autostart missing:** verify Desktop Autologin, `~/.config/autostart/quietspace-kiosk.desktop`, and on labwc the appended `~/.config/labwc/autostart` line. Inspect `$XDG_SESSION_TYPE`, `loginctl list-sessions`, and whether labwc/LXDE is actually installed. Wayfire-only/custom desktops may need their native startup hook pointed at the same installed launcher; do not replace unrelated startup configuration.

Official references used for the policy and labwc choices:

- [Raspberry Pi kiosk tutorial](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/)
- [Chrome microphone allowlist policy](https://chromeenterprise.google/intl/en_ca/policies/audio-capture-allowed-urls/)
- [Chromium autoplay allowlist definition](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/policy/resources/templates/policy_definitions/Miscellaneous/AutoplayAllowlist.yaml)

## Remove startup without deleting enrollment

Remove only the QuietSpace desktop entry and the marked QuietSpace line from labwc autostart, stop its launcher, and remove the QuietSpace managed-policy file if this machine no longer serves as a kiosk. Keep the Chromium profile only if retaining that device's session is intended. Disconnect/revoke before retiring or transferring a Pi; physical access to the dedicated browser profile must be restricted to authorized operators.
