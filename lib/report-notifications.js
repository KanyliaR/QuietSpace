const { asyncRoute } = require('./http');
const { visibleReports } = require('./report-data');
// Serialize new-event allocation until its creating transaction commits. A later
// committed ID can never hide an earlier, uncommitted creation behind a cursor.
async function appendReportNotification(connection, kind, reportId, roomId) {
  await connection.query('SELECT id FROM report_notification_clock WHERE id=1 FOR UPDATE');
  await connection.query('INSERT INTO report_notification_events (kind,report_id,room_id) VALUES (?,?,?)', [kind,reportId,roomId]);
}
function installReportNotifications(app, { db, requireRoles, publish }) {
  const staff = requireRoles('admin','security','library_monitor');
  async function operation(user, work) {
    const c = await db.getConnection();
    try {
      await c.beginTransaction();
      // Use the same account-first lock order as personal preference saves.
      // This also serializes duplicate state inserts before upgrading their locks.
      await c.query('SELECT id FROM staff_users WHERE id=? FOR UPDATE',[user.id]);
      const [inserted] = await c.query('INSERT IGNORE INTO staff_notification_state (user_id) VALUES (?)',[user.id]);
      const [[state]] = await c.query('SELECT * FROM staff_notification_state WHERE user_id=? FOR UPDATE',[user.id]);
      const [[{ latest }]] = await c.query('SELECT COALESCE(MAX(id),0) AS latest FROM report_notification_events');
      if (inserted.affectedRows) {
        state.delivered_through=state.quietscore_read_through=state.student_read_through=Number(latest);
        await c.query('UPDATE staff_notification_state SET delivered_through=?,quietscore_read_through=?,student_read_through=? WHERE user_id=?',[latest,latest,latest,user.id]);
      }
      const [rows] = await c.query(`SELECT e.id,e.kind,e.report_id,e.room_id,r.room_name,
        COALESCE(n.submitted_at,i.started_at,e.created_at) AS timestamp
        FROM report_notification_events e JOIN rooms r ON r.id=e.room_id
        LEFT JOIN noise_reports n ON e.kind='student' AND n.id=e.report_id
        LEFT JOIN incidents i ON e.kind='quietscore' AND i.id=e.report_id
        WHERE e.id>? AND e.id<=? AND (n.id IS NOT NULL OR i.id IS NOT NULL) ORDER BY e.id`,[Math.min(state.delivered_through,state.quietscore_read_through,state.student_read_through),latest]);
      const visible = user.role==='library_monitor' ? visibleReports(rows,'timestamp') : rows;
      const result = await work(c,state,visible,Number(latest));
      await c.commit(); return result;
    } catch(error) { await c.rollback(); throw error; } finally { c.release(); }
  }
  const snapshot = (state,rows,through) => ({ through, unread: {
    quietscore: rows.filter(e=>e.kind==='quietscore' && e.id>state.quietscore_read_through).length,
    student: rows.filter(e=>e.kind==='student' && e.id>state.student_read_through).length
  }});
  app.get('/api/report-notifications',staff,asyncRoute(async(req,res)=>res.json(await operation(req.user,async(c,state,rows,latest)=>snapshot(state,rows,latest)))));
  app.post('/api/report-notifications/claim',staff,asyncRoute(async(req,res)=>{
    const body=req.body || {};
    if(Object.keys(body).some(k=>k!=='silent') || (body.silent!==undefined && typeof body.silent!=='boolean')) return res.status(400).json({message:'Only a boolean silent option is supported'});
    const result = await operation(req.user,async(c,state,rows,latest)=>{
      const events = body.silent ? [] : rows.filter(e=>e.id>state.delivered_through);
      await c.query('UPDATE staff_notification_state SET delivered_through=? WHERE user_id=?',[latest,req.user.id]);
      let student_sound=false;
      if(events.some(e=>e.kind==='student')) {
        const [[account]]=await c.query('SELECT notification_preferences FROM staff_users WHERE id=?',[req.user.id]);
        const preferences=typeof account.notification_preferences==='string'?JSON.parse(account.notification_preferences):account.notification_preferences;
        if(preferences?.student_sound===true && preferences.sound_enabled!==false && (!state.last_student_sound_at || Date.now()-new Date(state.last_student_sound_at).getTime()>=4000)) {
          student_sound=true;
          await c.query('UPDATE staff_notification_state SET last_student_sound_at=NOW(3) WHERE user_id=?',[req.user.id]);
        }
      }
      return {...snapshot(state,rows,latest),events,student_sound};
    });
    res.json(result);
  }));
  app.put('/api/report-notifications/read',staff,asyncRoute(async(req,res)=>{
    const {kind,through} = req.body || {};
    if(!['quietscore','student'].includes(kind) || !Number.isSafeInteger(through) || through<0 || Object.keys(req.body).some(k=>!['kind','through'].includes(k))) return res.status(400).json({message:'A valid report kind and read-through cursor are required'});
    const result = await operation(req.user,async(c,state,rows,latest)=>{
      const column = kind==='quietscore'?'quietscore_read_through':'student_read_through';
      state[column]=Math.max(Number(state[column]),Math.min(through,latest));
      await c.query(`UPDATE staff_notification_state SET ${column}=? WHERE user_id=?`,[state[column],req.user.id]);
      return snapshot(state,rows,latest);
    });
    publish('report-notifications-read',{changed:true},false,req.user.id);
    res.json(result);
  }));
}
module.exports={appendReportNotification,installReportNotifications};
