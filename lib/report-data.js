/* Shared report ordering and configurable monitor/evidence scope. */
const STUDENT_REPORTS_SQL = `
    SELECT
      noise_reports.id,
      noise_reports.room_id,
      rooms.room_name,
      noise_reports.noise_type,
      noise_reports.severity,
      noise_reports.comments,
      noise_reports.report_status,
      noise_reports.resolution_method,
      noise_reports.resolved_at,
      noise_reports.submitted_at
    FROM noise_reports
    JOIN rooms
      ON noise_reports.room_id = rooms.id
    ORDER BY noise_reports.submitted_at DESC
  `;
const QUIETSCORE_REPORTS_SQL = `
    SELECT
      incidents.id,
      incidents.room_id,
      incidents.trigger_level,
      rooms.room_name,
      incidents.status,
      incidents.escalation_count,
      incidents.started_at,
      incidents.resolved_at,
      incidents.timer_started_at,
      incidents.tracking_started_at,
      EXISTS (SELECT 1 FROM incident_activity ia WHERE ia.incident_id=incidents.id AND ia.event_type='staff_alert_triggered') AS recorded_staff_alert,
      EXISTS (SELECT 1 FROM incident_activity ia WHERE ia.incident_id=incidents.id AND ia.event_type='staff_alert_delivered') AS recorded_staff_display
    FROM incidents
    JOIN rooms
      ON incidents.room_id = rooms.id
    ORDER BY incidents.started_at DESC
  `;

const libraryTimeZone = process.env.LIBRARY_TIME_ZONE || 'America/New_York';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: libraryTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
function libraryDay(value = new Date()) { return formatter.format(new Date(value)); }
// Temporary local testing mode; production remains day-limited unless explicitly configured.
function includeReportHistory() {
  return process.env.MONITOR_REPORT_SCOPE === 'all' ||
    (process.env.NODE_ENV !== 'production' && process.env.MONITOR_REPORT_SCOPE !== 'today');
}
function visibleReports(rows, timestamp) {
  return includeReportHistory() ? rows : rows.filter(r => libraryDay(r[timestamp]) === libraryDay());
}
async function todayReports(query) {
  const [student, quietscore] = await Promise.all([query(STUDENT_REPORTS_SQL), query(QUIETSCORE_REPORTS_SQL)]);
  const day = libraryDay();
  const student_reports = visibleReports(student, 'submitted_at').map(r => ({
    id: r.id, room_id: r.room_id, room_name: r.room_name, description: r.noise_type,
    timestamp: r.submitted_at, status: r.report_status, resolution_method: r.resolution_method
  }));
  const quietscore_reports = visibleReports(quietscore, 'started_at').map(r => ({
    id: r.id, room_id: r.room_id, room_name: r.room_name, description: 'QuietScore: ' + (r.trigger_level ?? 'Noise incident'),
    timestamp: r.started_at, status: r.status
  }));
  return { scope: includeReportHistory() ? 'all' : 'today', library_date: day, time_zone: libraryTimeZone, student_reports, quietscore_reports };
}

async function runQuery(query, sql, params = []) {
  if (typeof query !== 'function') throw new Error('Database query handler is not a function');
  if (query.length >= 3) {
    return new Promise((resolve, reject) => {
      query(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }
  const result = query(sql, params);
  if (result && typeof result.then === 'function') {
    return await result;
  }
  return new Promise((resolve, reject) => {
    query(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function escapeCsvField(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvString(headers, rows) {
  const headerLine = headers.map(escapeCsvField).join(',');
  const dataLines = rows.map((row) => row.map(escapeCsvField).join(','));
  return [headerLine, ...dataLines].join('\r\n');
}

async function generateReportsCsv(query, options = {}) {
  const { room_id, month, date, start_date, end_date } = options;
  const monthTag = month || (date ? date.slice(0, 7) : new Date().toISOString().slice(0, 7));

  let whereClause = 'WHERE 1=1';
  const params = [];

  if (room_id && room_id !== 'all') {
    whereClause += ' AND noise_reports.room_id = ?';
    params.push(room_id);
  }
  if (month) {
    whereClause += " AND DATE_FORMAT(noise_reports.submitted_at, '%Y-%m') = ?";
    params.push(month);
  } else if (date) {
    whereClause += ' AND DATE(noise_reports.submitted_at) = ?';
    params.push(date);
  }
  if (start_date) {
    whereClause += ' AND DATE(noise_reports.submitted_at) >= ?';
    params.push(start_date);
  }
  if (end_date) {
    whereClause += ' AND DATE(noise_reports.submitted_at) <= ?';
    params.push(end_date);
  }

  const sql = `
    SELECT
      noise_reports.id,
      rooms.room_name,
      noise_reports.noise_type,
      noise_reports.severity,
      noise_reports.comments,
      noise_reports.report_status,
      noise_reports.submitted_at
    FROM noise_reports
    JOIN rooms ON noise_reports.room_id = rooms.id
    ${whereClause}
    ORDER BY noise_reports.submitted_at DESC
  `;

  const rows = await runQuery(query, sql, params);

  const headers = [
    'Report ID',
    'Room Name',
    'Noise Type',
    'Severity',
    'Comments',
    'Report Status',
    'Submitted At'
  ];

  const csvRows = (rows || []).map((r) => [
    r.id,
    r.room_name,
    r.noise_type,
    r.severity,
    r.comments || '',
    r.report_status,
    r.submitted_at ? new Date(r.submitted_at).toISOString() : ''
  ]);

  const csv = buildCsvString(headers, csvRows);
  const filename = `quietspace-reports-${monthTag}.csv`;
  return { csv, filename };
}

async function generateIncidentsCsv(query, options = {}) {
  const { room_id, month, date, start_date, end_date } = options;
  const monthTag = month || (date ? date.slice(0, 7) : new Date().toISOString().slice(0, 7));

  let whereClause = 'WHERE 1=1';
  const params = [];

  if (room_id && room_id !== 'all') {
    whereClause += ' AND incidents.room_id = ?';
    params.push(room_id);
  }
  if (month) {
    whereClause += " AND DATE_FORMAT(incidents.started_at, '%Y-%m') = ?";
    params.push(month);
  } else if (date) {
    whereClause += ' AND DATE(incidents.started_at) = ?';
    params.push(date);
  }
  if (start_date) {
    whereClause += ' AND DATE(incidents.started_at) >= ?';
    params.push(start_date);
  }
  if (end_date) {
    whereClause += ' AND DATE(incidents.started_at) <= ?';
    params.push(end_date);
  }

  const sql = `
    SELECT
      incidents.id,
      rooms.room_name,
      incidents.status,
      incidents.escalation_count,
      incidents.trigger_level,
      incidents.started_at,
      incidents.resolved_at,
      TIMESTAMPDIFF(SECOND, incidents.started_at, COALESCE(incidents.resolved_at, NOW())) AS duration_seconds
    FROM incidents
    JOIN rooms ON incidents.room_id = rooms.id
    ${whereClause}
    ORDER BY incidents.started_at DESC
  `;

  const rows = await runQuery(query, sql, params);

  const headers = [
    'Incident ID',
    'Room Name',
    'Status',
    'Escalation Count',
    'Trigger Level',
    'Started At',
    'Resolved At',
    'Duration (Seconds)'
  ];

  const csvRows = (rows || []).map((r) => [
    r.id,
    r.room_name,
    r.status,
    r.escalation_count,
    r.trigger_level || 'red',
    r.started_at ? new Date(r.started_at).toISOString() : '',
    r.resolved_at ? new Date(r.resolved_at).toISOString() : '',
    r.duration_seconds !== null && r.duration_seconds !== undefined ? r.duration_seconds : ''
  ]);

  const csv = buildCsvString(headers, csvRows);
  const filename = `quietspace-incidents-${monthTag}.csv`;
  return { csv, filename };
}

async function generateHourlyTrendsCsv(query, options = {}) {
  const { calculateHourlyTrends, generateHourlyCsv } = require('./analytics');
  const trends = await calculateHourlyTrends(query, options);
  return generateHourlyCsv(trends, options);
}

async function generateCsvReport(query, options = {}) {
  const { type = 'incidents' } = options;
  if (type === 'reports') {
    return generateReportsCsv(query, options);
  }
  if (type === 'hourly') {
    return generateHourlyTrendsCsv(query, options);
  }
  return generateIncidentsCsv(query, options);
}

module.exports = {
  STUDENT_REPORTS_SQL,
  QUIETSCORE_REPORTS_SQL,
  libraryDay,
  libraryTimeZone,
  todayReports,
  includeReportHistory,
  visibleReports,
  escapeCsvField,
  buildCsvString,
  runQuery,
  generateReportsCsv,
  generateIncidentsCsv,
  generateHourlyTrendsCsv,
  generateCsvReport,
  exportCsv: generateCsvReport,
  generateReportCsv: generateCsvReport
};
