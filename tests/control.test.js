const { test } = require('node:test');
const assert = require('node:assert/strict');
const Control = require('../webpages/device-control');
const { hashPassword, verifyPassword, digest } = require('../lib/passwords');
const fs = require('node:fs');
const vm = require('node:vm');

test('passwords use unique salted hashes and reject wrong credentials', async () => {
  const a = await hashPassword('quiet123'), b = await hashPassword('quiet123');
  assert.notEqual(a, b); assert.ok(!a.includes('quiet123'));
  assert.equal(await verifyPassword('quiet123', a), true);
  assert.equal(await verifyPassword('incorrect', a), false);
  assert.equal(await verifyPassword('quiet123', 'invalid'), false);
  assert.equal(digest('token').length, 64);
});

test('simulated microphone stops tracks/processing, resumes, and fails closed', async () => {
  let enabled = true, available = true, room = 1, now = 10000;
  let capturing = false, processing = false, stopped = 0;
  const track = { stop() { capturing = false; stopped++; } };
  const control = new Control({ roomId: 1, now: () => now,
    getConfig: async () => { if (!available) throw Error('offline'); return { room_id: room, monitoring_enabled: enabled }; },
    stop: () => { track.stop(); processing = false; },
    resume: async () => { capturing = true; processing = true; }, onState: () => {} });
  assert.equal(control.allowed(), false);
  await control.check(); assert.equal(capturing, true); assert.equal(processing, true);
  enabled = false; await control.check();
  assert.equal(capturing, false); assert.equal(processing, false); assert.ok(stopped);
  enabled = true; await control.check(); assert.equal(capturing, true);
  available = false; await control.check(); assert.equal(capturing, false);
  available = true; await control.check(); now += 5001;
  assert.equal(control.allowed(), false); control.deny(); assert.equal(processing, false);
  room = 2; await control.check(); assert.equal(capturing, false);
});

test('all page inline JavaScript and shared scripts parse', () => {
  for (const file of fs.readdirSync('webpages').filter(name => name.endsWith('.html'))) {
    const source = fs.readFileSync('webpages/' + file, 'utf8');
    for (const [index, match] of [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
      new vm.Script(match[1], { filename: `${file}:script${index}` });
    }
  }
  for (const file of fs.readdirSync('webpages').filter(name => name.endsWith('.js'))) {
    new vm.Script(fs.readFileSync('webpages/' + file, 'utf8'), { filename: file });
  }
});

test('existing RMS, warning and red timers are retained', () => {
  const source = fs.readFileSync('webpages/index.html', 'utf8');
  assert.match(source, /Math\.sqrt\(/);
  assert.match(source, /YELLOW_MIN_HOLD_MS = 14000/);
  assert.match(source, /RED_TIME = 2 \* 60 \* 1000/);
  assert.match(source, /SLIDING_WINDOW_MS = 3000/);

});

test('actual room display script stops microphone tracks and AudioContext, then resumes without changing timers', async () => {
  const source = fs.readFileSync('webpages/index.html', 'utf8');
  const script = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].at(-1)[1];
  let enabled = 1, online = true, stops = 0, closes = 0, captures = 0;
  const requests = [];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { addEventListener() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, textContent: '' });
    return elements.get(id);
  };
  const callbacks = [];
  const context = {
    console, URL, URLSearchParams, Headers, AbortSignal, Uint8Array, crypto: globalThis.crypto, QuietSpaceRoomDeviceSession: require('../webpages/room-device-session'), QuietSpaceDeviceControl: Control, QuietSpaceMonitoringEvents: require('../webpages/monitoring-events'),
    location: { href: 'http://localhost:3000/?room_id=1', origin: 'http://localhost:3000', search: '?room_id=1' },
    sessionStorage: { getItem: () => 'a'.repeat(64), setItem() {} },
    localStorage: { getItem: () => null },
    document: { body: { style: {}, dataset:{}, classList:{add(){},remove(){},toggle(){}} }, getElementById: element, querySelector: element },
    navigator: { mediaDevices: { getUserMedia: async () => { captures++; return { getTracks: () => [{ stop() { stops++; } }] }; } } },
    setTimeout,
    setInterval: callback => { callbacks.push(callback); return callbacks.length; }, clearInterval() {},
    requestAnimationFrame() {}, alert: message => { throw Error(message); }, prompt: () => '',
    fetch: async (url, options = {}) => {
      requests.push(String(url));
      if (!online) throw Error('offline');
      return { ok: true, json: async () => String(url).includes('/api/device/config')
        ? { room_id: 1, room_name:'Room 232', monitoring_enabled: enabled, yellowThreshold: 12, redThreshold: 22 }
        : { incident_id: 1 } };
    },
    AudioContext: class {
      state = 'running';
      createAnalyser() { return { fftSize: 2048, getByteTimeDomainData(data) { data.fill(128); } }; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      async close() { closes++; this.state = 'closed'; }
    },
    addEventListener() {}
  };
  context.window = context;
  vm.createContext(context); vm.runInContext(script, context);vm.runInContext('resumeMicrophone=false',context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('getStateFromLevel(11)', context), 'green');
  assert.equal(vm.runInContext('getStateFromLevel(12)', context), 'yellow');
  assert.equal(vm.runInContext('getStateFromLevel(22)', context), 'red');
  const beforePreview=requests.length;
  const liveState=vm.runInContext('currentState',context);
  for(const expected of ['WARNING','TOO LOUD','MONITORING DISABLED','QUIET','WARNING','TOO LOUD','MONITORING DISABLED','QUIET']) {
    vm.runInContext('runPresentationDemo()',context);
    assert.equal(element('statusText').textContent,expected);
  }
  await vm.runInContext('monitoringEvents.tail',context);
  assert.equal(requests.length,beforePreview,'Preview must not make backend requests');
  assert.equal(captures,0,'Preview must not open the microphone');
  assert.equal(vm.runInContext('currentState',context),liveState);
  assert.equal(vm.runInContext('redLockActive',context),false);
  enabled=0;await vm.runInContext('deviceControl.check()',context);
  vm.runInContext('runPresentationDemo()',context);
  assert.equal(element('statusText').textContent,'MONITORING DISABLED');
  await vm.runInContext('deviceControl.check()',context);
  vm.runInContext('deviceControl.deny()',context);
  assert.equal(element('statusText').textContent,'MONITORING DISABLED','Watchdog must retain the authenticated administrative pause');
  assert.equal(vm.runInContext('deviceSession.authenticated',context),true);
  enabled=1;await vm.runInContext('deviceControl.check()',context);
  assert.equal(captures,0);stops=0;closes=0;
  await vm.runInContext('startMonitoring()', context);
  assert.equal(captures, 1); assert.equal(vm.runInContext('isMonitoring', context), true);
  assert.throws(()=>vm.runInContext('runPresentationDemo()',context),/Live microphone monitoring is running/);
  vm.runInContext('setState("red")', context); await vm.runInContext('monitoringEvents.tail',context);
  const start=requests.length;
  vm.runInContext('setState("yellow")', context); await vm.runInContext('monitoringEvents.tail',context);
  assert.ok(!requests.slice(start).some(path=>path.includes('/incidents/resolve')),'Red to yellow must not resolve the incident');
  vm.runInContext('setState("green")',context); await vm.runInContext('monitoringEvents.tail',context);
  assert.ok(requests.slice(start).some(path=>path.includes('/incidents/resolve')),'Green resolves the incident');
  enabled = 0; await vm.runInContext('deviceControl.check()', context);
  assert.equal(stops, 1); assert.equal(closes, 1);
  assert.equal(vm.runInContext('isMonitoring', context), false);
  assert.equal(vm.runInContext('analyser', context), null);
  assert.equal(element('statusText').textContent, 'MONITORING DISABLED');
  enabled = 1; await vm.runInContext('deviceControl.check()', context);
  assert.equal(captures, 2); assert.equal(vm.runInContext('isMonitoring', context), true);
  online = false; await vm.runInContext('deviceControl.check()', context);
  assert.equal(stops, 2); assert.equal(closes, 2);
  assert.equal(vm.runInContext('isMonitoring', context), false);
});

test('evidence dates follow the library calendar at midnight and DST boundaries', () => {
  const { libraryDay } = require('../lib/report-data');
  assert.equal(libraryDay('2026-11-16T04:59:59Z'), '2026-11-15');
  assert.equal(libraryDay('2026-11-16T05:00:00Z'), '2026-11-16');
  assert.equal(libraryDay('2026-11-01T05:30:00Z'), '2026-11-01');
  assert.equal(libraryDay('2026-11-01T06:30:00Z'), '2026-11-01');
});

test('device event commands preserve ordering and reuse the request ID on network retry', async () => {
  const Queue = require('../webpages/monitoring-events');
  let calls = 0, ids = 0; const observed = [];
  const queue = new Queue(async (path, body) => {
    observed.push([path, body.request_id]);
    if (++calls === 1) throw Error('response lost');
    return { ok: true };
  }, { makeId: () => 'event-' + (++ids), pause: async () => {} });
  await Promise.all([queue.enqueue('yellow', {}), queue.enqueue('red', {})]);
  assert.deepEqual(observed, [['yellow','event-1'],['yellow','event-1'],['red','event-2']]);
});

test('legacy testing inference respects the cycle threshold and never claims a timestamp or overrides new recordings', () => {
  const { incidentAlerts } = require('../lib/incident-alerts');
  assert.equal(incidentAlerts({escalation_count:2}).legacy_staff_alert_inferred,false);
  const old=incidentAlerts({escalation_count:3});
  assert.equal(old.legacy_staff_alert_inferred,true);assert.equal(old.staff_alert_triggered,null);
  assert.equal(old.staff_alert_display_inferred,true);assert.equal(old.legacy_alert_inference.occurred_at,null);
  const current=incidentAlerts({escalation_count:4,tracking_started_at:new Date(),recorded_staff_alert:1});
  assert.equal(current.staff_alert_triggered,true);assert.equal(current.legacy_staff_alert_inferred,false);assert.equal(current.staff_alert_display_inferred,false);
  const receipt=incidentAlerts({escalation_count:3,recorded_staff_display:1});
  assert.equal(receipt.staff_alert_displayed,true);assert.equal(receipt.legacy_staff_alert_inferred,false);assert.equal(receipt.staff_alert_display_inferred,false);
});


test('origin checks recognize local HTTPS tunnels without trusting remote forwarding or overriding configuration', () => {
  const { expectedOrigin } = require('../lib/access');
  const request = (peer, forwarded) => ({ protocol: 'http', socket: { remoteAddress: peer }, get: name => ({ host: 'example.trycloudflare.com', 'x-forwarded-proto': forwarded })[name] });
  assert.equal(expectedOrigin(request('127.0.0.1','https'), ''), 'https://example.trycloudflare.com');
  assert.equal(expectedOrigin(request('::1','https'), ''), 'https://example.trycloudflare.com');
  assert.equal(expectedOrigin(request('::ffff:127.0.0.1','https'), ''), 'https://example.trycloudflare.com');
  assert.equal(expectedOrigin(request('192.168.1.2','https'), ''), 'http://example.trycloudflare.com');
  assert.equal(expectedOrigin(request('127.0.0.1',undefined), ''), 'http://example.trycloudflare.com');
  assert.equal(expectedOrigin(request('127.0.0.1','https, http'), ''), 'http://example.trycloudflare.com');
  assert.equal(expectedOrigin(request('127.0.0.1','https'), 'https://configured.example'), 'https://configured.example');
});
