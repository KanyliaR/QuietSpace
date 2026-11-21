require('dotenv').config({ quiet: true });
const { randomBytes } = require('node:crypto');
const { pool } = require('./migrate');
const { digest } = require('../lib/passwords');
(async () => {
  const room = Number(process.argv[2]);
  if (!Number.isSafeInteger(room) || room < 1) throw Error('Usage: node scripts/register-device.js ROOM_ID [NAME]');
  const db = pool();
  const c=await db.getConnection();
  try {
    const key = randomBytes(32).toString('hex');
    await c.beginTransaction();
    const [result]=await c.query('INSERT INTO room_devices (room_id,name,key_hash) VALUES (?,?,?)',
      [room, process.argv[3] || 'Room display', digest(key)]);
    await require('../lib/audit').appendAudit(c,{category:'devices',action:'device_registered',description:'Room device registered',entity:'device',id:result.insertId,room});
    await c.commit();
    console.log('Store this device key securely on the room device; it will not be shown again:\n' + key);
  } catch(e){await c.rollback();throw e;} finally { c.release();await db.end(); }
})().catch(e => { console.error(e.code || e.message); process.exitCode = 1; });
