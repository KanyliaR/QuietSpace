/* Additive device persistence/status plus an in-place pilot label migration. */
async function migratePilotDevices(db){
  async function column(name,definition){const [rows]=await db.query('SHOW COLUMNS FROM room_devices LIKE ?',[name]);if(!rows.length)await db.query(`ALTER TABLE room_devices ADD COLUMN ${name} ${definition}`);}
  await column('microphone_state',"VARCHAR(20) NULL");
  await column('microphone_seen_at','DATETIME(3) NULL');
  await column('last_reading_at','DATETIME(3) NULL');
  await db.query(`CREATE TABLE IF NOT EXISTS room_device_sessions (
    token_hash CHAR(64) PRIMARY KEY,device_id INT UNSIGNED NOT NULL,expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(device_id) REFERENCES room_devices(id) ON DELETE CASCADE,INDEX(expires_at))`);
  await db.query(`CREATE TABLE IF NOT EXISTS room_name_history (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,room_id INT UNSIGNED NOT NULL,previous_name VARCHAR(100) NOT NULL,
    previous_location VARCHAR(255) NOT NULL,new_name VARCHAR(100) NOT NULL,changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(room_id) REFERENCES rooms(id),UNIQUE KEY(room_id,previous_name,new_name))`);
  const c=await db.getConnection();try{await c.beginTransaction();
    const [rooms]=await c.query('SELECT id,room_name,location FROM rooms ORDER BY id FOR UPDATE');
    for(const [previous,next] of [['Room 311','Room 232'],['Room 312','Room 233'],['Room 313','Room 234']]){
      const old=rooms.find(r=>r.room_name===previous),target=rooms.find(r=>r.room_name===next);
      if(old&&target&&old.id!==target.id)throw Error(`Room migration conflict: ${previous} and ${next} already exist as different records`);
      if(!old)continue;
      await c.query('INSERT IGNORE INTO room_name_history (room_id,previous_name,previous_location,new_name) VALUES (?,?,?,?)',[old.id,previous,old.location,next]);
      await c.query('UPDATE rooms SET room_name=?,location=? WHERE id=?',[next,'Bluford Library 2nd Floor',old.id]);
    }
    await c.commit();
  }catch(e){await c.rollback();throw e;}finally{c.release();}
}
module.exports={migratePilotDevices};
