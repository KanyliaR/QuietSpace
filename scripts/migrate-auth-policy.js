// Do not activate legacy UI-only policy values. NULL retains the existing server defaults.
async function migrateAuthPolicy(db){
 for(const [table,name,definition] of [['system_settings','security_policy','JSON NULL'],['staff_sessions','browser_close_cookie','BOOLEAN NOT NULL DEFAULT FALSE']]){
  const [columns]=await db.query(`SHOW COLUMNS FROM ${table} LIKE ?`,[name]);
  if(!columns.length)await db.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
 }
}
module.exports={migrateAuthPolicy};
