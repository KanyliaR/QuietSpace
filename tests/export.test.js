const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { escapeCsvField, buildCsvString, generateCsvReport } = require('../lib/report-data');
const { installAccess } = require('../lib/access');
const { dispatch } = require('./test-helper');

test('CSV Formatting Helpers (escapeCsvField, buildCsvString)', () => {
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

test('GET /api/reports/export/csv exports incidents CSV with proper headers', async () => {
  const mockIncidents = [
    {
      id: 101,
      room_name: 'Room 311',
      status: 'resolved',
      escalation_count: 2,
      trigger_level: 'red',
      started_at: '2026-11-15T14:00:00.000Z',
      resolved_at: '2026-11-15T14:05:00.000Z',
      duration_seconds: 300
    }
  ];

  const app = express();
  app.use(express.json());

  const pool = {
    promise: () => ({
      query: async (sql) => {
        if (sql.includes('incidents')) return [mockIncidents];
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

  const res = await dispatch(app, {
    url: '/api/reports/export/csv',
    user: { role: 'admin' }
  });

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /quietspace-incidents/);
  assert.ok(res.text.includes('Incident ID,Room Name,Status,Escalation Count,Trigger Level,Started At,Resolved At,Duration (Seconds)'));
  assert.ok(res.text.includes('101,Room 311,resolved,2,red,2026-11-15T14:00:00.000Z,2026-11-15T14:05:00.000Z,300'));
});

test('GET /api/reports/export/csv?type=reports exports student noise reports CSV', async () => {
  const mockReports = [
    {
      id: 50,
      room_name: 'Room 312',
      noise_type: 'Loud Talking',
      severity: 'high',
      comments: 'Group discussion with "speakerphone", very noisy',
      report_status: 'in_review',
      submitted_at: '2026-11-15T15:30:00.000Z'
    }
  ];

  const app = express();
  app.use(express.json());

  const pool = {
    promise: () => ({
      query: async (sql) => {
        if (sql.includes('noise_reports')) return [mockReports];
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

  const res = await dispatch(app, {
    url: '/api/reports/export/csv?type=reports&month=2026-11',
    user: { role: 'security' }
  });

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /quietspace-reports-2026-11\.csv/);
  assert.ok(res.text.includes('Report ID,Room Name,Noise Type,Severity,Comments,Report Status,Submitted At'));
  assert.ok(res.text.includes('50,Room 312,Loud Talking,high,"Group discussion with ""speakerphone"", very noisy",in_review,2026-11-15T15:30:00.000Z'));
});

test('GET /api/reports/export/csv?type=hourly exports 24 hourly buckets', async () => {
  const app = express();
  app.use(express.json());

  const pool = {
    promise: () => ({
      query: async (sql) => {
        if (sql.includes('sound_readings')) {
          return [[{ hour: 14, avg_noise_level: '68.50', max_noise_level: '78.20', min_noise_level: '52.00', reading_count: 100 }]];
        }
        if (sql.includes('incidents')) {
          return [[{ hour: 14, incident_spikes: 3 }]];
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

  const res = await dispatch(app, {
    url: '/api/reports/export/csv?type=hourly&date=2026-11-15',
    user: { role: 'admin' }
  });

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /quietspace-hourly-trends-2026-11-15\.csv/);
  assert.ok(res.text.includes('Hour,Hour Label,Average Noise Level (dB),Max Noise Level (dB),Min Noise Level (dB),Reading Count,Incident Spikes'));
  assert.ok(res.text.includes('14,2 PM,68.5,78.2,52,100,3'));
  assert.ok(res.text.includes('0,12 AM,0,0,0,0,0'));
});

test('GET /api/analytics/export/csv alias endpoint works identically', async () => {
  const app = express();
  app.use(express.json());

  const pool = {
    promise: () => ({
      query: async () => [[]],
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

  const res = await dispatch(app, {
    url: '/api/analytics/export/csv?type=incidents',
    user: { role: 'admin' }
  });

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
});

test('GET /api/reports/export/csv returns 500 when database fails', async () => {
  const app = express();
  app.use(express.json());

  const failingPool = {
    promise: () => ({
      query: async () => {
        throw new Error('Database connection lost');
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

  const res = await dispatch(app, {
    url: '/api/reports/export/csv',
    user: { role: 'admin' }
  });

  assert.equal(res.status, 500);
  assert.match(res.body.message, /error exporting csv report/i);
});
