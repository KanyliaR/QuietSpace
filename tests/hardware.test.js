const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  installDevices,
  sensorRegistry,
  updateSensorReading,
  checkHardwareWatchdog,
  resetSensorRegistry
} = require('../lib/devices');
const { installAccess } = require('../lib/access');

function createTestApp() {
  const app = express();
  app.use(express.json());

  const sseEvents = [];
  const publish = (type, data) => {
    sseEvents.push({ type, data });
  };

  const fakePool = {
    promise: () => ({
      query: async (sql, params = []) => {
        if (sql.includes('system_settings')) return [[{ security_policy: null, staff_settings: '{}' }]];
        if (sql.includes('staff_sessions')) return [[]];
        if (sql.includes('room_devices')) return [[]];
        return [[]];
      },
      getConnection: async () => ({
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        query: async () => [[]]
      })
    })
  };

  installAccess(app, fakePool);

  function dispatch(app, { method = 'GET', url, body = null, headers = {} }) {
    return new Promise((resolve) => {
      const resHeaders = {};
      const res = {
        statusCode: 200,
        headers: resHeaders,
        setHeader(k, v) { resHeaders[k.toLowerCase()] = v; return this; },
        getHeader(k) { return resHeaders[k.toLowerCase()]; },
        set(k, v) { return this.setHeader(k, v); },
        status(code) { this.statusCode = code; return this; },
        json(data) { this.setHeader('content-type', 'application/json'); this.body = data; resolve(this); },
        send(data) { this.body = data; resolve(this); },
        end(data) { if (data) this.body = data; resolve(this); }
      };
      const req = {
        method,
        url,
        body,
        headers: { ...headers },
        get(k) { return this.headers[k.toLowerCase()]; },
        socket: { remoteAddress: '127.0.0.1' },
        protocol: 'http'
      };
      app(req, res);
    });
  }

  return { app, dispatch, sseEvents, publish };
}

test('GET /api/hardware/status returns empty sensor list when no sensors are active', async () => {
  resetSensorRegistry();
  const { app, dispatch } = createTestApp();

  const res = await dispatch(app, { url: '/api/hardware/status' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.sensors, []);
  assert.equal(res.body.total_sensors, 0);
  assert.equal(res.body.online_count, 0);
  assert.equal(res.body.offline_count, 0);
  assert.equal(res.body.fault_count, 0);
  assert.ok(res.body.timestamp);
});

test('GET /api/hardware/status returns active sensors with accurate counts', async () => {
  resetSensorRegistry();
  const { app, dispatch } = createTestApp();

  updateSensorReading(1, 45.0);
  updateSensorReading(2, 52.0);

  const res = await dispatch(app, { url: '/api/hardware/status' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total_sensors, 2);
  assert.equal(res.body.online_count, 2);
  assert.equal(res.body.offline_count, 0);
  assert.equal(res.body.sensors.length, 2);
  const sensor1 = res.body.sensors.find((s) => s.room_id === 1);
  assert.equal(sensor1.last_level, 45.0);
});

test('POST /api/hardware/heartbeat registers sensors and handles status updates', async () => {
  resetSensorRegistry();
  const { app, dispatch } = createTestApp();

  // Missing room_id -> 400
  let res = await dispatch(app, { method: 'POST', url: '/api/hardware/heartbeat', body: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /room_id is required/i);

  // Online heartbeat -> 200
  res = await dispatch(app, { method: 'POST', url: '/api/hardware/heartbeat', body: { room_id: 311, status: 'ok' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.message, /heartbeat acknowledged/i);
  assert.equal(res.body.sensor.room_id, 311);
  assert.equal(res.body.sensor.status, 'online');

  // Disconnected heartbeat -> status offline
  res = await dispatch(app, { method: 'POST', url: '/api/hardware/heartbeat', body: { room_id: 312, status: 'disconnected' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sensor.status, 'offline');
  assert.match(res.body.sensor.fault_reason, /sensor reported disconnected/i);
});

test('Watchdog flags sensor as offline when last_recorded_at exceeds 30 seconds and recovers on reading', async () => {
  resetSensorRegistry();
  const events = [];
  const publish = (type, data) => events.push({ type, data });

  const pastTime = new Date(Date.now() - 45000);
  updateSensorReading(1, 40.0, pastTime);

  const offlineEvents = checkHardwareWatchdog(Date.now(), 30000, publish);
  assert.equal(offlineEvents.length, 1);
  assert.equal(offlineEvents[0].room_id, 1);
  assert.equal(offlineEvents[0].status, 'offline');
  assert.match(offlineEvents[0].reason, /sensor disconnected/i);

  const sensor = sensorRegistry.get(1);
  assert.equal(sensor.status, 'offline');

  // Verify SSE event was published
  assert.ok(events.some((e) => e.type === 'room_sensor_offline' && e.data.room_id === 1));

  // Recovery: new reading restores sensor to online
  updateSensorReading(1, 44.0, new Date(), 'green', publish);
  assert.equal(sensor.status, 'online');
  assert.equal(sensor.fault_reason, null);
  assert.ok(events.some((e) => e.type === 'sensor_status_changed' && e.data.status === 'online'));
});

test('POST /api/hardware/watchdog/check evaluates timeouts manually', async () => {
  resetSensorRegistry();
  const { app, dispatch } = createTestApp();

  const pastTime = new Date(Date.now() - 35000);
  updateSensorReading(2, 50.0, pastTime);

  const res = await dispatch(app, {
    method: 'POST',
    url: '/api/hardware/watchdog/check',
    body: { timeout_ms: 30000 }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.offline_count, 1);
  assert.equal(res.body.events[0].room_id, 2);
});

test('Zero-dB stuck sensor fault detection flags after 3 consecutive readings and clears on recovery', () => {
  resetSensorRegistry();
  const events = [];
  const publish = (type, data) => events.push({ type, data });

  // Reading 1: 0 dB
  updateSensorReading(1, 0.0, new Date(), 'green', publish);
  assert.equal(sensorRegistry.get(1).status, 'online');
  assert.equal(sensorRegistry.get(1).zero_db_streak, 1);

  // Reading 2: 0 dB
  updateSensorReading(1, 0.0, new Date(), 'green', publish);
  assert.equal(sensorRegistry.get(1).status, 'online');
  assert.equal(sensorRegistry.get(1).zero_db_streak, 2);

  // Reading 3: 0 dB -> fault
  updateSensorReading(1, 0.0, new Date(), 'green', publish);
  const sensor = sensorRegistry.get(1);
  assert.equal(sensor.status, 'fault');
  assert.equal(sensor.zero_db_streak, 3);
  assert.match(sensor.fault_reason, /microphone fault \/ obstructed/i);
  assert.ok(events.some((e) => e.type === 'sensor_fault' && e.data.room_id === 1));

  // Recovery upon non-zero reading
  updateSensorReading(1, 38.5, new Date(), 'green', publish);
  assert.equal(sensor.status, 'online');
  assert.equal(sensor.zero_db_streak, 0);
  assert.equal(sensor.fault_reason, null);
  assert.ok(events.some((e) => e.type === 'sensor_status_changed' && e.data.status === 'online'));
});
