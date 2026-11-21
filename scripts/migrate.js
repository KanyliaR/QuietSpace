require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
async function migrate(db) {
  async function column(table, name, definition) {
    const [rows] = await db.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [name]);
    if (!rows.length) await db.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  await require('./migrate-staff-management').migrateStaffManagement(db);
  await require('./migrate-account-deletion').migrateAccountDeletion(db);
  await require('./migrate-audit').migrateAudit(db);
  await column('staff_users', 'notification_preferences', 'JSON NULL');
  await db.query(`CREATE TABLE IF NOT EXISTS report_notification_clock (id INT PRIMARY KEY)`);
  await db.query('INSERT IGNORE INTO report_notification_clock (id) VALUES (1)');
  await db.query(`CREATE TABLE IF NOT EXISTS report_notification_events (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, kind ENUM('quietscore','student') NOT NULL,
    report_id INT UNSIGNED NOT NULL, room_id INT UNSIGNED NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE KEY report_event (kind,report_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS staff_notification_state (
    user_id INT UNSIGNED PRIMARY KEY, delivered_through INT UNSIGNED NOT NULL DEFAULT 0,
    quietscore_read_through INT UNSIGNED NOT NULL DEFAULT 0, student_read_through INT UNSIGNED NOT NULL DEFAULT 0, last_student_sound_at DATETIME(3) NULL,
    FOREIGN KEY (user_id) REFERENCES staff_users(id) ON DELETE CASCADE)`);

  await column('staff_notification_state','last_student_sound_at','DATETIME(3) NULL');
  await column('staff_users', 'username', 'VARCHAR(100) NULL UNIQUE');
  await column('staff_users', 'role', "ENUM('admin','security','library_monitor') NOT NULL DEFAULT 'library_monitor'");
  await column('staff_users', 'is_demo', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await column('staff_users', 'failed_attempts', 'INT NOT NULL DEFAULT 0');
  await column('staff_users', 'locked_until', 'DATETIME NULL');
  await column('rooms', 'monitoring_enabled', 'BOOLEAN NOT NULL DEFAULT TRUE');
  await column('noise_reports', 'resolution_method', "ENUM('manual','automatic') NULL");
  await column('noise_reports', 'resolved_at', 'DATETIME NULL');
  await db.query(`CREATE TABLE IF NOT EXISTS system_settings (
    id INT PRIMARY KEY, auto_resolve_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    auto_resolve_minutes INT NOT NULL DEFAULT 30)`);
  await db.query('INSERT IGNORE INTO system_settings (id) VALUES (1)');
  await column('system_settings', 'staff_settings', 'JSON NULL');
  await db.query(`CREATE TABLE IF NOT EXISTS staff_sessions (
    token_hash CHAR(64) PRIMARY KEY, user_id INT UNSIGNED NOT NULL,
    expires_at DATETIME NOT NULL, last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES staff_users(id) ON DELETE CASCADE,
    INDEX (expires_at))`);
  await db.query(`CREATE TABLE IF NOT EXISTS room_devices (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, room_id INT UNSIGNED NOT NULL,
    name VARCHAR(100) NOT NULL, key_hash CHAR(64) NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    FOREIGN KEY (room_id) REFERENCES rooms(id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS security_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, room_id INT UNSIGNED NOT NULL,
    submitted_by INT UNSIGNED NOT NULL, reason VARCHAR(2000) NOT NULL,
    status ENUM('pending','acknowledged','resolved','dismissed') NOT NULL DEFAULT 'pending',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id), FOREIGN KEY (submitted_by) REFERENCES staff_users(id),
    INDEX (status, created_at))`);
  await db.query(`CREATE TABLE IF NOT EXISTS security_request_history (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, request_id BIGINT UNSIGNED NOT NULL,
    actor_id INT UNSIGNED NOT NULL, status VARCHAR(30) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES security_requests(id),
    FOREIGN KEY (actor_id) REFERENCES staff_users(id))`);
  // Extend the current schema in place; retain all existing requests and enum values.
  await column('security_requests', 'noise_source', "ENUM('inside_room','surrounding_area','unsure') NULL");
  await column('security_requests', 'submission_key', 'VARCHAR(64) NULL');
  const [indexes] = await db.query("SHOW INDEX FROM security_requests WHERE Key_name='uq_security_submission'");
  if (!indexes.length) await db.query('ALTER TABLE security_requests ADD UNIQUE KEY uq_security_submission (submitted_by, submission_key)');
  const [statuses] = await db.query("SHOW COLUMNS FROM security_requests LIKE 'status'");
  if (!statuses[0].Type.includes("'in_review'")) {
    const extended = statuses[0].Type.slice(0, -1) + ",'in_review')";
    await db.query(`ALTER TABLE security_requests MODIFY COLUMN status ${extended} NOT NULL DEFAULT 'pending'`);
  }
  await column('system_settings', 'system_enabled', 'BOOLEAN NOT NULL DEFAULT TRUE');
  await column('room_devices', 'last_seen', 'DATETIME NULL');
  await db.query(`CREATE TABLE IF NOT EXISTS security_student_evidence (
    request_id BIGINT UNSIGNED NOT NULL, report_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (request_id,report_id), FOREIGN KEY (request_id) REFERENCES security_requests(id),
    FOREIGN KEY (report_id) REFERENCES noise_reports(id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS security_quietscore_evidence (
    request_id BIGINT UNSIGNED NOT NULL, incident_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (request_id,incident_id), FOREIGN KEY (request_id) REFERENCES security_requests(id),
    FOREIGN KEY (incident_id) REFERENCES incidents(id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS security_comments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, request_id BIGINT UNSIGNED NOT NULL,
    author_id INT UNSIGNED NOT NULL, body VARCHAR(2000) NOT NULL,
    staff_visible BOOLEAN NOT NULL DEFAULT FALSE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES security_requests(id), FOREIGN KEY (author_id) REFERENCES staff_users(id),
    INDEX (request_id,staff_visible,id))`);

  await column('incidents', 'tracking_started_at', 'DATETIME(3) NULL');
  await db.query(`CREATE TABLE IF NOT EXISTS room_activity_state (
    room_id INT UNSIGNED PRIMARY KEY, status_color ENUM('green','yellow','red') NOT NULL DEFAULT 'green',
    episode_key CHAR(36) NULL, observed BOOLEAN NOT NULL DEFAULT FALSE, FOREIGN KEY (room_id) REFERENCES rooms(id))`);
  await column('room_activity_state', 'observed', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await column('security_request_history', 'actor_role', 'VARCHAR(30) NULL');
  await column('security_comments', 'actor_role', 'VARCHAR(30) NULL');
  // Lossless precision widening keeps old timestamps and orders new linked events within a second.
  for (const table of ['security_request_history','security_comments']) {
    const [columns] = await db.query(`SHOW COLUMNS FROM ${table} LIKE 'created_at'`);
    if (columns[0].Type !== 'datetime(3)') await db.query(`ALTER TABLE ${table} MODIFY COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
  }

  await db.query(`CREATE TABLE IF NOT EXISTS incident_activity (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, incident_id BIGINT UNSIGNED NULL,
    room_id INT UNSIGNED NOT NULL, episode_key CHAR(36) NULL, event_type VARCHAR(50) NOT NULL,
    from_state VARCHAR(10) NULL, to_state VARCHAR(10) NULL, cycle INT NULL,
    description VARCHAR(1000) NOT NULL, metadata JSON NULL, actor_id INT UNSIGNED NULL,
    device_id INT UNSIGNED NULL, event_key VARCHAR(160) NULL UNIQUE,
    occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    FOREIGN KEY (incident_id) REFERENCES incidents(id), FOREIGN KEY (room_id) REFERENCES rooms(id),
    FOREIGN KEY (actor_id) REFERENCES staff_users(id), FOREIGN KEY (device_id) REFERENCES room_devices(id),
    INDEX idx_incident_activity_time (incident_id,occurred_at,id), INDEX (room_id,episode_key))`);
  await db.query(`CREATE TABLE IF NOT EXISTS noise_report_activity (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, report_id BIGINT UNSIGNED NOT NULL,
    event_type VARCHAR(50) NOT NULL, previous_status VARCHAR(30) NULL, new_status VARCHAR(30) NULL,
    actor_id INT UNSIGNED NULL, actor_role VARCHAR(30) NULL, resolution_method VARCHAR(20) NULL,
    security_request_id BIGINT UNSIGNED NULL, description VARCHAR(1000) NOT NULL, legacy BOOLEAN NOT NULL DEFAULT FALSE,
    occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    FOREIGN KEY (report_id) REFERENCES noise_reports(id), FOREIGN KEY (actor_id) REFERENCES staff_users(id),
    FOREIGN KEY (security_request_id) REFERENCES security_requests(id),
    INDEX idx_report_activity_time (report_id,occurred_at,id))`);
  await column('noise_report_activity','legacy','BOOLEAN NOT NULL DEFAULT FALSE');
  await db.query(`CREATE TABLE IF NOT EXISTS monitoring_commands (
    device_id INT UNSIGNED NOT NULL, request_id VARCHAR(100) NOT NULL, payload_hash CHAR(64) NOT NULL,
    response_json JSON NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (device_id,request_id), FOREIGN KEY (device_id) REFERENCES room_devices(id))`);

  await require('./migrate-pilot-devices').migratePilotDevices(db);
  await require('./migrate-auth-policy').migrateAuthPolicy(db);
  await require('./migrate-onboarding').migrateOnboarding(db);
}
function pool() {
  return mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
}
if (require.main === module) {
  const db = pool();
  migrate(db).then(() => console.log('Additive migration complete. Existing records preserved.'))
    .catch(e => { console.error('Migration failed:', e.code || e.message); process.exitCode = 1; })
    .finally(() => db.end());
}
module.exports = { migrate, pool };
