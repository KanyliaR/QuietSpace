const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, db } = require('../server');
const { dispatch, installMockDb } = require('./test-helper');

const mockUser = { id: 1, username: 'admin', role: 'admin' };
const mockDevice = { id: 1, room_id: 1, monitoring_enabled: true };
let uninstallMock;

beforeEach(() => {
  if (uninstallMock) uninstallMock();
});

afterEach(() => {
  if (uninstallMock) uninstallMock();
});

function defaultQueryHandler(sql, params) {
  if (typeof sql !== 'string') return [];
  if (sql.includes('SELECT monitoring_enabled FROM rooms')) return [{ monitoring_enabled: 1 }];
  if (sql.includes('SELECT * FROM room_activity_state')) return [{ room_id: 1, status_color: 'red', episode_key: 'ep-1', observed: 1 }];
  if (sql.includes('SELECT id,escalation_count,tracking_started_at FROM incidents')) {
    return [{ id: 55, escalation_count: 1, tracking_started_at: true }];
  }
  if (sql.includes('INSERT INTO incidents')) return { insertId: 56, affectedRows: 1 };
  if (sql.includes('UPDATE incidents')) return { affectedRows: 1 };
  if (sql.includes('UPDATE room_activity_state')) return { affectedRows: 1 };
  if (sql.includes('INSERT INTO incident_activity')) return { affectedRows: 1 };
  if (sql.includes('INSERT INTO report_notification_events')) return { affectedRows: 1 };
  if (sql.includes('SELECT response_json')) return [];
  if (sql.includes('INSERT INTO monitoring_commands')) return { affectedRows: 1 };
  if (sql.includes('SELECT (EXISTS')) return [{ recorded: 1 }];
  if (sql.includes('SELECT id FROM incident_activity')) return [{ id: 1 }];
  return [];
}

test('GET /api/incidents returns 401 when unauthenticated', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/incidents',
    user: null
  });

  assert.equal(res.status, 401);
});

test('GET /api/incidents returns 500 when database query fails', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('FROM incidents') || sql.includes('incidents i')) throw new Error('Database error');
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/incidents',
    user: mockUser
  });

  assert.equal(res.status, 500);
  assert.match(res.body.message, /error getting incidents/i);
});

test('GET /api/incidents formats timer_remaining correctly for active and resolved incidents', async () => {
  const now = Date.now();
  const mockIncidents = [
    {
      id: 1,
      room_name: 'Room 311',
      status: 'open',
      escalation_count: 1,
      started_at: new Date(now - 30000).toISOString(),
      resolved_at: null,
      timer_started_at: new Date(now - 30000).toISOString() // 30 sec elapsed -> ~1:30 remaining
    },
    {
      id: 2,
      room_name: 'Room 312',
      status: 'resolved',
      escalation_count: 2,
      started_at: new Date(now - 120000).toISOString(),
      resolved_at: new Date(now - 60000).toISOString(),
      timer_started_at: new Date(now - 120000).toISOString()
    },
    {
      id: 3,
      room_name: 'Room 313',
      status: 'open',
      escalation_count: 3,
      started_at: new Date(now - 150000).toISOString(),
      resolved_at: null,
      timer_started_at: new Date(now - 150000).toISOString() // > 2 min elapsed -> 0:00 remaining
    }
  ];

  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('FROM incidents') || sql.includes('incidents i')) return mockIncidents;
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/incidents',
    user: mockUser
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 3);

  // Incident 1: open with ~90 seconds left
  assert.match(res.body[0].timer_remaining, /1:\d{2} remaining/);

  // Incident 2: resolved -> "Completed"
  assert.equal(res.body[1].timer_remaining, 'Completed');

  // Incident 3: expired open -> "0:00 remaining"
  assert.equal(res.body[2].timer_remaining, '0:00 remaining');
});

test('POST /api/incidents/start returns 401 without device authentication', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/start',
    body: { room_id: 1, trigger_level: 'red' }
  });

  assert.equal(res.status, 401);
});

test('POST /api/incidents/start returns 400 if room_id is missing', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/start',
    device: mockDevice,
    body: { trigger_level: 'red' }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /room_id/i);
});

test('POST /api/incidents/start returns 400 if trigger_level is missing', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/start',
    device: mockDevice,
    body: { room_id: 1 }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /trigger_level/i);
});

test('POST /api/incidents/start returns 500 when check existing query fails', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('SELECT monitoring_enabled FROM rooms')) return [{ monitoring_enabled: 1 }];
    if (sql.includes('SELECT id,escalation_count')) throw new Error('Check error');
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/start',
    device: mockDevice,
    body: { room_id: 1, trigger_level: 'red' }
  });

  assert.equal(res.status, 500);
});

test('POST /api/incidents/start returns 200 with existing incident_id if incident is already open', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('SELECT id,escalation_count')) {
      return [{ id: 55, escalation_count: 1, tracking_started_at: true }];
    }
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/start',
    device: mockDevice,
    body: { room_id: 1, trigger_level: 'red' }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.incident_id, 55);
  assert.equal(res.body.created, false);
});

test('POST /api/incidents/start returns 201 with new incident_id when starting new incident', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('SELECT id,escalation_count')) {
      return []; // no open incident
    }
    if (sql.includes('INSERT INTO incidents')) {
      return { insertId: 56, affectedRows: 1 };
    }
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/start',
    device: mockDevice,
    body: { room_id: 1, trigger_level: 'red' }
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.incident_id, 56);
  assert.equal(res.body.created, true);
});

test('POST /api/incidents/resolve returns 400 if room_id is missing', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/resolve',
    device: mockDevice,
    body: {}
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /room_id/i);
});

test('POST /api/incidents/resolve returns 500 if database error occurs', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('UPDATE incidents')) throw new Error('Update failed');
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/resolve',
    device: mockDevice,
    body: { room_id: 1 }
  });

  assert.equal(res.status, 500);
});

test('POST /api/incidents/resolve returns 200 with changed rows count on success', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('SELECT id,escalation_count')) {
      return [{ id: 55, escalation_count: 1, tracking_started_at: true }];
    }
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/resolve',
    device: mockDevice,
    body: { room_id: 1 }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 1);
  assert.equal(res.body.incident_id, 55);
});

test('POST /api/incidents/escalate returns 400 if room_id is missing', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/escalate',
    device: mockDevice,
    body: {}
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /room_id/i);
});

test('POST /api/incidents/escalate returns 500 if database error occurs', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('UPDATE incidents SET escalation_count')) throw new Error('Escalation failed');
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/escalate',
    device: mockDevice,
    body: { room_id: 1 }
  });

  assert.equal(res.status, 500);
});

test('POST /api/incidents/escalate returns 200 with changed rows count on success', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('SELECT id,escalation_count')) {
      return [{ id: 55, escalation_count: 1, tracking_started_at: true }];
    }
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/escalate',
    device: mockDevice,
    body: { room_id: 1 }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 1);
});

test('POST /api/incidents/escalate handles multiple sequential escalations', async () => {
  let escalationCount = 1;
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('SELECT id,escalation_count')) {
      return [{ id: 55, escalation_count: escalationCount, tracking_started_at: true }];
    }
    if (sql.includes('UPDATE incidents SET escalation_count')) {
      escalationCount++;
      return { affectedRows: 1 };
    }
    return defaultQueryHandler(sql);
  });

  const res1 = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/escalate',
    device: mockDevice,
    body: { room_id: 1 }
  });
  assert.equal(res1.status, 200);

  const res2 = await dispatch(app, {
    method: 'POST',
    url: '/api/incidents/escalate',
    device: mockDevice,
    body: { room_id: 1 }
  });
  assert.equal(res2.status, 200);
  assert.equal(escalationCount, 3);
});
