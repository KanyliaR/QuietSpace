const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, db } = require('../server');
const { dispatch } = require('./test-helper');

const mockDevice = { id: 1, room_id: 1, monitoring_enabled: true };
const mockUser = { id: 1, username: 'admin', role: 'admin' };

let originalQuery;

beforeEach(() => {
  originalQuery = db.query;
});

afterEach(() => {
  db.query = originalQuery;
});

test('POST /api/readings returns 401 when device authentication is missing', async () => {
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/readings',
    body: {
      room_id: 1,
      level: 12.5,
      quiet_score: 'Warning',
      status_color: 'yellow'
    }
  });

  assert.equal(res.status, 401);
});

test('POST /api/readings returns 400 if room_id is missing', async () => {
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/readings',
    device: mockDevice,
    body: {
      level: 12.5,
      quiet_score: 'Warning',
      status_color: 'yellow'
    }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /room_id, level, quiet_score, and status_color are required/i);
});

test('POST /api/readings returns 400 if level is missing', async () => {
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/readings',
    device: mockDevice,
    body: {
      room_id: 1,
      quiet_score: 'Warning',
      status_color: 'yellow'
    }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /room_id, level, quiet_score, and status_color are required/i);
});

test('POST /api/readings returns 400 if quiet_score is missing', async () => {
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/readings',
    device: mockDevice,
    body: {
      room_id: 1,
      level: 12.5,
      status_color: 'yellow'
    }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /room_id, level, quiet_score, and status_color are required/i);
});

test('POST /api/readings returns 400 if status_color is missing', async () => {
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/readings',
    device: mockDevice,
    body: {
      room_id: 1,
      level: 12.5,
      quiet_score: 'Warning'
    }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /room_id, level, quiet_score, and status_color are required/i);
});

test('POST /api/readings returns 400 if status_color is invalid', async () => {
  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/readings',
    device: mockDevice,
    body: {
      room_id: 1,
      level: 12.5,
      quiet_score: 'Warning',
      status_color: 'purple'
    }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /invalid status color/i);
});

test('POST /api/readings returns 500 when database insertion fails', async () => {
  db.query = (sql, params, callback) => {
    if (typeof params === 'function') callback = params;
    callback(new Error('Disk full'), null);
  };

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/readings',
    device: mockDevice,
    body: {
      room_id: 1,
      level: 8.2,
      quiet_score: 'Quiet',
      status_color: 'green'
    }
  });

  assert.equal(res.status, 500);
  assert.match(res.body.message, /error saving reading/i);
});

test('POST /api/readings returns 201 with reading_id on success', async () => {
  let callCount = 0;
  db.query = (sql, params, callback) => {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    callCount++;
    if (callCount === 1) {
      assert.deepEqual(params, [1, 8.2, 'Quiet', 'green']);
      callback(null, { insertId: 101, affectedRows: 1 });
    } else {
      callback(null, { affectedRows: 1 });
    }
  };

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/readings',
    device: mockDevice,
    body: {
      room_id: 1,
      level: 8.2,
      quiet_score: 'Quiet',
      status_color: 'green'
    }
  });

  assert.equal(res.status, 201);
  assert.match(res.body.message, /reading saved successfully/i);
  assert.equal(res.body.reading_id, 101);
});

test('GET /api/readings/latest returns 401 when unauthenticated', async () => {
  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/readings/latest',
    user: null
  });

  assert.equal(res.status, 401);
});

test('GET /api/readings/latest returns 500 when database query fails', async () => {
  db.query = (sql, callback) => {
    callback(new Error('Connection timeout'), null);
  };

  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/readings/latest',
    user: mockUser
  });

  assert.equal(res.status, 500);
  assert.match(res.body.message, /error getting latest readings/i);
});

test('GET /api/readings/latest returns 200 with room readings on success', async () => {
  const mockReadings = [
    {
      room_id: 1,
      room_name: 'Room 311',
      level: '9.50',
      status_color: 'green',
      quiet_score: 'Quiet',
      recorded_at: '2026-10-22T01:15:00.000Z'
    },
    {
      room_id: 2,
      room_name: 'Room 312',
      level: null,
      status_color: null,
      quiet_score: null,
      recorded_at: null
    }
  ];

  db.query = (sql, callback) => {
    callback(null, mockReadings);
  };

  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/readings/latest',
    user: mockUser
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].room_id, 1);
  assert.equal(res.body[0].level, '9.50');
});
