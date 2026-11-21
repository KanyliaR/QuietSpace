# QuietSpace Microphone Calibration Utility

A standalone local web application following the supplied navy calibration mockup: top microphone controls; live graph and statistics/session table on the left; recording, editing, suggestions and adjustment tools on the right; workflow strip below. The responsive layout stacks on smaller screens. It has no internal account system, database dependency, production event reporting or automatic settings application. The main QuietSpace app can now serve these existing web assets at the admin-protected `/calibration/` route; this wrapper does not change the standalone capture or analysis program.

## Opening from Library Admin Settings

Use **Microphone Calibration → Open Microphone Calibration** in Settings. The same-origin `/calibration/` link works on local and deployed QuietSpace hosts, using the existing Library Admin login. Only the utility HTML and its web assets are served; Python service files, recordings and approved configurations are not exposed. Laptop Mode uses the browser microphone on localhost or HTTPS.

For actual Raspberry Pi calibration, continue using the authenticated local Pi service/SSH workflow below. The Azure web process cannot capture a remote Pi microphone, and this app route does not proxy or publish the private Pi service. Approved Pi saving/export remains with that service. No production thresholds are applied automatically.


## Launch Laptop Mode

From the repository root:

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory calibration
```

Open **http://localhost:8766** in a current Chrome, Safari or Firefox browser, select **Laptop Mode — Testing Only**, choose the condition/duration and click **Start Recording**. Grant microphone permission. The interface remains offline-capable: all scripts, fonts and charts are local, with no CDN or framework.

Laptop Mode keeps numerical samples and results in JavaScript memory only. It never calls a service API, writes localStorage/IndexedDB/database/files, exports configuration, or records raw audio. Stop, Retry, condition Reset and Reset All operate on temporary measurements. Changing modes and leaving clear the measurements. Approval and export handlers also reject Laptop Mode even if invoked programmatically; disabled controls are not the only guard. Browser microphone permission/device preferences are managed by the browser, not calibration storage.

## Launch actual Raspberry Pi calibration

Use Python 3.9+ on Raspberry Pi OS with an actual USB input microphone. Capture starts only on explicit user action. The service verifies that its host identifies as a Raspberry Pi before opening the input, so running it on a laptop is not actual Pi calibration.

```sh
sudo apt-get install python3-venv libportaudio2
python3 -m venv calibration/.venv
calibration/.venv/bin/pip install -r calibration/requirements-pi.txt
calibration/.venv/bin/python calibration/audio/raspberry-pi.py
```

Open **http://localhost:8765** on the Pi. Choose **Raspberry Pi Mode — Actual Calibration**, paste the access token printed in the Pi terminal and click **Connect to Pi**. Choose the USB microphone from the inputs reported by the Pi, then start a test. No laptop microphone is opened in Pi Mode. Selecting that mode alone does not establish a connection. Missing PortAudio/dependencies, missing input, invalid credentials and an unavailable service produce errors.

The service requires `numpy` and `sounddevice` only for physical audio capture. `--port` and `--config-dir` optionally change its port/configuration directory. It generates a fresh strong token each launch, or reads `QUIETSPACE_CALIBRATION_TOKEN` (at least 24 characters). The token stays in browser memory and is cleared on mode change/leaving; do not put it in a URL or share it publicly.

### Access from a laptop securely

Keep the service bound to **127.0.0.1**, its enforced default. Forward the same port over SSH:

```sh
ssh -N -L 8765:127.0.0.1:8765 your-user@your-pi
```

Then open **http://localhost:8765** on the laptop and connect with the Pi terminal token. The SSH connection authenticates network access and encrypts traffic; the separate token authenticates calibration API access. The HTTP service is never exposed on a public/LAN interface. Host and Origin checks permit only the service's localhost port; no CORS bypass is provided. Do not forward it through a public tunnel or reverse proxy. The HTML/assets contain no private recordings; every measurement, command and saved-config API requires the token.

## Measurement definition and comparison with existing code

Existing production code was inspected in `webpages/index.html`, `sound.py`, `lib/access.js`, and the existing Settings defaults. **None were modified.**

Browser calibration uses the same explicit arithmetic:

1. `getUserMedia`, AudioContext/analyser, 2,048 byte time-domain samples.
2. Each byte becomes `(byte - 128) / 128`.
3. `RMS = sqrt(sum(sample²) / N)`.
4. `instantaneous level = floor(RMS * 500 + 0.5)` (equivalent to JavaScript `Math.round` for these nonnegative readings).
5. Timestamp each level, retain observations at most 3,000ms old, and compute `floor(mean(levels) + 0.5)`.
6. Emit one processed observation approximately every 1,000ms, containing both the latest instantaneous level and smoothed level.

There is **no division by five, division by 100, decibel conversion or extra normalization**. The UI displays values such as 8, 15 and 22. The scale is relative QuietSpace noise level, not dB. The graph axis automatically fits observed levels and selected thresholds; its meter is a visualization of the mathematical 0–500 range, not an additional transformation of stored/displayed readings.

Pi calibration captures float32 mono blocks of 2,048 samples at the selected input's reported default rate. It explicitly quantizes each bounded float sample using `clip(floor(sample * 128 + 128), 0, 255)`, then applies the **same byte-based RMS ×500 and rounded sliding-mean definitions**. This makes the calibration scale explicitly comparable to the browser's byte path instead of silently using a different float-only RMS implementation. Audio buffers exist only while computing readings and are discarded; no raw recording is retained.

**Differences that remain:** browser polling follows animation frames; Python reads hardware blocks, so the number of observations contributing to a window differs. Browser capture requests `audio: true`, as production does, leaving hardware/browser gain, echo cancellation, noise suppression and resampling to the platform. Pi PortAudio capture does not reproduce those browser processing choices. Actual browser byte conversion may differ slightly from explicit Pi quantization. These modes therefore share a mathematical scale/definition but are **not guaranteed to produce identical measurements from the same sound**. Use the actual deployment USB microphone, device gain, placement and capture implementation for real calibration; repeat after hardware/gain changes.

Existing `sound.py` is a separate optional probe: it captures 0.5 seconds at 44,100Hz, calculates unquantized float `sqrt(mean(recording²)) * 500`, uses Python `round`, prints the value and has no sliding window or upload. Production browser thresholds default to 10/17, with a 14-second yellow hold and two-minute red countdown. Calibration does not import/change those timers or trigger incidents.

## Workflow and statistics

Record quiet baseline, moderate conversation and excessive noise as separate labeled 30–60 second tests. The app never starts capture on load. Stop may finish a test early; Retry replaces that condition's samples. Reset Test removes that condition; Reset All clears transient samples and suggestions while retaining previously approved Pi configuration history.

Only full three-second windows contribute to recommendations. A processing gap over 500ms or non-increasing time resets the calibration window and warm-up, excluding incomplete windows after interruption. This conservative calibration-only guard is not a production change. A hardware disconnect/input overflow marks the recording interrupted; interrupted recordings cannot train the recommendation. The Pi watchdog stops capture after eight seconds without controller requests. Browser leaving sends a best-effort reset and releases its own microphone; watchdog shutdown remains the fallback if the connection disappears.

The graph shows the last 30 seconds of emitted instantaneous/smoothed readings, breaks across missing observations, and overlays editable yellow/red boundaries. Live classification uses current thresholds (`value < yellow`: green; otherwise `value < red`: yellow; otherwise red). It is explicitly independent of incident timers. Live-test recordings are excluded from calibration by default; stop releases the input. There is no optional timer simulation or pause button: pausing/restarting should create a new window/test, not imply continuous capture.

Each session displays ready-reading mean, minimum, maximum, median, interpolated 5th/95th percentiles, population standard deviation, count and actual elapsed duration. Full statistics are expandable below the table. Session edit controls can change labels, split at an elapsed second, or exclude/include an observation segment. Splits preserve real observations and their original readiness flags; a later segment's first smoothed reading may include acoustic context from immediately before its split boundary. Splitting does not fabricate samples or restart a physical recording.

## Threshold recommendation and manual review

At least 10 valid full-window smoothed readings per condition are required (normally record 30–60 seconds). All included **completed** sessions are grouped by their quiet/moderate/loud label. No sample is generated to fill gaps or missing categories.

The pure JavaScript algorithm exhaustively evaluates integer `0 <= yellow < red <= 500` pairs. Score is **balanced accuracy**: the arithmetic mean of the three per-condition correct-classification fractions. Each category has one-third weight regardless of its reading count. Ties favor thresholds closest to the midpoint of adjacent category medians, then lower yellow/red values. The UI reports per-category correct, incorrect and total counts plus accuracy for the current manual thresholds.

Warnings flag overlapping quiet/moderate and moderate/loud central distributions (95th percentile of the lower category meets/exceeds the 5th of the next), non-increasing category medians and balanced accuracy below 80%. Repeat ambiguous recordings rather than treating the result as guaranteed. These are **training-set measurements**, not independent validation or an acoustic standard. Confirm with representative additional tests and real-world conditions.

Numeric inputs and sliders are synchronized. Invalid, fractional, negative or reversed thresholds are rejected. Changing thresholds updates accuracy, target classification and graph boundaries, and invalidates any current approval. Restore Suggested restores the generated pair. **Test Adjusted Thresholds** opens a separate excluded live test; it does not activate QuietSpace state timers.

## Save, export and restore

Only the actual Pi service can persist results. It has no API accepting uploaded measurement arrays. Approval uses its own captured numerical sessions, rechecks the current recording revision, strict threshold ordering and sufficient included data, computes balanced scores again, and requires acknowledgement for ambiguous data. Click **Approve & Save Thresholds** and confirm the exact values. This explicit confirmation also acknowledges the displayed overlap/accuracy limitations.

Approved JSON files are atomically saved under `calibration/config/` by default, with private directory/file permissions, unique version IDs, no raw audio, no credentials and no database writes. They contain:

- `schemaVersion: 1`, `measurementScale: "quietspace-rms-x500"`
- approved integer `yellowThreshold`, `redThreshold`
- `smoothingWindowSeconds: 3`, `evaluationIntervalSeconds: 1`
- `source: "raspberry-pi-calibration"`
- UTC `calibratedAt`, microphone identities, implementation/configuration versions
- `scope: "shared-all-three-pis"`, measured classification summary and optional `restoredFrom`.

**Export Approved JSON** retrieves the approved server version and downloads it. It cannot export temporary Laptop results or an unsaved manual preview. Previous approved versions remain available; **Restore Selected Version** asks for confirmation and saves a new approved copy linked to the earlier version. It never deletes history. Measurement edits/capture invalidate the current export approval; historical approved files remain separately accessible to authorized Pi operators.

Saving/exporting/restoring **does not apply** anything to QuietSpace. A future, separately authorized integration can validate the schema, scale, source, hardware and threshold compatibility before applying the same values to all three Pis. Existing production Settings currently limits red thresholds to 200; exports above that limit need review/adaptation before integration, not silent acceptance or changes to production validation. No automatic per-room thresholds are generated.

## Tests

From the repository root:

```sh
node --test calibration/tests/*.test.js
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s calibration/tests -p 'test_*.py'
```

For real Chrome UI checks (Google Chrome installed at the existing project's default macOS path, or set `CHROME_PATH`), start the standalone service above or a static calibration server, then:

```sh
node calibration/tests/browser.js http://127.0.0.1:8765
```

Tests use synthetic labeled numerical data exclusively in test fixtures and temporary configuration directories. They verify RMS/scaling, warm-up/gaps, statistics, balanced scoring and overlap, invalid/manual thresholds, capture cleanup and errors, authenticated HTTP controls, Laptop write rejection, server approval/export/version restore, mode clearing, frontend workflow and responsive screenshots at 1440/768/390px. Browser test artifacts are ignored in `calibration/tests/artifacts/`.

**Physical Pi/USB capture has not been validated here.** Check input selection, unplug/overflow handling, host audio dependencies, sustained timestamps, USB microphone gain, reconnect behavior, representative sessions, actual saved/exported results and SSH access on the real Pi. Do not use synthetic fixture configurations for deployment.

## Files and existing application protection

Everything for this feature is inside `calibration/`: HTML/CSS/controller, pure analysis module, browser adapter, Pi Python launcher/service, dependency list, ignored configuration directory, tests and this README. No existing QuietSpace file, database schema, authentication flow, navigation, device kill switch, thresholds, timer, dashboard or backend API was intentionally changed. This utility is not deployed to Azure.

Validation completed locally: **9 calibration math/audio checks, 4 Python/service checks, the Chrome workflow/responsive suite, and all 20 existing QuietSpace unit checks passed.** Chrome measurement fixtures are explicitly synthetic; microphone cleanup/failure tests use controlled adapter stubs. These results do not certify physical Pi audio behavior. Screenshots are in the ignored calibration test-artifacts directory. No production records, settings or configurations were created.

Created-file manifest (all paths relative to this directory):

- `index.html`, `calibration.css`, `calibration.js`, `analysis.js`
- `audio/laptop.js`, `audio/pi_service.py`, `audio/raspberry-pi.py`
- `requirements-pi.txt`, `.gitignore`, `config/.gitkeep`, `README.md`
- `tests/analysis.test.js`, `tests/laptop.test.js`, `tests/test_service.py`, `tests/browser.js`
