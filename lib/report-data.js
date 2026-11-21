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
module.exports = { STUDENT_REPORTS_SQL, QUIETSCORE_REPORTS_SQL, libraryDay, libraryTimeZone, todayReports, includeReportHistory, visibleReports };
