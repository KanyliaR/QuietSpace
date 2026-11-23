const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, db } = require('../server');
const { hashPassword } = require('../lib/passwords');
const { dispatch, installMockDb } = require('./test-helper');

let uninstallMock;
let sampleHash;

beforeEach(async () => {
  if (uninstallMock) uninstallMock();
  if (!sampleHash) {
    sampleHash = await hashPassword('Password123!');
  }
});

afterEach(() => {
  if (uninstallMock) uninstallMock();
});

test('POST /api/auth/login returns 400 when email or password is missing or empty', async () => {
  const res1 = await dispatch(app, {
    method: 'POST',
    url: '/api/auth/login',
    body: {}
  });
  assert.equal(res1.status, 400);
  assert.match(res1.body.message, /required/i);

  const res2 = await dispatch(app, {
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'staff@quietspace.com' }
  });
  assert.equal(res2.status, 400);

  const res3 = await dispatch(app, {
    method: 'POST',
    url: '/api/auth/login',
    body: { email: '   ', password: '   ' }
  });
  assert.equal(res3.status, 400);
});

test('POST /api/auth/login returns 500 when database error occurs', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('FROM staff_users')) throw new Error('Database connection error');
    return [];
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/auth/login',
    body: {
      email: 'staff@quietspace.com',
      password: 'anyPassword'
    }
  });

  assert.equal(res.status, 500);
});

test('POST /api/auth/login returns 401 when staff user is not found in database', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('FROM staff_users')) return [];
    return [];
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/auth/login',
    body: {
      email: 'nonexistent@quietspace.com',
      password: 'anyPassword'
    }
  });

  assert.equal(res.status, 401);
  assert.match(res.body.message, /invalid credentials/i);
});

test('POST /api/auth/login returns 401 when password does not match hashed password', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('FROM staff_users')) {
      return [
        {
          id: 1,
          name: 'Library Staff',
          username: 'librarian',
          email: 'staff@quietspace.com',
          role: 'library_monitor',
          account_status: 'active',
          setup_complete: 1,
          password_hash: sampleHash
        }
      ];
    }
    if (sql.includes('SELECT security_policy')) return [{ security_policy: null }];
    return [];
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/auth/login',
    body: {
      username: 'librarian',
      password: 'WrongPassword!'
    }
  });

  assert.equal(res.status, 401);
  assert.match(res.body.message, /invalid credentials/i);
});

test('POST /api/auth/login returns 200 with session cookie and user info on valid credentials', async () => {
  const mockUserRow = {
    id: 1,
    name: 'Library Staff',
    username: 'librarian',
    email: 'staff@quietspace.com',
    role: 'library_monitor',
    account_status: 'active',
    setup_complete: 1,
    failed_attempts: 0,
    locked_until: null,
    password_hash: sampleHash
  };

  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('SELECT security_policy')) return [{ security_policy: null }];
    if (sql.includes('FROM staff_users')) return [mockUserRow];
    if (sql.includes('INSERT INTO staff_sessions')) return { affectedRows: 1 };
    if (sql.includes('UPDATE staff_users')) return { affectedRows: 1 };
    if (sql.includes('INSERT INTO audit_events')) return { affectedRows: 1 };
    return [];
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/auth/login',
    body: {
      username: 'librarian',
      password: 'Password123!'
    }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.id, 1);
  assert.equal(res.body.username, 'librarian');
  assert.equal(res.body.role, 'library_monitor');
  assert.ok(res.headers['set-cookie']);
  assert.match(res.headers['set-cookie'], /quietspace_session=/);
});

test('GET /api/auth/me returns 401 when session is missing', async () => {
  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/auth/me',
    user: null
  });

  assert.equal(res.status, 401);
  assert.match(res.body.message, /staff sign-in required/i);
});

test('GET /api/auth/me returns 200 with user profile when valid session exists', async () => {
  const res = await dispatch(app, {
    method: 'GET',
    url: '/api/auth/me',
    user: { id: 1, name: 'Library Staff', username: 'librarian', role: 'admin' }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.id, 1);
  assert.equal(res.body.username, 'librarian');
  assert.equal(res.body.role, 'admin');
});

test('POST /api/auth/logout signs out user and clears session cookie', async () => {
  uninstallMock = installMockDb(db, (sql) => {
    if (sql.includes('DELETE FROM staff_sessions')) return { affectedRows: 1 };
    return [];
  });

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/auth/logout',
    user: { id: 1, role: 'admin' }
  });

  assert.equal(res.status, 200);
  assert.match(res.body.message, /signed out/i);
  assert.ok(res.headers['set-cookie']);
  assert.match(res.headers['set-cookie'], /quietspace_session=;/);
});
