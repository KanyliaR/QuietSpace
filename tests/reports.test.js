const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, db } = require('../server');
const { dispatch, installMockDb } = require('./test-helper');

const mockUser = { id: 1, username: 'admin', role: 'admin' };
let uninstallMock;

beforeEach(() => {
  if (uninstallMock) uninstallMock();
});

afterEach(() => {
  if (uninstallMock) uninstallMock();
});

function defaultQueryHandler(sql, params) {
  if (typeof sql !== 'string') return [];
  if (sql.includes('SELECT id FROM rooms')) return [{ id: 1 }];
  if (sql.includes('INSERT INTO noise_reports')) return { insertId: 42, affectedRows: 1 };
  if (sql.includes('SELECT room_id FROM noise_reports')) return [{ room_id: 1 }];
  if (sql.includes('SELECT room_name FROM rooms')) return [{ room_name: 'Room 311' }];
  if (sql.includes('SELECT id,name,role FROM staff_users')) return [{ id: 1, name: 'Admin', role: 'admin' }];
  if (sql.includes('SELECT report_status')) {
    return [{ report_status: 'open', resolved_at: null, resolution_method: null, submitted_at: new Date() }];
  }
  if (sql.includes('UPDATE noise_reports')) return { affectedRows: 1 };
  if (sql.includes('INSERT INTO noise_report_activity')) return { affectedRows: 1 };
  if (sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
  if (sql.includes('INSERT INTO report_notification_events')) return { affectedRows: 1 };
  if (sql.includes('SELECT security_policy')) return [{ security_policy: null }];
  return [];
}

test('POST /api/reports returns 400 if room_id is missing', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/reports',
    body: { noise_type: 'talking', severity: 'medium' }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /room_id/i);
});

test('POST /api/reports returns 400 if noise_type is missing', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/reports',
    body: { room_id: 1, severity: 'medium' }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /noise_type/i);
});

test('POST /api/reports returns 400 if severity is missing', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/reports',
    body: { room_id: 1, noise_type: 'talking' }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /severity/i);
});

test('POST /api/reports returns 400 if severity is invalid', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/reports',
    body: { room_id: 1, noise_type: 'talking', severity: 'extreme' }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /severity/i);
});

test('POST /api/reports returns 500 when database insertion fails', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('SELECT id FROM rooms')) return [{ id: 1 }];
    if (sql.includes('INSERT INTO noise_reports')) throw new Error('Database write error');
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/reports',
    body: { room_id: 1, noise_type: 'screaming', severity: 'high', comments: 'Very loud' }
  });

  assert.equal(res.status, 500);
});

test('POST /api/reports returns 201 and report_id on successful submission', async () => {
  let insertParams = null;
  uninstallMock = installMockDb(db, (sql, params) => {
    if (sql.includes('INSERT INTO noise_reports')) {
      insertParams = params;
      return { insertId: 42, affectedRows: 1 };
    }
    return defaultQueryHandler(sql, params);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/reports',
    body: {
      room_id: 1,
      noise_type: 'loud_music',
      severity: 'high',
      comments: 'Bass shaking walls'
    }
  });

  assert.equal(res.status, 201);
  assert.match(res.body.message, /report submitted successfully/i);
  assert.equal(res.body.report_id, 42);
  assert.deepEqual(insertParams, [1, 'loud_music', 'high', 'Bass shaking walls']);
});

test('POST /api/reports defaults comments to null if omitted', async () => {
  let capturedComments = 'NOT_SET';
  uninstallMock = installMockDb(db, (sql, params) => {
    if (sql.includes('INSERT INTO noise_reports')) {
      capturedComments = params[3];
      return { insertId: 43, affectedRows: 1 };
    }
    return defaultQueryHandler(sql, params);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/reports',
    body: {
      room_id: 2,
      noise_type: 'whispering',
      severity: 'low'
    }
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.report_id, 43);
  assert.equal(capturedComments, null);
});

test('GET /api/reports returns 401 when unauthenticated', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/reports',
    user: null
  });

  assert.equal(res.status, 401);
});

test('GET /api/reports returns 500 when database query fails', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('FROM noise_reports')) throw new Error('Database connection lost');
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/reports',
    user: mockUser
  });

  assert.equal(res.status, 500);
  assert.match(res.body.message, /error getting reports/i);
});

test('GET /api/reports returns 200 with list of reports on success', async () => {
  const mockReports = [
    {
      id: 1,
      room_name: 'Room 311',
      noise_type: 'talking',
      severity: 'medium',
      comments: 'Group study',
      report_status: 'open',
      submitted_at: '2026-10-22T01:00:00.000Z'
    }
  ];

  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('FROM noise_reports') || sql.includes('noise_reports nr')) return mockReports;
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/reports',
    user: mockUser
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].room_name, 'Room 311');
});

test('PUT /api/reports/:id/status returns 400 for invalid report status', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);
  const res = await dispatch(app, {
    method: 'PUT',
    url: '/api/reports/1/status',
    user: mockUser,
    body: { report_status: 'invalid_status' }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /invalid report status/i);
});

test('PUT /api/reports/:id/status returns 404 when target report ID does not exist', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('SELECT report_status')) return [];
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'PUT',
    url: '/api/reports/999/status',
    user: mockUser,
    body: { report_status: 'resolved' }
  });

  assert.equal(res.status, 404);
  assert.match(res.body.message, /report not found/i);
});

test('PUT /api/reports/:id/status returns 500 when database update fails', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('UPDATE noise_reports')) throw new Error('DB error');
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'PUT',
    url: '/api/reports/1/status',
    user: mockUser,
    body: { report_status: 'in_review' }
  });

  assert.equal(res.status, 500);
});

test('PUT /api/reports/:id/status returns 200 and confirms update on success', async () => {
  let updateParams = null;
  uninstallMock = installMockDb(db, (sql, params) => {
    if (sql.includes('UPDATE noise_reports')) {
      updateParams = params;
      return { affectedRows: 1 };
    }
    return defaultQueryHandler(sql, params);
  });

  const res = await dispatch(app, {
    method: 'PUT',
    url: '/api/reports/1/status',
    user: mockUser,
    body: { report_status: 'resolved' }
  });

  assert.equal(res.status, 200);
  assert.match(res.body.message, /report status updated/i);
  assert.equal(res.body.changed, 1);
  assert.equal(updateParams[0], 'resolved');
  assert.equal(updateParams[3], '1');
});
