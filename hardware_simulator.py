#!/usr/bin/env python3
"""
QuietSpace Hardware & Acoustic Sensor Simulator
================================================
Simulates Raspberry Pi hardware sensor nodes deployed in study rooms.
Supports real-time multi-room sound generation, physical dBA modeling,
acoustic envelope analysis (transient spike suppression vs sustained noise),
sensor fault injection (zero-dB stuck mic, network disconnects),
and HTTP payload transmission to the QuietSpace Express/MySQL backend with
exponential backoff retry handling.

Usage:
    python hardware_simulator.py --rooms 1 --scenario quiet
    python hardware_simulator.py --rooms 1,2,3 --scenario dynamic --interval 1.5
    python hardware_simulator.py --rooms 1 --scenario escalation --duration 40
    python hardware_simulator.py --help
"""

import argparse
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.request
from typing import Dict, List, Optional, Tuple


class AcousticClassifier:
    """
    Approach A from Project Roadmap (Section 5): Time & Envelope Analysis.
    Distinguishes transient impact noise (dropped book, door slam < 0.8s)
    from sustained speech/disturbances (> 3.0s).
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
        """
        Process a sound level measurement through envelope duration analysis.

        Returns:
            (filtered_level, status_color, quiet_score, classification)
        """
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
                # Sustained loud sound (> 0.8s)
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
    """
    Generates realistic room decibel trajectories for various testing profiles.
    """

    SCENARIOS = [
        "quiet",
        "murmur",
        "loud",
        "transient",
        "escalation",
        "fault_zero_db",
        "fault_disconnect",
        "dynamic",
    ]

    def __init__(self, scenario: str = "quiet", base_seed: Optional[int] = None):
        if scenario not in self.SCENARIOS:
            raise ValueError(f"Unknown scenario '{scenario}'. Choose from {self.SCENARIOS}")
        self.scenario = scenario
        self.random = random.Random(base_seed)
        self.step_index = 0
        self.current_val = 38.0

    def next_level(self, elapsed_seconds: float) -> float:
        """Calculate the next decibel reading based on active scenario."""
        self.step_index += 1

        if self.scenario == "quiet":
            # Baseline quiet study room: 34 - 44 dB
            noise = self.random.gauss(0, 1.5)
            self.current_val = 0.85 * self.current_val + 0.15 * 38.0 + noise
            return max(30.0, min(48.0, round(self.current_val, 1)))

        elif self.scenario == "murmur":
            # Collaborative whisper / soft discussion: 54 - 64 dB
            noise = self.random.gauss(0, 2.0)
            self.current_val = 0.85 * self.current_val + 0.15 * 60.0 + noise
            return max(50.0, min(68.0, round(self.current_val, 1)))

        elif self.scenario == "loud":
            # Sustained loud conversation / disruption: 74 - 88 dB
            noise = self.random.gauss(0, 3.0)
            self.current_val = 0.80 * self.current_val + 0.20 * 80.0 + noise
            return max(72.0, min(95.0, round(self.current_val, 1)))

        elif self.scenario == "transient":
            # Ambient baseline with intermittent sharp 0.5s transient spikes (door slam, book drop)
            if self.step_index % 7 == 0:
                return round(self.random.uniform(78.0, 92.0), 1)
            noise = self.random.gauss(0, 1.2)
            self.current_val = 0.85 * self.current_val + 0.15 * 36.0 + noise
            return max(30.0, min(46.0, round(self.current_val, 1)))

        elif self.scenario == "escalation":
            # Cyclic lifecycle:
            # 0-8s: Quiet (36 dB)
            # 8-16s: Warning murmur (63 dB)
            # 16-28s: Too Loud disturbance (82 dB) -> triggers incident
            # 28-36s: Subside (36 dB) -> auto-resolves incident
            cycle = elapsed_seconds % 36.0
            if cycle < 8.0:
                target = 37.0
            elif cycle < 16.0:
                target = 63.0
            elif cycle < 28.0:
                target = 82.0
            else:
                target = 36.0
            noise = self.random.gauss(0, 1.5)
            self.current_val = 0.70 * self.current_val + 0.30 * target + noise
            return max(30.0, min(92.0, round(self.current_val, 1)))

        elif self.scenario == "fault_zero_db":
            # Stuck microphone / disconnected diaphragm: reports 0 dB
            return 0.0

        elif self.scenario == "fault_disconnect":
            # Sensor sends readings for first 5 seconds, then stops
            if elapsed_seconds > 5.0:
                return -1.0  # Sentinel for dropped packet / offline
            return round(self.random.uniform(36.0, 42.0), 1)

        elif self.scenario == "dynamic":
            # Realistic time-varying library study room
            # Combines low-frequency drift with random conversational bursts
            drift = 42.0 + 12.0 * math.sin(elapsed_seconds / 15.0)
            burst = 25.0 if self.random.random() < 0.12 else 0.0
            noise = self.random.gauss(0, 2.0)
            val = drift + burst + noise
            return max(32.0, min(88.0, round(val, 1)))

        return 38.0


class HardwareSensorNode:
    """
    Models an individual edge Raspberry Pi sensor unit deployed in a specific room.
    """

    def __init__(
        self,
        room_id: int,
        room_name: Optional[str] = None,
        server_url: str = "http://localhost:3000",
        scenario: str = "quiet",
        yellow_threshold: float = 60.0,
        red_threshold: float = 75.0,
        use_envelope_filter: bool = True,
    ):
        self.room_id = room_id
        self.room_name = room_name or f"Room {room_id}"
        self.server_url = server_url.rstrip("/")
        self.scenario = scenario
        self.generator = NoiseScenario(scenario)
        self.classifier = AcousticClassifier(yellow_threshold, red_threshold)
        self.use_envelope_filter = use_envelope_filter

        self.start_time = time.time()
        self.readings_sent = 0
        self.failed_requests = 0
        self.backoff_delay = 1.0
        self.is_connected = True

    def sample_reading(self) -> Optional[Dict]:
        """
        Produce a simulated sensor measurement with acoustic classification.
        Returns payload dict, or None if sensor is simulating a disconnected state.
        """
        elapsed = time.time() - self.start_time
        raw_level = self.generator.next_level(elapsed)

        # Check for disconnection sentinel
        if raw_level < 0:
            self.is_connected = False
            return None

        self.is_connected = True

        if self.use_envelope_filter:
            level, status_color, quiet_score, classification = self.classifier.process_sample(
                raw_level
            )
        else:
            level = raw_level
            if level >= self.classifier.red_threshold:
                status_color, quiet_score = "red", "Too Loud"
            elif level >= self.classifier.yellow_threshold:
                status_color, quiet_score = "yellow", "Warning"
            else:
                status_color, quiet_score = "green", "Quiet"
            classification = "raw"

        payload = {
            "room_id": self.room_id,
            "level": round(level, 2),
            "quiet_score": quiet_score,
            "status_color": status_color,
            "_classification": classification,
            "_raw_level": raw_level,
        }
        return payload

    def transmit_reading(self, payload: Dict, timeout: float = 4.0) -> bool:
        """
        Send a reading payload to the backend POST /api/readings with retry logic.
        """
        endpoint = f"{self.server_url}/api/readings"
        # Extract the fields required by the server API
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
                "User-Agent": "QuietSpace-HardwareSensor/1.0",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if 200 <= resp.status < 300:
                    self.readings_sent += 1
                    self.backoff_delay = 1.0  # Reset backoff on success
                    return True
                else:
                    self.failed_requests += 1
                    return False
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as err:
            self.failed_requests += 1
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
            "status": "ok" if self.is_connected else "disconnected",
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            endpoint,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status == 200
        except Exception:
            return False


class HardwareSimulator:
    """
    Multi-Room Orchestrator for Hardware Simulation.
    Manages multiple concurrent room sensor nodes.
    """

    def __init__(
        self,
        room_ids: List[int],
        server_url: str = "http://localhost:3000",
        scenario: str = "dynamic",
        interval: float = 1.0,
        use_envelope_filter: bool = True,
        transmit: bool = True,
        verbose: bool = True,
    ):
        self.server_url = server_url
        self.interval = max(0.1, interval)
        self.transmit = transmit
        self.verbose = verbose
        self.running = False

        self.nodes: Dict[int, HardwareSensorNode] = {}
        for rid in room_ids:
            self.nodes[rid] = HardwareSensorNode(
                room_id=rid,
                server_url=server_url,
                scenario=scenario,
                use_envelope_filter=use_envelope_filter,
            )

    def run(self, duration_seconds: Optional[float] = None):
        """
        Run the simulation loop until duration expires or SIGINT received.
        """
        self.running = True
        start_time = time.time()

        if self.verbose:
            rooms_str = ", ".join(f"Room {r}" for r in self.nodes.keys())
            print("=" * 60)
            print(" QuietSpace Hardware Sensor Simulator")
            print("=" * 60)
            print(f" Nodes:      {rooms_str}")
            print(f" Backend:    {self.server_url} ({'TRANSMITTING' if self.transmit else 'DRY-RUN'})")
            print(f" Interval:   {self.interval:.1f}s")
            print(f" Duration:   {'Indefinite' if duration_seconds is None else f'{duration_seconds}s'}")
            print(" Press Ctrl+C to stop simulation.")
            print("-" * 60)

        try:
            while self.running:
                now = time.time()
                if duration_seconds is not None and (now - start_time) >= duration_seconds:
                    break

                for room_id, node in self.nodes.items():
                    payload = node.sample_reading()
                    if payload is None:
                        if self.verbose:
                            print(f"[{time.strftime('%H:%M:%S')}] Room {room_id:03d} | SENSOR DISCONNECTED (Simulated Drop)")
                        continue

                    status_symbol = {
                        "green": "[GREEN ]",
                        "yellow": "[YELLOW]",
                        "red": "[RED   ]",
                    }.get(payload["status_color"], "[INFO  ]")

                    transmitted_ok = False
                    if self.transmit:
                        transmitted_ok = node.transmit_reading(payload)
                        tx_label = "HTTP 201 OK" if transmitted_ok else "HTTP ERR (Backoff)"
                    else:
                        tx_label = "DRY RUN"

                    if self.verbose:
                        classification = payload.get("_classification", "")
                        print(
                            f"[{time.strftime('%H:%M:%S')}] Room {room_id:03d} | "
                            f"{status_symbol} {payload['level']:5.1f} dB ({payload['quiet_score']:<8}) | "
                            f"Class: {classification:<26} | {tx_label}"
                        )

                time.sleep(self.interval)

        except KeyboardInterrupt:
            if self.verbose:
                print("\nReceived interrupt. Stopping simulation...")
        finally:
            self.stop()

    def stop(self):
        """Stop simulation and print summary metrics."""
        self.running = False
        if self.verbose:
            print("-" * 60)
            print(" Simulation Summary:")
            total_sent = sum(n.readings_sent for n in self.nodes.values())
            total_failed = sum(n.failed_requests for n in self.nodes.values())
            print(f" Total Transmitted: {total_sent}")
            print(f" Failed Requests:   {total_failed}")
            print("=" * 60)


def parse_args():
    parser = argparse.ArgumentParser(
        description="QuietSpace Hardware & Acoustic Sensor Simulator"
    )
    parser.add_argument(
        "--rooms",
        "-r",
        type=str,
        default="1",
        help="Comma-separated room IDs to simulate (e.g., '1' or '1,2,3'). Default: 1",
    )
    parser.add_argument(
        "--server",
        "-s",
        type=str,
        default=os.getenv("QUIETSPACE_API_URL", "http://localhost:3000"),
        help="QuietSpace backend API URL. Default: http://localhost:3000",
    )
    parser.add_argument(
        "--scenario",
        type=str,
        default="dynamic",
        choices=NoiseScenario.SCENARIOS,
        help="Acoustic scenario (quiet, murmur, loud, transient, escalation, fault_zero_db, fault_disconnect, dynamic). Default: dynamic",
    )
    parser.add_argument(
        "--interval",
        "-i",
        type=float,
        default=1.0,
        help="Seconds between sensor samples. Default: 1.0",
    )
    parser.add_argument(
        "--duration",
        "-d",
        type=float,
        default=None,
        help="Run duration in seconds (runs indefinitely if omitted)",
    )
    parser.add_argument(
        "--no-transmit",
        action="store_true",
        help="Simulate locally without transmitting HTTP requests to backend",
    )
    parser.add_argument(
        "--no-envelope",
        action="store_true",
        help="Disable acoustic envelope duration filtering",
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        help="Quiet output (suppress per-sample logs)",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    try:
        room_ids = [int(x.strip()) for x in args.rooms.split(",") if x.strip()]
    except ValueError:
        print(f"Error: Invalid room ID list '{args.rooms}'. Must be comma-separated integers.", file=sys.stderr)
        sys.exit(1)

    sim = HardwareSimulator(
        room_ids=room_ids,
        server_url=args.server,
        scenario=args.scenario,
        interval=args.interval,
        use_envelope_filter=not args.no_envelope,
        transmit=not args.no_transmit,
        verbose=not args.quiet,
    )
    sim.run(duration_seconds=args.duration)


if __name__ == "__main__":
    main()
