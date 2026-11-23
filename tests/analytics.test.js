const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { calculateHourlyTrends, formatHourlyTrends } = require('../lib/analytics');
const { installAccess } = require('../lib/access');
const { dispatch } = require('./test-helper');

test('calculateHourlyTrends returns 24 zero-filled hourly buckets when no records exist', async () => {
  const query = async () => [];
  const trends = await calculateHourlyTrends(query, {});
  assert.equal(trends.length, 24);
  assert.deepEqual(trends[0], {
    hour: 0,
    hour_label: '12 AM',
    avg_noise_level: 0,
    avg_level: 0,
    max_noise_level: 0,
    min_noise_level: 0,
    incident_spikes: 0,
    incident_count: 0,
    reading_count: 0
  });
  assert.equal(trends[12].hour_label, '12 PM');
  assert.equal(trends[14].hour_label, '2 PM');
  assert.equal(trends[23].hour_label, '11 PM');
});

test('calculateHourlyTrends accurately maps sound readings and incident spikes by hour', async () => {
  const queries = [];
  const mockReadings = [
    { hour: 9, avg_noise_level: '42.50', max_noise_level: '55.00', min_noise_level: '35.00', reading_count: 60 },
    { hour: 14, avg_noise_level: '68.75', max_noise_level: '82.10', min_noise_level: '48.20', reading_count: 120 }
  ];
  const mockIncidents = [
    { hour: 14, incident_spikes: 5 },
    { hour: 16, incident_spikes: 2 }
  ];

  const query = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('sound_readings')) return mockReadings;
    if (sql.includes('incidents')) return mockIncidents;
    return [];
  };

  const trends = await calculateHourlyTrends(query, { room_id: '2', date: '2026-11-15' });
  assert.equal(trends.length, 24);
  assert.equal(queries.length, 2);
  assert.ok(queries[0].sql.includes('AND room_id = ?'));
  assert.ok(queries[0].sql.includes('AND DATE(recorded_at) = ?'));
  assert.deepEqual(queries[0].params, ['2', '2026-11-15']);
  assert.ok(queries[1].sql.includes('AND room_id = ?'));
  assert.ok(queries[1].sql.includes('AND DATE(started_at) = ?'));
  assert.deepEqual(queries[1].params, ['2', '2026-11-15']);

  const hour9 = trends[9];
  assert.equal(hour9.hour, 9);
  assert.equal(hour9.hour_label, '9 AM');
  assert.equal(hour9.avg_noise_level, 42.5);
  assert.equal(hour9.reading_count, 60);
  assert.equal(hour9.incident_spikes, 0);

  const hour14 = trends[14];
  assert.equal(hour14.hour, 14);
  assert.equal(hour14.hour_label, '2 PM');
  assert.equal(hour14.avg_noise_level, 68.75);
  assert.equal(hour14.reading_count, 120);
  assert.equal(hour14.incident_spikes, 5);

  const hour16 = trends[16];
  assert.equal(hour16.hour, 16);
  assert.equal(hour16.hour_label, '4 PM');
  assert.equal(hour16.avg_noise_level, 0);
  assert.equal(hour16.incident_spikes, 2);

  const objectFormatted = formatHourlyTrends(trends, { room_id: 2, date: '2026-11-15' });
  assert.equal(objectFormatted.room_id, 2);
  assert.equal(objectFormatted.date, '2026-11-15');
  assert.equal(objectFormatted.total_readings, 180);
  assert.equal(objectFormatted.total_incidents, 7);
  assert.equal(objectFormatted.hourly.length, 24);
});

test('GET /api/analytics/hourly-trends requires staff role (admin or security)', async () => {
  const app = express();
  app.use(express.json());

  const fakePool = {
    promise: () => ({
      query: async (sql) => {
        if (sql.includes('system_settings')) return [[{ security_policy: null }]];
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

  // Unauthenticated -> 401
  const unauthRes = await dispatch(app, { url: '/api/analytics/hourly-trends', user: null });
  assert.equal(unauthRes.status, 401);
  assert.match(unauthRes.body.message, /staff sign-in required/i);

  // Library monitor -> 403
  const monitorRes = await dispatch(app, { url: '/api/analytics/hourly-trends', user: { role: 'library_monitor' } });
  assert.equal(monitorRes.status, 403);
  assert.match(monitorRes.body.message, /access denied/i);

  // Admin -> 200
  const adminRes = await dispatch(app, { url: '/api/analytics/hourly-trends', user: { role: 'admin' } });
  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.body.length, 24);
});

test('GET /api/analytics/hourly-trends returns 500 when database fails', async () => {
  const app = express();
  app.use(express.json());

  const failingPool = {
    promise: () => ({
      query: async (sql) => {
        if (sql.includes('sound_readings')) throw new Error('Database connection failed');
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

  installAccess(app, failingPool);

  const res = await dispatch(app, { url: '/api/analytics/hourly-trends', user: { role: 'admin' } });
  assert.equal(res.status, 500);
  assert.match(res.body.message, /error fetching hourly analytics trends/i);
});

test('GET /api/analytics/hourly-trends supports format=object returning summary metrics', async () => {
  const app = express();
  app.use(express.json());

  const pool = {
    promise: () => ({
      query: async (sql) => {
        if (sql.includes('sound_readings')) {
          return [[{ hour: 12, avg_noise_level: '60.00', max_noise_level: '65.00', min_noise_level: '55.00', reading_count: 50 }]];
        }
        if (sql.includes('incidents')) {
          return [[{ hour: 12, incident_spikes: 3 }]];
        }
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

  installAccess(app, pool);

  const res = await dispatch(app, { url: '/api/analytics/hourly-trends?format=object', user: { role: 'admin' } });
  assert.equal(res.status, 200);
  assert.ok(res.body.hourly);
  assert.equal(res.body.hourly.length, 24);
  assert.equal(res.body.total_readings, 50);
  assert.equal(res.body.total_incidents, 3);
});
