const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, db, broadcastSSE, sseClients } = require('../server');
const { dispatch, installMockDb } = require('./test-helper');

const mockUser = { id: 1, username: 'admin', role: 'admin' };
const mockDevice = { id: 1, room_id: 1, monitoring_enabled: true };
let uninstallMock;

beforeEach(() => {
  if (uninstallMock) uninstallMock();
  sseClients.clear();
});

afterEach(() => {
  if (uninstallMock) uninstallMock();
  sseClients.clear();
});

function defaultQueryHandler(sql) {
  if (typeof sql !== 'string') return [];
  if (sql.includes('SELECT monitoring_enabled FROM rooms')) return [{ monitoring_enabled: 1 }];
  if (sql.includes('SELECT * FROM room_activity_state')) return [{ room_id: 1, status_color: 'red', episode_key: 'ep-1', observed: 1 }];
  if (sql.includes('SELECT id,escalation_count')) return [{ id: 12, escalation_count: 1, tracking_started_at: true }];
  if (sql.includes('INSERT INTO incidents')) return { insertId: 12, affectedRows: 1 };
  if (sql.includes('UPDATE incidents')) return { affectedRows: 1 };
  if (sql.includes('UPDATE room_activity_state')) return { affectedRows: 1 };
  if (sql.includes('INSERT INTO incident_activity')) return { affectedRows: 1 };
  if (sql.includes('INSERT INTO report_notification_events')) return { affectedRows: 1 };
  if (sql.includes('INSERT INTO monitoring_commands')) return { affectedRows: 1 };
  if (sql.includes('SELECT (EXISTS')) return [{ recorded: 1 }];
  if (sql.includes('SELECT id FROM incident_activity')) return [{ id: 1 }];
  if (sql.includes('UPDATE staff_sessions')) return { affectedRows: 1 };
  return [];
}

test('GET /api/events sets text/event-stream headers and connects authenticated staff', async () => {
  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/events',
    user: mockUser
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.ok(res.headers['cache-control'].includes('no-cache'));
  assert.equal(res.headers['connection'], 'keep-alive');
  assert.ok(res.text.includes(': connected'));
});

test('broadcastSSE broadcasts payload to all connected clients', () => {
  let client1Buffer = '';
  let client2Buffer = '';

  const client1 = { write: (msg) => { client1Buffer += msg; } };
  const client2 = { write: (msg) => { client2Buffer += msg; } };

  sseClients.add(client1);
  sseClients.add(client2);

  assert.equal(sseClients.size, 2);

  broadcastSSE('test_broadcast', { room_id: 101, status: 'alert' });

  assert.ok(client1Buffer.includes('event: test_broadcast'));
  assert.ok(client1Buffer.includes('"room_id":101'));
  assert.ok(client1Buffer.includes('"status":"alert"'));

  assert.ok(client2Buffer.includes('event: test_broadcast'));
  assert.ok(client2Buffer.includes('"room_id":101'));
  assert.ok(client2Buffer.includes('"status":"alert"'));
});

test('broadcastSSE removes broken clients when client.write throws an error', () => {
  let healthyCalled = false;
  const brokenClient = {
    write: () => {
      throw new Error('Client socket closed unexpectedly');
    }
  };
  const healthyClient = {
    write: () => {
      healthyCalled = true;
    }
  };

  sseClients.add(brokenClient);
  sseClients.add(healthyClient);

  assert.equal(sseClients.size, 2);

  broadcastSSE('ping', { time: Date.now() });

  assert.equal(healthyCalled, true);
  assert.equal(sseClients.has(brokenClient), false);
  assert.equal(sseClients.has(healthyClient), true);
  assert.equal(sseClients.size, 1);
});

test("broadcasts 'reading' event to SSE stream when new reading is recorded", async () => {
  let received = '';
  const client = { write: (msg) => { received += msg; } };
  sseClients.add(client);

  broadcastSSE('reading', {
    room_id: 2,
    level: 18,
    quiet_score: 'Too Loud',
    status_color: 'red'
  });

  assert.ok(received.includes('event: reading'));
  assert.ok(received.includes('"room_id":2'));
  assert.ok(received.includes('"level":18'));
  assert.ok(received.includes('"status_color":"red"'));
  assert.ok(received.includes('"quiet_score":"Too Loud"'));
});

test("broadcasts 'report_created' event to SSE stream when report is submitted", async () => {
  let received = '';
  const client = { write: (msg) => { received += msg; } };
  sseClients.add(client);

  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('SELECT id FROM rooms')) return [{ id: 1 }];
    if (sql.includes('INSERT INTO noise_reports')) return { insertId: 99, affectedRows: 1 };
    if (sql.includes('SELECT room_id FROM noise_reports')) return [{ room_id: 1 }];
    if (sql.includes('SELECT room_name FROM rooms')) return [{ room_name: 'Room 311' }];
    if (sql.includes('INSERT INTO noise_report_activity')) return { affectedRows: 1 };
    if (sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
    if (sql.includes('INSERT INTO report_notification_events')) return { affectedRows: 1 };
    return [];
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/reports',
    body: {
      room_id: 1,
      noise_type: 'screaming',
      severity: 'high',
      comments: 'Disturbing floor'
    }
  });

  assert.equal(res.status, 201);
  assert.ok(received.includes('event: report-created'));
});

test('broadcasts incident events (started, escalated, resolved) over SSE', async () => {
  let received = '';
  const client = { write: (msg) => { received += msg; } };
  sseClients.add(client);

  uninstallMock = installMockDb(db, defaultQueryHandler);

  // 1. Start incident
  const startRes = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/start',
    device: mockDevice,
    body: { room_id: 1, trigger_level: 'red' }
  });
  assert.equal(startRes.status, 200);
  assert.ok(received.includes('activity-update'));

  // 2. Escalate incident
  received = '';
  const escalateRes = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/escalate',
    device: mockDevice,
    body: { room_id: 1 }
  });
  assert.equal(escalateRes.status, 200);
  assert.ok(received.includes('activity-update'));

  // 3. Resolve incident
  received = '';
  const resolveRes = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/resolve',
    device: mockDevice,
    body: { room_id: 1 }
  });
  assert.equal(resolveRes.status, 200);
  assert.ok(received.includes('activity-update'));
});

test("broadcasts 'room_created' and 'room_updated' events over SSE", async () => {
  let received = '';
  const client = { write: (msg) => { received += msg; } };
  sseClients.add(client);

  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('INSERT INTO rooms')) return { insertId: 5, affectedRows: 1 };
    if (sql.includes('UPDATE rooms SET is_active')) return { affectedRows: 1 };
    if (sql.includes('SELECT id, room_name')) {
      return [{ id: 5, room_name: 'Room 315', location: '3rd Floor', is_active: 0 }];
    }
    return defaultQueryHandler(sql);
  });

  // 1. Create Room -> broadcasts room_created
  const postRes = await dispatch(app, {
    method: 'POST',
    url: '/api/rooms',
    user: mockUser,
    body: { room_name: 'Room 315', location: '3rd Floor' }
  });
  assert.equal(postRes.status, 201);
  assert.ok(received.includes('event: room_created'));
  assert.ok(received.includes('"room_name":"Room 315"'));

  // 2. Toggle Room -> broadcasts room_updated
  received = '';
  const toggleRes = await dispatch(app, {
    method: 'PATCH',
    url: '/api/rooms/5/toggle',
    user: mockUser
  });
  assert.equal(toggleRes.status, 200);
  assert.ok(received.includes('event: room_updated'));
  assert.ok(received.includes('"room_id":5'));
  assert.ok(received.includes('"is_active":0'));
});
