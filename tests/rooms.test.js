const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, db, sseClients } = require('../server');
const { dispatch, installMockDb } = require('./test-helper');

const mockUser = { id: 1, username: 'admin', role: 'admin' };
let uninstallMock;

beforeEach(() => {
  if (uninstallMock) uninstallMock();
  if (sseClients) sseClients.clear();
});

afterEach(() => {
  if (uninstallMock) uninstallMock();
  if (sseClients) sseClients.clear();
});

function defaultQueryHandler(sql, params) {
  if (typeof sql !== 'string') return [];
  if (sql.includes('UPDATE staff_sessions')) return { affectedRows: 1 };
  if (sql.includes('FROM rooms r')) {
    return [
      {
        id: 1,
        room_id: 1,
        room_name: 'Room 311',
        location: 'Bluford Library 3rd Floor',
        is_active: 1,
        yellow_threshold: 60,
        red_threshold: 75,
        created_at: '2026-10-24T20:00:00.000Z'
      }
    ];
  }
  return [];
}

test('GET /api/rooms returns 500 when database query fails', async () => {
  uninstallMock = installMockDb(db, () => {
    throw new Error('Database connection lost');
  });

  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/rooms',
    user: mockUser
  });

  assert.equal(res.status, 500);
  assert.match(res.body.message, /error getting rooms/i);
});

test('GET /api/rooms returns 200 with list of rooms including is_active status', async () => {
  const mockRooms = [
    {
      id: 1,
      room_id: 1,
      room_name: 'Room 311',
      location: 'Bluford Library 3rd Floor',
      is_active: 1,
      level: '9.50',
      status_color: 'green',
      quiet_score: 'Quiet',
      recorded_at: '2026-10-24T20:00:00.000Z'
    },
    {
      id: 2,
      room_id: 2,
      room_name: 'Room 312',
      location: 'Bluford Library 3rd Floor',
      is_active: 0,
      level: null,
      status_color: null,
      quiet_score: null,
      recorded_at: null
    }
  ];

  uninstallMock = installMockDb(db, () => mockRooms);

  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/rooms',
    user: mockUser
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].room_name, 'Room 311');
  assert.equal(res.body[0].is_active, 1);
  assert.equal(res.body[1].room_name, 'Room 312');
  assert.equal(res.body[1].is_active, 0);
});

test('GET /api/rooms/:id returns 404 when room does not exist', async () => {
  uninstallMock = installMockDb(db, () => []);

  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/rooms/999',
    user: mockUser
  });

  assert.equal(res.status, 404);
  assert.match(res.body.message, /room not found/i);
});

test('GET /api/rooms/:id returns 200 with room details when found', async () => {
  uninstallMock = installMockDb(db, () => [
    {
      id: 1,
      room_id: 1,
      room_name: 'Room 311',
      location: 'Bluford Library 3rd Floor',
      is_active: 1
    }
  ]);

  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/rooms/1',
    user: mockUser
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.room_name, 'Room 311');
  assert.equal(res.body.is_active, 1);
});

test('GET /api/rooms/:id returns 500 when database query fails', async () => {
  uninstallMock = installMockDb(db, () => {
    throw new Error('DB failure');
  });

  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/rooms/1',
    user: mockUser
  });

  assert.equal(res.status, 500);
  assert.match(res.body.message, /error getting room/i);
});

test('POST /api/rooms returns 400 if room_name is missing or empty', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);

  const res1 = await dispatch(app, {
    method: 'POST',
    url: '/api/rooms',
    user: mockUser,
    body: {}
  });
  assert.equal(res1.status, 400);
  assert.match(res1.body.message, /room_name is required/i);

  const res2 = await dispatch(app, {
    method: 'POST',
    url: '/api/rooms',
    user: mockUser,
    body: { room_name: '   ' }
  });
  assert.equal(res2.status, 400);
  assert.match(res2.body.message, /room_name is required/i);
});

test('POST /api/rooms returns 409 if room with same name already exists', async () => {
  uninstallMock = installMockDb(db, (sql, params) => {
    if (sql.includes('INSERT INTO rooms')) {
      const err = new Error('Duplicate entry');
      err.code = 'ER_DUP_ENTRY';
      throw err;
    }
    return defaultQueryHandler(sql, params);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/rooms',
    user: mockUser,
    body: { room_name: 'Room 311' }
  });

  assert.equal(res.status, 409);
  assert.match(res.body.message, /already exists/i);
});

test('POST /api/rooms returns 500 on database insertion error', async () => {
  uninstallMock = installMockDb(db, (sql, params) => {
    if (sql.includes('INSERT INTO rooms')) {
      throw new Error('Insert failed');
    }
    return defaultQueryHandler(sql, params);
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/rooms',
    user: mockUser,
    body: { room_name: 'Room 314' }
  });

  assert.equal(res.status, 500);
  assert.match(res.body.message, /error creating room/i);
});

test('POST /api/rooms returns 201 with newly created room on success', async () => {
  let createdParams = null;
  uninstallMock = installMockDb(db, (sql, params) => {
    createdParams = params;
    return { insertId: 5, affectedRows: 1 };
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/rooms',
    user: mockUser,
    body: { room_name: 'Room 315', location: 'Bluford Library 3rd Floor' }
  });

  assert.equal(res.status, 201);
  assert.match(res.body.message, /room created successfully/i);
  assert.equal(res.body.room.id, 5);
  assert.equal(res.body.room.room_name, 'Room 315');
});

test('PUT /api/rooms/:id returns 400 if no fields are provided to update', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);

  const res = await dispatch(app, {
    method: 'PUT',
    url: '/api/rooms/1',
    user: mockUser,
    body: {}
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /at least one field/i);
});

test('PUT /api/rooms/:id returns 404 when room does not exist', async () => {
  uninstallMock = installMockDb(db, () => ({ affectedRows: 0 }));

  const res = await dispatch(app, {
    method: 'PUT',
    url: '/api/rooms/999',
    user: mockUser,
    body: { room_name: 'New Room Name' }
  });

  assert.equal(res.status, 404);
  assert.match(res.body.message, /room not found/i);
});

test('PUT /api/rooms/:id returns 500 on database update failure', async () => {
  uninstallMock = installMockDb(db, (sql, params) => {
    if (sql.includes('UPDATE rooms')) {
      throw new Error('Update error');
    }
    return defaultQueryHandler(sql, params);
  });

  const res = await dispatch(app, {
    method: 'PUT',
    url: '/api/rooms/1',
    user: mockUser,
    body: { location: '2nd Floor' }
  });

  assert.equal(res.status, 500);
  assert.match(res.body.message, /error updating room/i);
});

test('PUT /api/rooms/:id returns 200 and updates room name/location on success', async () => {
  uninstallMock = installMockDb(db, () => ({ affectedRows: 1 }));

  const res = await dispatch(app, {
    method: 'PUT',
    url: '/api/rooms/1',
    user: mockUser,
    body: { room_name: 'Quiet Room 311', location: 'Bluford Library 3rd Floor East' }
  });

  assert.equal(res.status, 200);
  assert.match(res.body.message, /room updated successfully/i);
  assert.equal(res.body.room.room_name, 'Quiet Room 311');
});

test('PATCH /api/rooms/:id/toggle toggles is_active status', async () => {
  let callCount = 0;
  uninstallMock = installMockDb(db, (sql) => {
    callCount++;
    if (sql.includes('UPDATE rooms SET is_active')) return { affectedRows: 1 };
    if (sql.includes('SELECT id, room_name')) {
      return [{ id: 1, room_name: 'Room 311', location: '3rd Floor', is_active: 0 }];
    }
    return defaultQueryHandler(sql);
  });

  const res = await dispatch(app, {
    method: 'PATCH',
    url: '/api/rooms/1/toggle',
    user: mockUser
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.room.is_active, 0);
});

test('PUT /api/rooms/:id/thresholds validates thresholds and updates on success', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);

  // Missing or invalid thresholds -> 400
  const res1 = await dispatch(app, {
    method: 'PUT',
    url: '/api/rooms/1/thresholds',
    user: mockUser,
    body: {}
  });
  assert.equal(res1.status, 400);

  // Red threshold not higher than yellow -> 400
  const res2 = await dispatch(app, {
    method: 'PUT',
    url: '/api/rooms/1/thresholds',
    user: mockUser,
    body: { yellow_threshold: 75, red_threshold: 60 }
  });
  assert.equal(res2.status, 400);

  // Valid thresholds -> 200 and broadcasts SSE
  const mockClient = { write: () => {} };
  let writtenData = '';
  mockClient.write = (chunk) => { writtenData += chunk; };
  sseClients.add(mockClient);

  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('UPDATE rooms SET yellow_threshold')) return { affectedRows: 1 };
    return defaultQueryHandler(sql);
  });

  const res3 = await dispatch(app, {
    method: 'PUT',
    url: '/api/rooms/1/thresholds',
    user: mockUser,
    body: { yellow_threshold: 55, red_threshold: 72 }
  });

  assert.equal(res3.status, 200);
  assert.equal(res3.body.room.yellow_threshold, 55);
  assert.equal(res3.body.room.red_threshold, 72);
  assert.ok(writtenData.includes('thresholds_updated'));
});

test('POST /api/rooms with custom thresholds validates and saves', async () => {
  uninstallMock = installMockDb(db, defaultQueryHandler);

  const res1 = await dispatch(app, {
    method: 'POST',
    url: '/api/rooms',
    user: mockUser,
    body: {
      room_name: 'Room 320',
      yellow_threshold: 80,
      red_threshold: 60
    }
  });
  assert.equal(res1.status, 400);
  assert.match(res1.body.message, /strictly higher/i);

  uninstallMock = installMockDb(db, () => ({ insertId: 7, affectedRows: 1 }));

  const res2 = await dispatch(app, {
    method: 'POST',
    url: '/api/rooms',
    user: mockUser,
    body: {
      room_name: 'Room 320',
      yellow_threshold: 50,
      red_threshold: 68
    }
  });

  assert.equal(res2.status, 201);
  assert.equal(res2.body.room.yellow_threshold, 50);
  assert.equal(res2.body.room.red_threshold, 68);
});
