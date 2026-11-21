"""Optional Pi RMS probe. Server control is checked before every 0.5s capture.
Use the browser room display for the existing warning/red timers and incident workflow.
This probe prints RMS levels; it is not a second incident engine.
"""
import json
import os
import time
import urllib.request


def monitoring_config():
    url = os.environ.get("QUIETSPACE_URL", "http://localhost:3000").rstrip("/")
    request = urllib.request.Request(url + "/api/device/config", headers={
        "Authorization": "Bearer " + os.environ.get("QUIETSPACE_DEVICE_KEY", "")
    })
    with urllib.request.urlopen(request, timeout=2) as response:
        config = json.load(response)
    room_id = int(os.environ.get("QUIETSPACE_ROOM_ID", "1"))
    return config if config["room_id"] == room_id and config["monitoring_enabled"] else None


def main():
    import sounddevice as sd
    import numpy as np
    print("Controlled RMS probe. Press Ctrl+C to stop.")
    try:
        while True:
            try:
                enabled = monitoring_config()
            except Exception:
                enabled = None  # No server authorization means no capture.
            if not enabled:
                sd.stop()
                print("Monitoring Disabled (or control server unavailable)")
                time.sleep(2)
                continue
            recording = sd.rec(int(0.5 * 44100), samplerate=44100, channels=1)
            sd.wait()  # Capture is bounded to 0.5s; no background stream remains open.
            rms = np.sqrt(np.mean(np.square(recording)))
            print(f"Relative RMS level: {round(float(rms) * 500)}")
            time.sleep(0.1)
    finally:
        sd.stop()


if __name__ == "__main__":
    main()
