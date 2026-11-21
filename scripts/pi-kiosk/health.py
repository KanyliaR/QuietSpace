#!/usr/bin/env python3
"""Private, loopback-only CDP health observer for the kiosk owned by this launcher.
No dependencies beyond Python 3; never read cookies, request headers, audio or keys.
"""
import argparse, base64, contextlib, fcntl, hashlib, json, math, os, pathlib, signal, socket, struct, time, urllib.request, urllib.parse, uuid


def read_exact(stream, length):
    chunks = bytearray()
    while len(chunks) < length:
        part = stream.read(length - len(chunks))
        if not part:
            raise OSError('debug_connection_closed')
        chunks.extend(part)
    return bytes(chunks)


def send_frame(sock, payload, opcode=1):
    mask = os.urandom(4)
    size = len(payload)
    header = bytes([0x80 | opcode, 0x80 | size]) if size < 126 else bytes([0x80 | opcode, 0x80 | 126]) + struct.pack('!H', size)
    sock.sendall(header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))


def evaluate(endpoint):
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme != 'ws' or parsed.hostname not in ('127.0.0.1', 'localhost'):
        raise ValueError('non_loopback_debug_endpoint')
    with socket.create_connection(('127.0.0.1', parsed.port), timeout=5) as sock:
        stream = sock.makefile('rb')
        key = base64.b64encode(os.urandom(16)).decode()
        request = 'GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n'.format(parsed.path, parsed.port, key)
        sock.sendall(request.encode())
        if b' 101 ' not in stream.readline(4096):
            raise OSError('debug_handshake_failed')
        headers = {}
        for _ in range(40):
            line = stream.readline(4096)
            if line == b'\r\n':
                break
            name, value = line.decode().split(':', 1)
            headers[name.lower()] = value.strip()
        expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        if headers.get('sec-websocket-accept') != expected:
            raise OSError('debug_handshake_failed')
        expression = "window.quietspaceKioskHealth ? window.quietspaceKioskHealth.snapshot() : ({version:0,at:Date.now(),diagnostics:'not_loaded'})"
        send_frame(sock, json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': expression, 'returnByValue': True, 'timeout': 4000}}).encode())
        for _ in range(40):
            first, second = read_exact(stream, 2)
            length = second & 127
            if length == 126:
                length = struct.unpack('!H', read_exact(stream, 2))[0]
            elif length == 127:
                length = struct.unpack('!Q', read_exact(stream, 8))[0]
            if length > 65536 or second & 128 or not first & 128:
                raise ValueError('invalid_debug_frame')
            data = read_exact(stream, length)
            if first & 15 == 9:
                send_frame(sock, data, 10)
                continue
            if first & 15 != 1:
                raise OSError('debug_connection_closed')
            result = json.loads(data)
            if result.get('id') == 1:
                value = result.get('result', {}).get('result', {}).get('value')
                if not isinstance(value, dict):
                    raise ValueError('page_evaluation_failed')
                return value
        raise OSError('debug_response_missing')


def probe(profile, expected_url):
    port = int((pathlib.Path(profile) / 'DevToolsActivePort').read_text().splitlines()[0])
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:{}/json/list'.format(port), timeout=5) as response:
        targets = json.loads(response.read(262144))
    targets = [item for item in targets if item.get('type') == 'page' and item.get('url') == expected_url]
    if len(targets) != 1:
        raise ValueError('room_page_missing_or_duplicate')
    return evaluate(targets[0]['webSocketDebuggerUrl'])


def stalled(snapshot):
    # Administrative pause and ordinary recovery are not renderer failures.
    if snapshot.get('administrativelyDisabled') or not snapshot.get('live'):
        return False
    now = snapshot.get('at', 0)
    times = snapshot.get('times', {})
    return any(now - times.get(kind, 0) > 15000 for kind in ('sample', 'evaluation', 'config'))


def write_snapshot(output, data):
    output = pathlib.Path(output)
    temporary = output.with_suffix('.tmp')
    fd = os.open(str(temporary), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(data, file, separators=(',', ':'))
    os.replace(str(temporary), str(output))


RESTART_LIMIT = 2
HEALTH_RESET_SECONDS = 300


def debug_health(snapshot):
    at = snapshot.get('at')
    return (snapshot.get('version') == 1 and type(at) in (int, float) and math.isfinite(at)
            and abs(time.time() * 1000 - at) <= 15000
            and type(snapshot.get('live')) is bool and isinstance(snapshot.get('times'), dict)
            and not stalled(snapshot))


def live_health(snapshot):
    """Reset eligibility requires real, authorized, fresh monitoring, not just CDP."""
    if not all(snapshot.get(key) is True for key in ('live', 'monitoring', 'authorized', 'authenticated')) or snapshot.get('administrativelyDisabled'):
        return False
    now = snapshot.get('at', 0)
    times = snapshot.get('times', {})
    return all(isinstance(times.get(key), (int, float)) and 0 <= now - times[key] <= 15000
               for key in ('sample', 'evaluation', 'reading', 'heartbeat', 'config'))


class RestartBudget:
    """Private durable latch. A new observer process never grants a fresh budget."""
    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.healthy_since = None
        self.generation = None

    @contextlib.contextmanager
    def locked(self):
        fd = os.open(str(self.path.with_suffix('.lock')), os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(fd, 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def load(self):
        try:
            state = json.loads(self.path.read_text())
        except FileNotFoundError:
            state = {'version': 1, 'verified': False, 'used': 0, 'generation': uuid.uuid4().hex}
            self.save(state)
        if (not isinstance(state, dict) or state.get('version') != 1
                or type(state.get('verified')) is not bool or type(state.get('used')) is not int
                or not 0 <= state['used'] <= RESTART_LIMIT or not isinstance(state.get('generation'), str)):
            raise ValueError('invalid_restart_budget')
        return state

    def save(self, state):
        write_snapshot(self.path, state)
        # Persist the reservation before sending any process signal.
        with self.path.open('rb') as file:
            os.fsync(file.fileno())
        directory = os.open(str(self.path.parent), os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def inspect(self, debug_healthy, monitoring_healthy, now):
        with self.locked():
            state = self.load()
            if self.generation != state['generation']:
                self.healthy_since = None
                self.generation = state['generation']
            changed = False
            if debug_healthy and not state['verified']:
                state['verified'] = True
                changed = True
            if monitoring_healthy:
                if self.healthy_since is None:
                    self.healthy_since = now
                if state['used'] and now - self.healthy_since >= HEALTH_RESET_SECONDS:
                    state['used'] = 0
                    state['generation'] = uuid.uuid4().hex
                    self.generation = state['generation']
                    self.healthy_since = now
                    changed = True
            else:
                self.healthy_since = None
            if changed:
                self.save(state)
            return self.summary(state)

    @staticmethod
    def summary(state):
        return {'debugging_previously_verified': state['verified'], 'restarts_used': state['used'],
                'restart_limit': RESTART_LIMIT, 'exhausted': state['used'] >= RESTART_LIMIT}

    def reserve(self):
        with self.locked():
            state = self.load()
            if not state['verified'] or state['used'] >= RESTART_LIMIT:
                return None
            state['used'] += 1
            self.healthy_since = None
            self.save(state)
            return self.summary(state)

    def reset(self):
        with self.locked():
            try:
                state = self.load()
            except (OSError, ValueError, TypeError):
                state = {'version': 1, 'verified': False}
            # Explicit reset never invents a previously working debugging connection.
            state.update(used=0, generation=uuid.uuid4().hex)
            self.save(state)
            return self.summary(state)


def watch(args):
    started = time.monotonic()
    failed_since = None
    failures = 0
    last_snapshot = None
    state_path = getattr(args, 'state', None) or str(pathlib.Path(args.output).with_name('observer-state.json'))
    budget = RestartBudget(state_path)
    while True:
        try:
            os.kill(args.pid, 0)
        except ProcessLookupError:
            return
        try:
            snapshot = probe(args.profile, args.url)
            last_snapshot = snapshot
            healthy = debug_health(snapshot)
            data = {'observer_at': int(time.time() * 1000), 'responsive': True, 'snapshot': snapshot}
        except (OSError, ValueError, KeyError, TypeError):
            healthy = False
            data = {'observer_at': int(time.time() * 1000), 'responsive': False, 'reason': 'page_probe_failed', 'snapshot': last_snapshot}
        if healthy:
            failed_since = None
            failures = 0
        else:
            failures += 1
            if failed_since is None:
                failed_since = time.monotonic()
        try:
            recovery = budget.inspect(healthy, healthy and live_health(snapshot), time.monotonic())
        except (OSError, ValueError, TypeError):
            # Lost/corrupt/unwritable state must disable recovery, not replenish it.
            recovery = {'debugging_previously_verified': False, 'restarts_used': None,
                        'restart_limit': RESTART_LIMIT, 'exhausted': True, 'state_error': True}
        data['recovery'] = recovery
        data['consecutive_failures'] = failures
        eligible = not healthy and failures >= 6 and time.monotonic() - started >= 90 and time.monotonic() - failed_since >= 60
        should_restart = False
        if eligible and recovery['debugging_previously_verified'] and not recovery['exhausted']:
            try:
                reservation = budget.reserve()
                if reservation is not None:
                    data['recovery'] = reservation
                    should_restart = True
            except (OSError, ValueError, TypeError):
                data['recovery']['state_error'] = True
        if should_restart:
            data['action'] = 'restart_unresponsive_browser'
        elif recovery.get('state_error') or data['recovery'].get('state_error'):
            data['action'] = 'restart_state_unavailable'
        elif not healthy and not recovery['debugging_previously_verified']:
            data['action'] = 'diagnostics_unavailable'
        elif not healthy and recovery['exhausted']:
            data['action'] = 'restart_budget_exhausted'
        else:
            data['action'] = 'observe'
        write_snapshot(args.output, data)
        if should_restart:
            os.kill(args.pid, signal.SIGTERM)
            for _ in range(10):
                time.sleep(1)
                try:
                    os.kill(args.pid, 0)
                except ProcessLookupError:
                    return
            os.kill(args.pid, signal.SIGKILL)
            return
        time.sleep(10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['watch', 'status', 'reset-budget'])
    parser.add_argument('--profile')
    parser.add_argument('--url')
    parser.add_argument('--pid', type=int)
    parser.add_argument('--output', default=str(pathlib.Path.home() / '.config/quietspace-kiosk/health.json'))
    parser.add_argument('--state', help='Private restart-budget file; defaults beside health.json')
    args = parser.parse_args()
    if args.command == 'status':
        print(json.dumps(json.loads(pathlib.Path(args.output).read_text()), indent=2))
    elif args.command == 'reset-budget':
        state_path = args.state or str(pathlib.Path(args.output).with_name('observer-state.json'))
        print(json.dumps({'action': 'restart_budget_reset', **RestartBudget(state_path).reset()}, indent=2))
    else:
        if not args.profile or not args.url or not args.pid:
            parser.error('watch requires --profile, --url and --pid')
        watch(args)


if __name__ == '__main__':
    main()
