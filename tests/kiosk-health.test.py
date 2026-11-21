import importlib.util, json, pathlib, signal, subprocess, sys, tempfile, time, types, unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('kiosk_health', pathlib.Path(__file__).parents[1] / 'scripts/pi-kiosk/health.py')
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


def snapshot(live=True, disabled=False):
    now = int(time.time() * 1000)
    return {'version': 1, 'at': now, 'live': live, 'monitoring': live, 'authorized': live,
            'authenticated': True, 'administrativelyDisabled': disabled,
            'times': {key: now for key in ('sample', 'evaluation', 'reading', 'heartbeat', 'config')}}


def simulate(folder, probe, ticks=150):
    clock = [0]
    checks = [0]
    signals = []
    alive = [True]
    def kill(pid, sig):
        if not alive[0]:
            raise ProcessLookupError()
        if sig:
            saved=json.loads((pathlib.Path(folder)/'observer-state.json').read_text())
            if not 1 <= saved['used'] <= health.RESTART_LIMIT:
                raise AssertionError('Restart was not durably reserved before the signal')
            signals.append((clock[0], sig))
            alive[0] = False
        else:
            checks[0] += 1
            if checks[0] > ticks:
                raise ProcessLookupError()
    args = types.SimpleNamespace(pid=987654, profile='unused', url='https://test.invalid/', output=str(pathlib.Path(folder) / 'health.json'))
    with patch.object(health, 'probe', side_effect=lambda *args: probe(clock[0])), patch.object(health.os, 'kill', side_effect=kill), patch.object(health.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(health.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
        health.watch(args)
    return signals, json.loads(pathlib.Path(args.output).read_text())


def unavailable(_):
    raise OSError('debugging_not_available')


class KioskHealthTests(unittest.TestCase):
    def test_stale_live_capture_only(self):
        data = snapshot()
        self.assertFalse(health.stalled(data))
        data['times']['sample'] -= 16000
        self.assertTrue(health.stalled(data))
        data['administrativelyDisabled'] = True
        self.assertFalse(health.stalled(data))
        data.update(administrativelyDisabled=False, live=False)
        self.assertFalse(health.stalled(data))

    def test_snapshot_private_and_replaced_not_appended(self):
        with tempfile.TemporaryDirectory() as folder:
            output = pathlib.Path(folder) / 'health.json'
            health.write_snapshot(output, {'events': [1]})
            health.write_snapshot(output, {'events': []})
            self.assertEqual(json.loads(output.read_text()), {'events': []})
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertFalse(output.with_suffix('.tmp').exists())

    def test_non_loopback_debug_endpoint_rejected(self):
        with self.assertRaises(ValueError):
            health.evaluate('ws://192.0.2.1:9222/devtools/page/test')

    def test_permanently_unavailable_debugging_never_restarts_even_across_observers(self):
        with tempfile.TemporaryDirectory() as folder:
            for _ in range(3):
                signals, data = simulate(folder, unavailable)
                self.assertEqual(signals, [])
                self.assertEqual(data['action'], 'diagnostics_unavailable')
                self.assertFalse(data['recovery']['debugging_previously_verified'])
                self.assertEqual(data['recovery']['restarts_used'], 0)

    def test_verified_debugging_required_then_sustained_failure_can_restart(self):
        def initial_health(now):
            if now == 0:
                return snapshot()
            return unavailable(now)
        with tempfile.TemporaryDirectory() as folder:
            signals, data = simulate(folder, initial_health)
            self.assertEqual(signals, [(90, signal.SIGTERM)])
            self.assertEqual(data['recovery']['restarts_used'], 1)
            self.assertEqual(data['action'], 'restart_unresponsive_browser')
            state = pathlib.Path(folder) / 'observer-state.json'
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(state.read_text())['used'], 1)

    def test_repeated_unsuccessful_relaunches_exhaust_durable_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            budget = health.RestartBudget(pathlib.Path(folder) / 'observer-state.json')
            budget.inspect(True, True, 0)
            for expected in (1, 2):
                signals, data = simulate(folder, unavailable)
                self.assertEqual(signals, [(90, signal.SIGTERM)])
                self.assertEqual(data['recovery']['restarts_used'], expected)
            for _ in range(3):
                signals, data = simulate(folder, unavailable)
                self.assertEqual(signals, [])
                self.assertEqual(data['action'], 'restart_budget_exhausted')
                self.assertEqual(data['recovery']['restarts_used'], 2)

    def test_five_minutes_of_continuous_live_health_rearms_exhausted_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'observer-state.json'
            budget = health.RestartBudget(path)
            budget.inspect(True, True, 0)
            budget.reserve(); budget.reserve()
            budget.inspect(False, False, 1)
            self.assertTrue(budget.inspect(True, True, 10)['exhausted'])
            self.assertTrue(budget.inspect(True, True, 309)['exhausted'])
            self.assertFalse(budget.inspect(True, True, 310)['exhausted'])
            self.assertEqual(health.RestartBudget(path).inspect(False, False, 500)['restarts_used'], 0)
            self.assertIsNotNone(budget.reserve())

    def test_interrupted_health_or_new_observer_does_not_reset_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'observer-state.json'
            budget = health.RestartBudget(path)
            budget.inspect(True, False, 0)
            budget.reserve(); budget.reserve()
            budget.inspect(True, True, 10)
            budget.inspect(False, False, 299)
            self.assertTrue(budget.inspect(True, True, 310)['exhausted'])
            self.assertTrue(health.RestartBudget(path).inspect(True, True, 1000)['exhausted'])

    def test_pause_does_not_consume_or_reset_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            budget = health.RestartBudget(pathlib.Path(folder) / 'observer-state.json')
            budget.inspect(True, False, 0)
            budget.reserve(); budget.reserve()
            signals, data = simulate(folder, lambda _: snapshot(False, True))
            self.assertEqual(signals, [])
            self.assertEqual(data['action'], 'observe')
            self.assertTrue(data['recovery']['exhausted'])

    def test_operator_reset_is_observed_and_does_not_invent_debugging_health(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'observer-state.json'
            observer = health.RestartBudget(path)
            observer.inspect(False, False, 0)
            self.assertFalse(health.RestartBudget(path).reset()['debugging_previously_verified'])
            self.assertIsNone(observer.reserve())
            observer.inspect(True, False, 10)
            observer.reserve(); observer.reserve()
            health.RestartBudget(path).reset()
            self.assertEqual(observer.inspect(False, False, 100)['restarts_used'], 0)
            self.assertEqual(observer.reserve()['restarts_used'], 1)

    def test_corrupt_or_unwritable_budget_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'observer-state.json'
            path.write_text('{invalid json')
            signals, data = simulate(folder, unavailable, ticks=15)
            self.assertEqual(signals, [])
            self.assertEqual(data['action'], 'restart_state_unavailable')
            self.assertFalse(health.RestartBudget(path).reset()['debugging_previously_verified'])
            health.RestartBudget(path).inspect(True, False, 0)
            with patch.object(health.RestartBudget, 'reserve', side_effect=OSError('write_failed')):
                signals, data = simulate(folder, unavailable, ticks=15)
            self.assertEqual(signals, [])
            self.assertEqual(data['action'], 'restart_state_unavailable')

    def test_explicit_operator_cli_resets_budget_without_touching_profile_or_enrollment(self):
        with tempfile.TemporaryDirectory() as folder:
            state = pathlib.Path(folder) / 'observer-state.json'
            budget = health.RestartBudget(state)
            budget.inspect(True, False, 0)
            budget.reserve(); budget.reserve()
            output = subprocess.check_output([sys.executable, '-B', str(pathlib.Path(health.__file__)), 'reset-budget', '--output', str(pathlib.Path(folder) / 'health.json')], text=True)
            result = json.loads(output)
            self.assertEqual(result['action'], 'restart_budget_reset')
            self.assertEqual(result['restarts_used'], 0)
            self.assertTrue(result['debugging_previously_verified'])
            self.assertEqual(json.loads(state.read_text())['used'], 0)
            self.assertEqual({p.name for p in pathlib.Path(folder).iterdir()}, {'observer-state.json','observer-state.lock'})

    def test_debugging_connection_and_budget_reset_require_real_fresh_snapshot(self):
        data = snapshot()
        self.assertTrue(health.debug_health(data))
        self.assertTrue(health.live_health(data))
        data['times']['heartbeat'] -= 16000
        self.assertFalse(health.live_health(data))
        data = snapshot(False, True)
        self.assertTrue(health.debug_health(data))
        self.assertFalse(health.live_health(data))
        data['at'] -= 60000
        self.assertFalse(health.debug_health(data))
        self.assertFalse(health.debug_health({'version': 0, 'at': int(time.time()*1000)}))


if __name__ == '__main__':
    unittest.main()
