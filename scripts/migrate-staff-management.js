// Additive extension of the existing staff model. Legacy enabled accounts remain active.
async function migrateStaffManagement(db) {
  const column=async(name,definition)=>{const [rows]=await db.query('SHOW COLUMNS FROM staff_users LIKE ?',[name]);if(!rows.length)await db.query(`ALTER TABLE staff_users ADD COLUMN ${name} ${definition}`);};
  await column('account_status',"ENUM('active','inactive','pending_setup') NOT NULL DEFAULT 'active'");
  await column('setup_complete','BOOLEAN NOT NULL DEFAULT TRUE');
  await db.query(`CREATE TABLE IF NOT EXISTS staff_management_lock (id INT PRIMARY KEY)`);
  await db.query('INSERT IGNORE INTO staff_management_lock (id) VALUES (1)');
  await db.query(`CREATE TABLE IF NOT EXISTS staff_account_requests (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, full_name VARCHAR(100) NOT NULL, email VARCHAR(255) NOT NULL,
    requested_role ENUM('admin','security','library_monitor') NOT NULL,
    status ENUM('pending','approved','declined') NOT NULL DEFAULT 'pending',
    pending_email VARCHAR(255) GENERATED ALWAYS AS (IF(status='pending',LOWER(TRIM(email)),NULL)) STORED UNIQUE,
    submitted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), reviewed_by INT UNSIGNED NULL,
    reviewed_at DATETIME(3) NULL, assigned_role ENUM('admin','security','library_monitor') NULL, account_id INT UNSIGNED NULL,
    FOREIGN KEY (reviewed_by) REFERENCES staff_users(id), FOREIGN KEY (account_id) REFERENCES staff_users(id), INDEX(status,submitted_at))`);
  await db.query(`CREATE TABLE IF NOT EXISTS staff_management_activity (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, action VARCHAR(50) NOT NULL,
    account_id INT UNSIGNED NULL, request_id INT UNSIGNED NULL, actor_id INT UNSIGNED NOT NULL,
    previous_values JSON NULL, new_values JSON NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    FOREIGN KEY (account_id) REFERENCES staff_users(id), FOREIGN KEY (request_id) REFERENCES staff_account_requests(id),
    FOREIGN KEY (actor_id) REFERENCES staff_users(id), INDEX(created_at,id))`);
}
module.exports={migrateStaffManagement};
