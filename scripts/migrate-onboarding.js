// Additive: never split or replace existing display names/passwords.
async function migrateOnboarding(db){
 for(const table of ['staff_users','staff_account_requests'])for(const column of ['first_name','last_name']){
  const [rows]=await db.query(`SHOW COLUMNS FROM ${table} LIKE ?`,[column]);
  if(!rows.length)await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} VARCHAR(50) NULL`);
 }
 await db.query(`CREATE TABLE IF NOT EXISTS staff_invitations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,revoked_at DATETIME(3) NULL,
  delivery_status ENUM('sending','accepted','failed') NOT NULL DEFAULT 'sending',
  provider_id VARCHAR(255) NULL,failure_code VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY(user_id) REFERENCES staff_users(id),INDEX(user_id,created_at))`);
 await db.query(`CREATE TABLE IF NOT EXISTS onboarding_rate_limits (
  bucket_hash CHAR(64) PRIMARY KEY,attempts INT UNSIGNED NOT NULL,expires_at DATETIME(3) NOT NULL,INDEX(expires_at))`);
}
module.exports={migrateOnboarding};
