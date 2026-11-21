// Additive tombstone support. Existing active, inactive and pending identities are unchanged.
async function migrateAccountDeletion(db){
 const [[status]]=await db.query("SHOW COLUMNS FROM staff_users LIKE 'account_status'");
 if(!status.Type.includes("'deleted'"))await db.query(`ALTER TABLE staff_users MODIFY COLUMN account_status ${status.Type.slice(0,-1)},'deleted') NOT NULL DEFAULT 'active'`);
 for(const [name,definition] of [['deleted_at','DATETIME(3) NULL'],['deleted_by','INT UNSIGNED NULL']]){
  const [columns]=await db.query('SHOW COLUMNS FROM staff_users LIKE ?',[name]);
  if(!columns.length)await db.query(`ALTER TABLE staff_users ADD COLUMN ${name} ${definition}`);
 }
}
module.exports={migrateAccountDeletion};
