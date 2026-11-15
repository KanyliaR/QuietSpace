#!/usr/bin/env python3
"""
QuietSpace Edge Audio Sampling & Hardware Client
=================================================
Runs on the Raspberry Pi edge device (or development workstation) to monitor
study room noise levels. Supports live microphone capture via sounddevice/numpy,
automatic simulation fallback when audio hardware is absent, acoustic envelope
classification (transient spike vs sustained noise), zero-dB fault detection,
and robust HTTP transmission to the QuietSpace Express/MySQL backend with
exponential backoff.

Usage:
    python sound.py
    python sound.py --room-id 1 --server-url http://localhost:3000
    python sound.py --simulate --scenario dynamic
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
from typing import Optional, Tuple

# Try importing sounddevice and numpy for physical hardware capture
HAS_HARDWARE_DEPS = False
try:
    import numpy as np
    import sounddevice as sd
    HAS_HARDWARE_DEPS = True
except (ImportError, OSError):
    HAS_HARDWARE_DEPS = False

# Import our simulator components
try:
    from hardware_simulator import AcousticClassifier, NoiseScenario
except ImportError:
    # Inline fallback if hardware_simulator is not found in python path
    class AcousticClassifier:
        def __init__(self, yellow_threshold: float = 60.0, red_threshold: float = 75.0):
            self.yellow_threshold = yellow_threshold
            self.red_threshold = red_threshold
            self.spike_start_time = None
        def process_sample(self, raw_level: float, current_time=None):
            if current_time is None:
                current_time = time.time()
            if raw_level <= 0:
                self.spike_start_time = None
                return (0.0, "green", "Quiet", "fault_zero_db")
            if raw_level >= self.red_threshold:
                if self.spike_start_time is None:
                    self.spike_start_time = current_time
                if (current_time - self.spike_start_time) < 0.8:
                    return (raw_level, "yellow", "Warning", "transient_impact_suppressed")
                return (raw_level, "red", "Too Loud", "sustained_disturbance")
            self.spike_start_time = None
            if raw_level >= self.yellow_threshold:
                return (raw_level, "yellow", "Warning", "moderate_activity")
            return (raw_level, "green", "Quiet", "ambient_quiet")

    class NoiseScenario:
        def __init__(self, scenario="dynamic"):
            import random
            self.random = random.Random()
            self.val = 38.0
        def next_level(self, elapsed_seconds):
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
    ):
        self.room_id = room_id
        self.server_url = server_url.rstrip("/")
        self.interval = max(0.1, interval)
        self.simulate = simulate
        self.scenario = scenario
        self.transmit = transmit
        self.sample_rate = sample_rate
        self.sample_duration = sample_duration

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
                # Query input devices to verify microphone availability
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
        Obtains raw decibel level from physical microphone or simulation generator.
        """
        if self.use_hardware:
            try:
                # Record mono audio buffer
                samples = int(self.sample_duration * self.sample_rate)
                recording = sd.rec(samples, samplerate=self.sample_rate, channels=1, dtype="float32")
                sd.wait()

                # Calculate root-mean-square (RMS) energy
                rms = np.sqrt(np.mean(np.square(recording)))
                if rms <= 1e-6:
                    return 0.0

                # Map RMS energy to calibrated decibels (dBA approximate SPL)
                # Calibrated baseline: typical quiet room ambient is ~35-40 dB
                # Full scale peak 1.0 maps to ~95 dB
                db = 20.0 * np.log10(rms / 1e-4)
                calibrated_db = max(0.0, min(100.0, float(db)))
                return round(calibrated_db, 1)

            except Exception as err:
                print(f"[WARNING] Hardware audio read error: {err}. Switching to simulation fallback.")
                self.use_hardware = False
                if self.sim_generator is None:
                    self.sim_generator = NoiseScenario(self.scenario)
                return self.capture_level()
        else:
            elapsed = time.time() - self.start_time
            level = self.sim_generator.next_level(elapsed)
            return max(0.0, level)

    def transmit_reading(self, payload: dict, timeout: float = 4.0) -> bool:
        """
        Sends reading payload to the QuietSpace backend POST /api/readings with retry logic.
        """
        endpoint = f"{self.server_url}/api/readings"
        api_payload = {
            "room_id": payload["room_id"],
            "level": payload["level"],
            "quiet_score": payload["quiet_score"],
            "status_color": payload["status_color"],
        }
        data = json.dumps(api_payload).encode("utf-8")
        req = urllib.request.Request(
            endpoint,
            data=data,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "QuietSpace-EdgeNode/1.0",
            },
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
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as err:
            self.total_failed += 1
            # Exponential backoff up to 10s
            self.backoff_delay = min(10.0, self.backoff_delay * 1.5)
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

                # Sleep based on interval, plus any network backoff if failing
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


def parse_args():
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
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    client = EdgeSensorClient(
        room_id=args.room_id,
        server_url=args.server_url,
        interval=args.interval,
        simulate=args.simulate,
        scenario=args.scenario,
        transmit=not args.no_transmit,
    )
    client.run(duration_seconds=args.duration)
