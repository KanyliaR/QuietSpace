#!/usr/bin/env python3
"""
QuietSpace Edge Audio Sampling & Hardware Client
=================================================
Runs on the Raspberry Pi edge device (or development workstation) to monitor
study room noise levels. Supports live microphone capture via sounddevice/numpy,
automatic simulation fallback when audio hardware is absent, acoustic envelope
classification (transient spike vs sustained noise), zero-dB fault detection,
and robust HTTP transmission to the QuietSpace Express/MySQL backend with
exponential backoff retry handling and Authorization: Bearer <QUIETSPACE_DEVICE_KEY>
verification.

Usage:
    python sound.py
    python sound.py --room-id 1 --server-url http://localhost:3000
    python sound.py --simulate --scenario dynamic
    python sound.py --device-key <key>
    python sound.py --help
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Dict, Optional, Tuple

# Try importing sounddevice and numpy for physical hardware capture
HAS_HARDWARE_DEPS = False
try:
    import numpy as np
    import sounddevice as sd
    HAS_HARDWARE_DEPS = True
except (ImportError, OSError):
    HAS_HARDWARE_DEPS = False

# Import or define simulator and acoustic classifier components
try:
    from hardware_simulator import AcousticClassifier, NoiseScenario
except ImportError:
    class AcousticClassifier:
        """
        Time & Envelope Analysis (Section 5 Approach A).
        Distinguishes transient impact noise (dropped book, door slam < 0.8s)
        from sustained disturbances (>= 0.8s).
        """

        def __init__(self, yellow_threshold: float = 60.0, red_threshold: float = 75.0):
            self.yellow_threshold = yellow_threshold
            self.red_threshold = red_threshold
            self.spike_start_time: Optional[float] = None
            self.sustained_start_time: Optional[float] = None
            self.last_classification: str = "ambient"

        def process_sample(
            self, raw_level: float, current_time: Optional[float] = None
        ) -> Tuple[float, str, str, str]:
            if current_time is None:
                current_time = time.time()

            # Handle zero-dB fault condition immediately
            if raw_level <= 0.0:
                self.spike_start_time = None
                self.sustained_start_time = None
                self.last_classification = "fault_zero_db"
                return (0.0, "green", "Quiet", "fault_zero_db")

            # Check if raw level breaches red threshold
            if raw_level >= self.red_threshold:
                if self.spike_start_time is None:
                    self.spike_start_time = current_time

                duration = current_time - self.spike_start_time

                if duration < 0.8:
                    # Transient spike (e.g. dropped book, coughing, door slam)
                    # Suppress false red alert; cap status at yellow
                    self.last_classification = "transient_impact_suppressed"
                    status_color = "yellow" if raw_level >= self.yellow_threshold else "green"
                    quiet_score = "Warning" if status_color == "yellow" else "Quiet"
                    return (raw_level, status_color, quiet_score, self.last_classification)
                else:
                    # Sustained loud sound (>= 0.8s)
                    self.last_classification = "sustained_disturbance"
                    return (raw_level, "red", "Too Loud", self.last_classification)

            # Level is below red threshold
            self.spike_start_time = None

            if raw_level >= self.yellow_threshold:
                if self.sustained_start_time is None:
                    self.sustained_start_time = current_time
                self.last_classification = "moderate_activity"
                return (raw_level, "yellow", "Warning", self.last_classification)
            else:
                self.sustained_start_time = None
                self.last_classification = "ambient_quiet"
                return (raw_level, "green", "Quiet", self.last_classification)

    class NoiseScenario:
        def __init__(self, scenario: str = "dynamic", base_seed: Optional[int] = None):
            import random
            self.scenario = scenario
            self.random = random.Random(base_seed)
            self.val = 38.0

        def next_level(self, elapsed_seconds: float) -> float:
            self.val += self.random.gauss(0, 1.5)
            self.val = max(32.0, min(80.0, self.val))
            return round(self.val, 1)


class EdgeSensorClient:
    """
    Manages edge capture, decibel computation, classification, and transmission.
    """

    def __init__(
        self,
        room_id: int = 1,
        server_url: str = "http://localhost:3000",
        interval: float = 1.0,
        simulate: bool = False,
        scenario: str = "dynamic",
        yellow_threshold: float = 60.0,
        red_threshold: float = 75.0,
        transmit: bool = True,
        sample_rate: int = 44100,
        sample_duration: float = 0.5,
        device_key: Optional[str] = None,
    ):
        self.room_id = room_id
        self.server_url = server_url.rstrip("/")
        self.interval = max(0.1, interval)
        self.simulate = simulate
        self.scenario = scenario
        self.yellow_threshold = yellow_threshold
        self.red_threshold = red_threshold
        self.transmit = transmit
        self.sample_rate = sample_rate
        self.sample_duration = sample_duration
        self.device_key = device_key or os.environ.get("QUIETSPACE_DEVICE_KEY", "")

        self.classifier = AcousticClassifier(yellow_threshold, red_threshold)
        self.sim_generator = NoiseScenario(scenario) if simulate or not HAS_HARDWARE_DEPS else None
        self.start_time = time.time()

        # Telemetry & Fault State
        self.consecutive_zero_readings = 0
        self.backoff_delay = 1.0
        self.total_sent = 0
        self.total_failed = 0

        # Physical hardware verification
        self.use_hardware = False
        if not self.simulate and HAS_HARDWARE_DEPS:
            try:
                devices = sd.query_devices()
                default_input = sd.default.device[0]
                if default_input is not None and default_input >= 0:
                    self.use_hardware = True
            except Exception as e:
                print(f"[NOTE] Microphone device query failed ({e}). Falling back to simulation mode.")
                self.use_hardware = False
                if self.sim_generator is None:
                    self.sim_generator = NoiseScenario(self.scenario)

        if not self.use_hardware and self.sim_generator is None:
            self.sim_generator = NoiseScenario(self.scenario)

    def capture_level(self) -> float:
        """
        Captures raw noise level either via physical microphone RMS or simulation.
        """
        if self.use_hardware and HAS_HARDWARE_DEPS:
            try:
                frames = int(self.sample_duration * self.sample_rate)
                recording = sd.rec(frames, samplerate=self.sample_rate, channels=1, blocking=True)
                sd.wait()
                rms = np.sqrt(np.mean(np.square(recording)))
                if np.isnan(rms) or rms <= 0.0:
                    return 0.0
                db_val = 20.0 * math.log10(max(1e-6, float(rms))) + 94.0
                return max(0.0, min(120.0, round(db_val, 1)))
            except Exception as e:
                print(f"[WARN] Audio hardware capture exception: {e}. Returning 0 dB.")
                return 0.0
        elif self.sim_generator:
            elapsed = time.time() - self.start_time
            return float(self.sim_generator.next_level(elapsed))
        return 0.0

    def check_monitoring_config(self) -> Optional[dict]:
        """
        Queries server config endpoint to verify room monitoring state.
        """
        device_key = self.device_key or os.environ.get("QUIETSPACE_DEVICE_KEY", "")
        headers = {}
        if device_key:
            headers["Authorization"] = f"Bearer {device_key}"
        url = f"{self.server_url}/api/device/config"
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                data = json.load(resp)
                return data if data.get("room_id") == self.room_id and data.get("monitoring_enabled") else None
        except Exception:
            return None

    def transmit_reading(self, payload: Dict, timeout: float = 4.0) -> bool:
        """
        Send a reading payload to the backend POST /api/readings with Bearer auth and retry logic.
        """
        endpoint = f"{self.server_url}/api/readings"
        api_payload = {
            "room_id": payload["room_id"],
            "level": payload["level"],
            "quiet_score": payload["quiet_score"],
            "status_color": payload["status_color"],
        }
        data = json.dumps(api_payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "QuietSpace-EdgeNode/1.0",
        }
        device_key = self.device_key or os.environ.get("QUIETSPACE_DEVICE_KEY", "")
        if device_key:
            headers["Authorization"] = f"Bearer {device_key}"

        req = urllib.request.Request(
            endpoint,
            data=data,
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if 200 <= resp.status < 300:
                    self.total_sent += 1
                    self.backoff_delay = 1.0  # Reset backoff on success
                    return True
                else:
                    self.total_failed += 1
                    return False
        except (urllib.error.URLError, urllib.error.HTTPError, OSError):
            self.total_failed += 1
            # Exponential backoff up to 10s
            self.backoff_delay = min(10.0, self.backoff_delay * 1.5)
            return False

    def send_heartbeat(self, timeout: float = 3.0) -> bool:
        """
        Send a lightweight heartbeat ping to POST /api/hardware/heartbeat.
        """
        endpoint = f"{self.server_url}/api/hardware/heartbeat"
        payload = {
            "room_id": self.room_id,
            "status": "ok",
        }
        data = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        device_key = self.device_key or os.environ.get("QUIETSPACE_DEVICE_KEY", "")
        if device_key:
            headers["Authorization"] = f"Bearer {device_key}"

        req = urllib.request.Request(
            endpoint,
            data=data,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status == 200
        except Exception:
            return False

    def run(self, duration_seconds: Optional[float] = None):
        """
        Continuous listening and transmission loop.
        """
        mode_label = "PHYSICAL MICROPHONE" if self.use_hardware else f"SIMULATED HARDWARE ({self.scenario})"
        print("=" * 60)
        print(" QuietSpace Edge Sound Sensor Client")
        print("=" * 60)
        print(f" Room ID:    {self.room_id}")
        print(f" Mode:       {mode_label}")
        print(f" Backend:    {self.server_url} ({'TRANSMITTING' if self.transmit else 'DRY-RUN'})")
        print(f" Interval:   {self.interval:.1f}s")
        print(" Press Ctrl+C to stop listening.")
        print("-" * 60)

        start_time = time.time()
        try:
            while True:
                now = time.time()
                if duration_seconds is not None and (now - start_time) >= duration_seconds:
                    break

                raw_level = self.capture_level()

                # Process through acoustic envelope filter
                level, status_color, quiet_score, classification = self.classifier.process_sample(raw_level)

                # Fault detection: Zero-dB streak check
                if level <= 0.0:
                    self.consecutive_zero_readings += 1
                    if self.consecutive_zero_readings >= 3:
                        print(
                            f"[FAULT DETECTED] Zero-dB reading reported for {self.consecutive_zero_readings} "
                            "consecutive cycles! Check microphone connection or obstruction."
                        )
                else:
                    self.consecutive_zero_readings = 0

                payload = {
                    "room_id": self.room_id,
                    "level": round(level, 1),
                    "quiet_score": quiet_score,
                    "status_color": status_color,
                    "classification": classification,
                }

                status_tag = {
                    "green": "[GREEN ]",
                    "yellow": "[YELLOW]",
                    "red": "[RED   ]",
                }.get(status_color, "[INFO  ]")

                tx_status = "DRY RUN"
                if self.transmit:
                    ok = self.transmit_reading(payload)
                    tx_status = "HTTP 201 OK" if ok else f"HTTP ERR (Retrying in {self.backoff_delay:.1f}s)"

                print(
                    f"[{time.strftime('%H:%M:%S')}] Room {self.room_id:03d} | "
                    f"{status_tag} {level:5.1f} dB ({quiet_score:<8}) | "
                    f"Class: {classification:<26} | {tx_status}"
                )

                sleep_time = self.interval
                if self.transmit and self.backoff_delay > 1.0:
                    sleep_time = min(10.0, self.interval + self.backoff_delay)
                time.sleep(sleep_time)

        except KeyboardInterrupt:
            print("\nShutting down QuietSpace edge sensor...")
        finally:
            print("-" * 60)
            print(f" Transmitted: {self.total_sent} readings | Failed: {self.total_failed}")
            print("=" * 60)


def monitoring_config(server_url: Optional[str] = None, device_key: Optional[str] = None, room_id: Optional[int] = None):
    url = (server_url or os.environ.get("QUIETSPACE_URL", "http://localhost:3000")).rstrip("/")
    key = device_key or os.environ.get("QUIETSPACE_DEVICE_KEY", "")
    rid = int(room_id or os.environ.get("QUIETSPACE_ROOM_ID", "1"))
    headers = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(f"{url}/api/device/config", headers=headers)
    with urllib.request.urlopen(request, timeout=2) as response:
        config = json.load(response)
    return config if config.get("room_id") == rid and config.get("monitoring_enabled") else None


def load_dotenv():
    env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_file):
        try:
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k, v = k.strip(), v.strip().strip("'\"")
                        if k and k not in os.environ:
                            os.environ[k] = v
        except Exception:
            pass


def parse_args():
    load_dotenv()
    parser = argparse.ArgumentParser(description="QuietSpace Edge Sound Sensor Client")
    parser.add_argument(
        "--room-id",
        "-r",
        type=int,
        default=int(os.getenv("ROOM_ID", "1")),
        help="Room ID number (default: 1 or ROOM_ID env var)",
    )
    parser.add_argument(
        "--server-url",
        "-s",
        type=str,
        default=os.getenv("QUIETSPACE_API_URL", "http://localhost:3000"),
        help="QuietSpace backend URL (default: http://localhost:3000 or QUIETSPACE_API_URL env var)",
    )
    parser.add_argument(
        "--interval",
        "-i",
        type=float,
        default=1.0,
        help="Sampling and transmission interval in seconds (default: 1.0)",
    )
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="Force simulation mode instead of capturing physical microphone",
    )
    parser.add_argument(
        "--scenario",
        type=str,
        default="dynamic",
        help="Scenario for simulation (quiet, murmur, loud, transient, escalation, fault_zero_db, dynamic)",
    )
    parser.add_argument(
        "--duration",
        "-d",
        type=float,
        default=None,
        help="Duration in seconds (runs indefinitely if omitted)",
    )
    parser.add_argument(
        "--no-transmit",
        action="store_true",
        help="Capture or simulate locally without sending HTTP requests to the backend",
    )
    parser.add_argument(
        "--device-key",
        "-k",
        type=str,
        default=os.getenv("QUIETSPACE_DEVICE_KEY", ""),
        help="Device key for Authorization: Bearer <key> header",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    client = EdgeSensorClient(
        room_id=args.room_id,
        server_url=args.server_url,
        interval=args.interval,
        simulate=args.simulate,
        scenario=args.scenario,
        transmit=not args.no_transmit,
        device_key=args.device_key,
    )
    client.run(duration_seconds=args.duration)


if __name__ == "__main__":
    main()
