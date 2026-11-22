const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { escapeCsvField, buildCsvString, generateReportsCsv, generateIncidentsCsv, generateHourlyTrendsCsv, generateCsvReport } = require('../lib/report-data');
const { calculateHourlyTrends, formatHourlyTrends, generateHourlyCsv } = require('../lib/analytics');
const { installAccess } = require('../lib/access');

test('CSV formatting helpers correctly handle escaping and CRLF row joining', () => {
  assert.equal(escapeCsvField(null), '');
  assert.equal(escapeCsvField(undefined), '');
  assert.equal(escapeCsvField(42), '42');
  assert.equal(escapeCsvField('Room 311'), 'Room 311');
  assert.equal(escapeCsvField('Hello, "Quiet" World'), '"Hello, ""Quiet"" World"');
  assert.equal(escapeCsvField('Line 1\nLine 2'), '"Line 1\nLine 2"');
  assert.equal(escapeCsvField('Item A, Item B'), '"Item A, Item B"');

  const headers = ['ID', 'Name', 'Comments'];
  const rows = [
    [1, 'Room 311', 'Loud "talking", and music'],
    [2, 'Room 312', 'Quiet study']
  ];
  const csv = buildCsvString(headers, rows);
  assert.ok(csv.includes('ID,Name,Comments'));
  assert.ok(csv.includes('1,Room 311,"Loud ""talking"", and music"'));
  assert.ok(csv.includes('2,Room 312,Quiet study'));
  assert.ok(csv.includes('\r\n'));
});

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

test('generateCsvReport generates incident reports, student noise reports, and hourly trend CSVs', async () => {
  const mockIncidents = [
    {
      id: 201,
      room_name: 'Room 311',
      status: 'resolved',
      escalation_count: 1,
      trigger_level: 'red',
      started_at: '2026-11-15T14:00:00.000Z',
      resolved_at: '2026-11-15T14:05:00.000Z',
      duration_seconds: 300
    }
  ];
  const queryIncidents = async () => mockIncidents;
  const incidentResult = await generateCsvReport(queryIncidents, { type: 'incidents', month: '2026-11' });
  assert.equal(incidentResult.filename, 'quietspace-incidents-2026-11.csv');
  assert.ok(incidentResult.csv.includes('Incident ID,Room Name,Status,Escalation Count,Trigger Level,Started At,Resolved At,Duration (Seconds)'));
  assert.ok(incidentResult.csv.includes('201,Room 311,resolved,1,red,2026-11-15T14:00:00.000Z,2026-11-15T14:05:00.000Z,300'));

  const mockReports = [
    {
      id: 101,
      room_name: 'Room 312',
      noise_type: 'Loud Talking',
      severity: 'medium',
      comments: 'Group discussion near doorway',
      report_status: 'resolved',
      submitted_at: '2026-11-15T14:15:00.000Z'
    }
  ];
  const queryReports = async () => mockReports;
  const reportResult = await generateCsvReport(queryReports, { type: 'reports', month: '2026-11' });
  assert.equal(reportResult.filename, 'quietspace-reports-2026-11.csv');
  assert.ok(reportResult.csv.includes('Report ID,Room Name,Noise Type,Severity,Comments,Report Status,Submitted At'));
  assert.ok(reportResult.csv.includes('101,Room 312,Loud Talking,medium,Group discussion near doorway,resolved,2026-11-15T14:15:00.000Z'));

  const queryHourly = async (sql) => {
    if (sql.includes('sound_readings')) {
      return [{ hour: 14, avg_noise_level: '68.50', max_noise_level: '78.20', min_noise_level: '52.00', reading_count: 100 }];
    }
    if (sql.includes('incidents')) {
      return [{ hour: 14, incident_spikes: 3 }];
    }
    return [];
  };
  const hourlyResult = await generateCsvReport(queryHourly, { type: 'hourly', date: '2026-11-15' });
  assert.equal(hourlyResult.filename, 'quietspace-hourly-trends-2026-11-15.csv');
  assert.ok(hourlyResult.csv.includes('Hour,Hour Label,Average Noise Level (dB),Max Noise Level (dB),Min Noise Level (dB),Reading Count,Incident Spikes'));
  assert.ok(hourlyResult.csv.includes('14,2 PM,68.5,78.2,52,100,3'));
  assert.ok(hourlyResult.csv.includes('0,12 AM,0,0,0,0,0'));
});

test('lib/access.js guards /api/reports/export/csv and /api/analytics/hourly-trends with requireRoles', async () => {
  const app = express();
  app.use(express.json());

  let currentUser = null;
  app.use((req, res, next) => {
    if (currentUser) req.user = currentUser;
    next();
  });

  const fakePool = {
    promise: () => ({
      query: async (sql) => {
        if (sql.includes('system_settings')) return [[{ security_policy: null }]];
        if (sql.includes('staff_sessions')) return [[]];
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

  function dispatch(app, { method = 'GET', url, user = null }) {
    currentUser = user;
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
        headers: {},
        get(k) { return this.headers[k.toLowerCase()]; },
        socket: { remoteAddress: '127.0.0.1' },
        protocol: 'http'
      };
      app(req, res);
    });
  }

  // 1. Unauthenticated -> 401
  let res = await dispatch(app, { url: '/api/analytics/hourly-trends', user: null });
  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /staff sign-in required/i);

  res = await dispatch(app, { url: '/api/reports/export/csv', user: null });
  assert.equal(res.statusCode, 401);

  // 2. Library Monitor -> 403
  res = await dispatch(app, { url: '/api/analytics/hourly-trends', user: { role: 'library_monitor' } });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /access denied/i);

  res = await dispatch(app, { url: '/api/reports/export/csv', user: { role: 'library_monitor' } });
  assert.equal(res.statusCode, 403);

  // 3. Security Role -> 200
  res = await dispatch(app, { url: '/api/analytics/hourly-trends', user: { role: 'security' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 24);

  res = await dispatch(app, { url: '/api/reports/export/csv?type=hourly&date=2026-11-15', user: { role: 'security' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /quietspace-hourly-trends-2026-11-15\.csv/);
  assert.ok(res.body.includes('Hour,Hour Label,Average Noise Level (dB)'));

  // 4. Admin Role -> 200
  res = await dispatch(app, { url: '/api/analytics/hourly-trends?format=object', user: { role: 'admin' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.hourly.length, 24);

  res = await dispatch(app, { url: '/api/reports/export/csv?type=incidents&month=2026-11', user: { role: 'admin' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /quietspace-incidents-2026-11\.csv/);

  // 5. Alias endpoint /api/analytics/export/csv -> 200
  res = await dispatch(app, { url: '/api/analytics/export/csv?type=reports&month=2026-11', user: { role: 'admin' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /quietspace-reports-2026-11\.csv/);
});

test('handles database query errors gracefully returning 500 status', async () => {
  const app = express();
  app.use(express.json());

  let currentUser = { id: 1, role: 'admin', username: 'admin' };
  app.use((req, res, next) => {
    if (currentUser) req.user = currentUser;
    next();
  });

  const fakeFailingPool = {
    promise: () => ({
      query: async (sql) => {
        if (sql.includes('system_settings')) return [[{ security_policy: null }]];
        if (sql.includes('staff_sessions')) return [[]];
        throw new Error('Database connection failed');
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

  installAccess(app, fakeFailingPool);

  function dispatch(app, { method = 'GET', url, user = null }) {
    currentUser = user;
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
        headers: {},
        get(k) { return this.headers[k.toLowerCase()]; },
        socket: { remoteAddress: '127.0.0.1' },
        protocol: 'http'
      };
      app(req, res);
    });
  }

  const errSpy = console.error;
  console.error = () => {};
  try {
    let res = await dispatch(app, { url: '/api/analytics/hourly-trends', user: { role: 'admin' } });
    assert.equal(res.statusCode, 500);
    assert.match(res.body.message, /error fetching hourly analytics trends/i);

    res = await dispatch(app, { url: '/api/reports/export/csv', user: { role: 'admin' } });
    assert.equal(res.statusCode, 500);
    assert.match(res.body.message, /error exporting csv report/i);
  } finally {
    console.error = errSpy;
  }
});
