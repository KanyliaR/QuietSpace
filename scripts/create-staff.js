require('dotenv').config({ quiet: true });
const { pool } = require('./migrate');
const { hashPassword } = require('../lib/passwords');
(async () => {
  const [username, role, email] = process.argv.slice(2);
  const password = process.env.QUIETSPACE_STAFF_PASSWORD;
  if (!/^[a-zA-Z0-9_.-]{3,100}$/.test(username || '') || !['admin','security','library_monitor'].includes(role)) {
    throw Error('Usage: node scripts/create-staff.js USERNAME admin|security|library_monitor [EMAIL]');
  }
  if (!password || password.length < 12 || password.length > 256 || password === 'quiet123') {
    throw Error('Set QUIETSPACE_STAFF_PASSWORD to a unique password of 12–256 characters.');
  }
  const db = pool();
  const c=await db.getConnection();
  try {
    await c.beginTransaction();
    const [result]=await c.query('INSERT INTO staff_users (name,email,username,role,password_hash,is_demo) VALUES (?,?,?,?,?,FALSE)',
      [username, email || `${username}@quietspace.local`, username, role, await hashPassword(password)]);
    await require('../lib/audit').appendAudit(c,{category:'account',action:'account_created',description:'Staff account created through administration CLI',entity:'staff_account',id:result.insertId,next:{role,account_status:'active'}});
    await c.commit();
    console.log('Staff account created. Existing accounts were not changed.');
  } catch(e){await c.rollback();throw e;} finally { c.release();await db.end(); }
})().catch(e => { console.error(e.code || e.message); process.exitCode = 1; });
