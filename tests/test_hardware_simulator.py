#!/usr/bin/env python3
"""
Unit tests for QuietSpace Hardware Simulation & Acoustic Edge Node
==================================================================
Tests acoustic envelope duration analysis (transient spike suppression),
decibel scenario generation, sensor payload schema, zero-dB fault detection,
Authorization: Bearer <QUIETSPACE_DEVICE_KEY> header transmission,
and network retry/backoff mechanisms.
"""

import json
import os
import time
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

# Import simulator and edge node components
from hardware_simulator import (
    AcousticClassifier,
    HardwareSensorNode,
    HardwareSimulator,
    NoiseScenario,
)
from sound import EdgeSensorClient


class TestAcousticClassifier(unittest.TestCase):
    """Tests duration and envelope analysis (Section 5 Approach A)."""

    def setUp(self):
        self.classifier = AcousticClassifier(yellow_threshold=60.0, red_threshold=75.0)

    def test_ambient_quiet(self):
        level, color, score, classification = self.classifier.process_sample(42.0)
        self.assertEqual(level, 42.0)
        self.assertEqual(color, "green")
        self.assertEqual(score, "Quiet")
        self.assertEqual(classification, "ambient_quiet")

    def test_moderate_activity_yellow(self):
        level, color, score, classification = self.classifier.process_sample(64.5)
        self.assertEqual(level, 64.5)
        self.assertEqual(color, "yellow")
        self.assertEqual(score, "Warning")
        self.assertEqual(classification, "moderate_activity")

    def test_transient_spike_suppression(self):
        """
        Spike exceeding 75 dB for < 0.8 seconds must be classified as transient
        impact noise and suppressed from tripping into RED.
        """
        t0 = 1000.0
        # Instant spike to 88 dB (e.g. dropped book / door slam)
        level, color, score, classification = self.classifier.process_sample(88.0, current_time=t0)
        self.assertEqual(color, "yellow")  # Suppressed from red
        self.assertEqual(score, "Warning")
        self.assertEqual(classification, "transient_impact_suppressed")

        # 0.4 seconds later, still spiking
        level, color, score, classification = self.classifier.process_sample(85.0, current_time=t0 + 0.4)
        self.assertEqual(color, "yellow")
        self.assertEqual(classification, "transient_impact_suppressed")

        # 0.6 seconds later, spike subsides back to ambient (40 dB)
        level, color, score, classification = self.classifier.process_sample(40.0, current_time=t0 + 0.6)
        self.assertEqual(color, "green")
        self.assertEqual(score, "Quiet")
        self.assertEqual(classification, "ambient_quiet")

    def test_sustained_disturbance_escalation(self):
        """
        Noise exceeding 75 dB for >= 0.8 seconds must escalate to RED.
        """
        t0 = 2000.0
        # Start spike
        self.classifier.process_sample(82.0, current_time=t0)

        # 0.9 seconds later: exceeds 0.8s threshold -> sustained disturbance
        level, color, score, classification = self.classifier.process_sample(82.0, current_time=t0 + 0.9)
        self.assertEqual(color, "red")
        self.assertEqual(score, "Too Loud")
        self.assertEqual(classification, "sustained_disturbance")

    def test_zero_db_fault_classification(self):
        level, color, score, classification = self.classifier.process_sample(0.0)
        self.assertEqual(level, 0.0)
        self.assertEqual(color, "green")
        self.assertEqual(classification, "fault_zero_db")


class TestNoiseScenario(unittest.TestCase):
    """Tests scenario trajectory generators."""

    def test_quiet_scenario_bounds(self):
        scenario = NoiseScenario("quiet", base_seed=42)
        for i in range(20):
            val = scenario.next_level(float(i))
            self.assertGreaterEqual(val, 30.0)
            self.assertLessEqual(val, 48.0)

    def test_murmur_scenario_bounds(self):
        scenario = NoiseScenario("murmur", base_seed=42)
        for i in range(20):
            val = scenario.next_level(float(i))
            self.assertGreaterEqual(val, 50.0)
            self.assertLessEqual(val, 68.0)

    def test_loud_scenario_bounds(self):
        scenario = NoiseScenario("loud", base_seed=42)
        for i in range(20):
            val = scenario.next_level(float(i))
            self.assertGreaterEqual(val, 72.0)
            self.assertLessEqual(val, 95.0)

    def test_fault_zero_db_scenario(self):
        scenario = NoiseScenario("fault_zero_db")
        for i in range(5):
            self.assertEqual(scenario.next_level(float(i)), 0.0)

    def test_fault_disconnect_scenario(self):
        scenario = NoiseScenario("fault_disconnect", base_seed=42)
        # First 5 seconds sends normal readings
        self.assertGreater(scenario.next_level(2.0), 0)
        # After 5 seconds sends disconnect sentinel -1.0
        self.assertEqual(scenario.next_level(6.0), -1.0)

    def test_transient_spikes_generation(self):
        scenario = NoiseScenario("transient", base_seed=123)
        readings = [scenario.next_level(float(i)) for i in range(15)]
        has_spike = any(r >= 75.0 for r in readings)
        self.assertTrue(has_spike, "Transient scenario should generate at least one spike >= 75 dB")

    def test_invalid_scenario_raises(self):
        with self.assertRaises(ValueError):
            NoiseScenario("nonexistent_scenario")


class TestHardwareSensorNode(unittest.TestCase):
    """Tests edge node sampling and HTTP payload generation with Bearer auth."""

    def setUp(self):
        self.test_key = "a" * 64
        self.node = HardwareSensorNode(
            room_id=311,
            server_url="http://mock-server:3000",
            scenario="quiet",
            use_envelope_filter=True,
            device_key=self.test_key,
        )

    def test_sample_reading_schema(self):
        payload = self.node.sample_reading()
        self.assertIsNotNone(payload)
        self.assertEqual(payload["room_id"], 311)
        self.assertIn("level", payload)
        self.assertIn("quiet_score", payload)
        self.assertIn("status_color", payload)
        self.assertIn(payload["status_color"], ["green", "yellow", "red"])
        self.assertIn(payload["quiet_score"], ["Quiet", "Warning", "Too Loud"])

    @patch("urllib.request.urlopen")
    def test_transmit_reading_success_with_bearer_header(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.status = 201
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        payload = self.node.sample_reading()
        success = self.node.transmit_reading(payload)

        self.assertTrue(success)
        self.assertEqual(self.node.readings_sent, 1)
        self.assertEqual(self.node.failed_requests, 0)
        self.assertEqual(self.node.backoff_delay, 1.0)

        # Verify Authorization header was sent
        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.get_header("Authorization"), f"Bearer {self.test_key}")
        self.assertEqual(req.get_header("Content-type"), "application/json")

    @patch("urllib.request.urlopen")
    def test_transmit_reading_failure_and_backoff(self, mock_urlopen):
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

        payload = self.node.sample_reading()
        success = self.node.transmit_reading(payload)

        self.assertFalse(success)
        self.assertEqual(self.node.readings_sent, 0)
        self.assertEqual(self.node.failed_requests, 1)
        self.assertGreater(self.node.backoff_delay, 1.0)


class TestEdgeSensorClient(unittest.TestCase):
    """Tests sound.py client behavior, fault streak counting, and Bearer auth."""

    def setUp(self):
        self.test_key = "b" * 64

    def test_client_initialization_with_simulation(self):
        client = EdgeSensorClient(
            room_id=1,
            simulate=True,
            scenario="quiet",
            transmit=False,
            device_key=self.test_key,
        )
        self.assertEqual(client.room_id, 1)
        self.assertEqual(client.device_key, self.test_key)
        self.assertFalse(client.use_hardware)
        level = client.capture_level()
        self.assertGreaterEqual(level, 30.0)
        self.assertLessEqual(level, 50.0)

    def test_zero_db_streak_warning(self):
        client = EdgeSensorClient(
            room_id=2,
            simulate=True,
            scenario="fault_zero_db",
            transmit=False,
        )
        # Capture 0 dB multiple times
        for _ in range(3):
            lvl = client.capture_level()
            self.assertEqual(lvl, 0.0)

    @patch("urllib.request.urlopen")
    def test_transmit_reading_sends_bearer_key(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.status = 201
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        client = EdgeSensorClient(
            room_id=1,
            simulate=True,
            scenario="quiet",
            transmit=True,
            device_key=self.test_key,
        )
        payload = {
            "room_id": 1,
            "level": 45.0,
            "quiet_score": "Quiet",
            "status_color": "green",
            "classification": "ambient_quiet",
        }
        ok = client.transmit_reading(payload)
        self.assertTrue(ok)
        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.get_header("Authorization"), f"Bearer {self.test_key}")


if __name__ == "__main__":
    unittest.main()
