const { todayReports, libraryTimeZone, libraryDay } = require('./report-data');
const { asyncRoute } = require('./http');
const { reportEvent } = require('./activity');
const SOURCES = ['inside_room', 'surrounding_area', 'unsure'];
const PREFS = { toast_enabled: true, sound_enabled: true, volume: 50, quietscore_visual: true, student_visual: true, student_sound: false, theme: 'dark' };
const summaries = `SELECT s.id,s.room_id,r.room_name,s.noise_source,s.reason,s.status,s.created_at,s.updated_at,
  u.name AS submitted_by_name,
  (SELECT COUNT(*) FROM security_quietscore_evidence e WHERE e.request_id=s.id) AS quietscore_count,
  (SELECT COUNT(*) FROM security_student_evidence e WHERE e.request_id=s.id) AS student_count,
  (SELECT body FROM security_comments c WHERE c.request_id=s.id AND c.staff_visible=TRUE ORDER BY c.id DESC LIMIT 1) AS latest_staff_update,
  (SELECT created_at FROM security_comments c WHERE c.request_id=s.id AND c.staff_visible=TRUE ORDER BY c.id DESC LIMIT 1) AS latest_staff_update_at
  FROM security_requests s JOIN rooms r ON r.id=s.room_id JOIN staff_users u ON u.id=s.submitted_by`;
function installEscalations(app, { db, query, requireRoles, publish }) {
  app.get('/api/preferences', requireRoles('admin','security','library_monitor'), asyncRoute(async (req, res) => {
    const rows = await query('SELECT notification_preferences FROM staff_users WHERE id=?', [req.user.id]);
    let saved = rows[0]?.notification_preferences;
    if (typeof saved === 'string') saved = JSON.parse(saved);
    res.json({ ...PREFS, ...saved });
  }));
  app.put('/api/preferences', requireRoles('admin','security','library_monitor'), asyncRoute(async (req, res) => {
    const body = req.body || {};
    if (!Object.keys(body).length || Object.keys(body).some(k => !Object.hasOwn(PREFS,k) ||
      (k==='theme' ? !['light','dark','system'].includes(body[k]) : k==='volume' ? !Number.isInteger(body[k]) || body[k]<0 || body[k]>100 : typeof body[k]!=='boolean'))) {
      return res.status(400).json({ message: 'Provide only personal preferences, a valid theme (light, dark, system), and volume (0–100)' });
    }
    const connection = await db.getConnection();
    let preferences;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query('SELECT notification_preferences FROM staff_users WHERE id=? FOR UPDATE',[req.user.id]);
      const saved = rows[0]?.notification_preferences;
      preferences = { ...PREFS, ...(typeof saved==='string'?JSON.parse(saved):saved), ...body };
      await connection.query('UPDATE staff_users SET notification_preferences=? WHERE id=?',[JSON.stringify(preferences),req.user.id]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    publish('preferences', { changed: true }, false, req.user.id);
    res.json(preferences);
  }));
  app.get('/api/system/status', requireRoles('admin','security','library_monitor'), asyncRoute(async (req, res) => {
    const settings = await query('SELECT system_enabled FROM system_settings WHERE id=1');
    const rows = await query(`SELECT
      (SELECT COUNT(*) FROM rooms WHERE monitoring_enabled=TRUE) AS enabled_rooms,
      (SELECT COUNT(*) FROM room_devices d JOIN rooms r ON r.id=d.room_id
        WHERE d.enabled=TRUE AND r.monitoring_enabled=TRUE AND d.last_seen>=DATE_SUB(NOW(),INTERVAL 15 SECOND)
        AND d.microphone_state='active' AND d.microphone_seen_at>=DATE_SUB(NOW(),INTERVAL 15 SECOND) AND d.last_reading_at>=DATE_SUB(NOW(),INTERVAL 15 SECOND)) AS live_devices`);
    const state = settings[0]?.system_enabled === 0 ? 'system_disabled'
      : !settings.length ? 'unknown' : !rows[0].enabled_rooms ? 'monitoring_paused'
        : rows[0].live_devices > 0 ? 'live' : 'unknown';
    res.json({ state, library_date: libraryDay(), time_zone: libraryTimeZone });
  }));
  app.get('/api/escalation-support/today', requireRoles('admin','library_monitor'), asyncRoute(async (req, res) => {
    res.json(await todayReports(query));
  }));
  async function detail(id, ownerId) {
    const rows = await query(summaries + ' WHERE s.id=?' + (ownerId ? ' AND s.submitted_by=?' : ''), ownerId ? [id, ownerId] : [id]);
    if (!rows.length) return null;
    const [student, quietscore, comments, history] = await Promise.all([
      query(`SELECT n.id,n.room_id,r.room_name,n.noise_type AS description,n.submitted_at AS timestamp,n.report_status AS status,n.resolution_method
        FROM security_student_evidence e JOIN noise_reports n ON n.id=e.report_id JOIN rooms r ON r.id=n.room_id
        WHERE e.request_id=? ORDER BY n.submitted_at DESC`, [id]),
      query(`SELECT i.id,i.room_id,r.room_name,i.trigger_level AS description,i.started_at AS timestamp,i.status
        FROM security_quietscore_evidence e JOIN incidents i ON i.id=e.incident_id JOIN rooms r ON r.id=i.room_id
        WHERE e.request_id=? ORDER BY i.started_at DESC`, [id]),
      query(`SELECT c.id,c.body,c.created_at,u.name AS author_name${ownerId ? '' : ',c.staff_visible'} FROM security_comments c
        JOIN staff_users u ON u.id=c.author_id WHERE c.request_id=?${ownerId ? ' AND c.staff_visible=TRUE' : ''} ORDER BY c.id`, [id]),
      query(`SELECT h.status,h.created_at,u.name AS actor_name FROM security_request_history h
        JOIN staff_users u ON u.id=h.actor_id WHERE h.request_id=? ORDER BY h.id`, [id])
    ]);
    return { ...rows[0], student_reports: student, quietscore_reports: quietscore, comments, history };
  }
  app.get('/api/security/requests/mine', requireRoles('library_monitor'), asyncRoute(async (req, res) => {
    // The authenticated identity is the only owner filter; query parameters are never used.
    res.json(await query(summaries + ' WHERE s.submitted_by=? ORDER BY s.created_at DESC,s.id DESC', [req.user.id]));
  }));
  app.get('/api/security/requests/mine/:id', requireRoles('library_monitor'), asyncRoute(async (req, res) => {
    const result = await detail(req.params.id, req.user.id);
    if (!result) return res.status(404).json({ message: 'Escalation not found' });
    res.json(result);
  }));
  app.post('/api/security/requests', requireRoles('admin','library_monitor'), asyncRoute(async (req, res) => {
    const { room_id, reason, noise_source = null, submission_key = null } = req.body;
    const student = req.body.student_report_ids ?? [], quietscore = req.body.quietscore_report_ids ?? [];
    const validIds = ids => Array.isArray(ids) && ids.length <= 100 && ids.every(id => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length;
    if (!Number.isSafeInteger(room_id) || room_id < 1 || typeof reason !== 'string' || !reason.trim() || reason.length > 2000 ||
      (req.user.role === 'library_monitor' && !SOURCES.includes(noise_source)) ||
      (noise_source !== null && !SOURCES.includes(noise_source)) || !validIds(student) || !validIds(quietscore) ||
      (submission_key !== null && !/^[a-zA-Z0-9_-]{16,64}$/.test(submission_key))) {
      return res.status(400).json({ message: 'Choose a room and noise source, enter a reason, and select valid supporting reports' });
    }
    if (!(await query('SELECT id FROM rooms WHERE id=?', [room_id])).length) return res.status(404).json({ message: 'Room not found' });
    if (submission_key) {
      const existing = await query('SELECT id FROM security_requests WHERE submitted_by=? AND submission_key=?', [req.user.id, submission_key]);
      if (existing.length) return res.json({ id: existing[0].id, replayed: true });
    }
    if (student.length || quietscore.length) {
      const reports = await todayReports(query);
      if (student.some(id => !reports.student_reports.some(r => r.id === id)) || quietscore.some(id => !reports.quietscore_reports.some(r => r.id === id))) {
        return res.status(400).json({ message: 'Supporting reports must exist and be available in the current report scope. Reopen the picker to refresh.' });
      }
    }
    const connection = await db.getConnection();
    let id;
    try {
      await connection.beginTransaction();
      const [result] = await connection.query('INSERT INTO security_requests (room_id,submitted_by,reason,noise_source,submission_key) VALUES (?,?,?,?,?)',
        [room_id, req.user.id, reason.trim(), noise_source, submission_key]);
      id = result.insertId;
      await connection.query("INSERT INTO security_request_history (request_id,actor_id,status,actor_role) VALUES (?,?,'pending',?)", [id, req.user.id, req.user.role]);
      for (const reportId of student) {
        await connection.query('INSERT INTO security_student_evidence (request_id,report_id) VALUES (?,?)', [id, reportId]);
        await reportEvent(connection, reportId, 'security_attached', `Report attached to Security escalation #${id}.`, { actor:req.user, securityId:id });
      }
      for (const incidentId of quietscore) await connection.query('INSERT INTO security_quietscore_evidence (request_id,incident_id) VALUES (?,?)', [id, incidentId]);
      await require('./audit').appendAudit(connection,{actor:req.user,category:'escalations',action:'escalation_submitted',description:'Security escalation submitted',entity:'escalation',id,room:room_id,next:{status:'pending'}});
      await connection.commit();
    } catch (e) {
      await connection.rollback();
      if (e.code === 'ER_DUP_ENTRY' && submission_key) {
        const [existing] = await connection.query('SELECT id FROM security_requests WHERE submitted_by=? AND submission_key=?', [req.user.id, submission_key]);
        if (existing.length) return res.json({ id: existing[0].id, replayed: true });
      }
      throw e;
    } finally { connection.release(); }
    publish('security-request', { id, room_id }, true);
    res.status(201).json({ id, message: 'Security assistance requested' });
  }));
  app.get('/api/security/requests', requireRoles('security'), asyncRoute(async (req, res) => {
    res.json(await query(summaries + ' ORDER BY s.created_at DESC,s.id DESC'));
  }));
  app.get('/api/security/requests/:id', requireRoles('security'), asyncRoute(async (req, res) => {
    const result = await detail(req.params.id);
    if (!result) return res.status(404).json({ message: 'Escalation not found' });
    res.json(result);
  }));
  app.get('/api/security/requests/:id/history', requireRoles('security'), asyncRoute(async (req, res) => {
    res.json(await query(`SELECT h.*,u.name AS actor_name FROM security_request_history h
      JOIN staff_users u ON u.id=h.actor_id WHERE request_id=? ORDER BY h.id`, [req.params.id]));
  }));
  app.put('/api/security/requests/:id/status', requireRoles('security'), asyncRoute(async (req, res) => {
    const { status } = req.body;
    if (!['acknowledged','in_review','resolved','dismissed'].includes(status)) return res.status(400).json({ message: 'Invalid status' });
    const connection = await db.getConnection();
    let owner;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query('SELECT status,submitted_by,room_id FROM security_requests WHERE id=? FOR UPDATE', [req.params.id]);
      if (!rows.length || ['resolved','dismissed'].includes(rows[0].status) || rows[0].status === status ||
        (rows[0].status === 'in_review' && status === 'acknowledged')) {
        await connection.rollback();
        return res.status(rows.length ? 409 : 404).json({ message: 'Request missing or transition no longer available' });
      }
      owner = rows[0].submitted_by;
      await connection.query('UPDATE security_requests SET status=?,updated_at=NOW() WHERE id=?', [status, req.params.id]);
      await connection.query('INSERT INTO security_request_history (request_id,actor_id,status,actor_role) VALUES (?,?,?,?)', [req.params.id, req.user.id, status, req.user.role]);
      await require('./audit').appendAudit(connection,{actor:req.user,category:'escalations',action:'escalation_'+status,description:'Security escalation '+status.replace('_',' '),entity:'escalation',id:req.params.id,room:rows[0].room_id,previous:{status:rows[0].status},next:{status}});
      await connection.commit();
    } catch (e) { await connection.rollback(); throw e; } finally { connection.release(); }
    publish('security-update', { id: Number(req.params.id), status }, true);
    publish('escalation-update', { id: Number(req.params.id) }, false, owner);
    res.json({ message: 'Request updated' });
  }));
  app.post('/api/security/requests/:id/comments', requireRoles('security'), asyncRoute(async (req, res) => {
    const { body, staff_visible } = req.body;
    if (typeof body !== 'string' || !body.trim() || body.length > 2000 || typeof staff_visible !== 'boolean') {
      return res.status(400).json({ message: 'A comment and explicit staff visibility are required' });
    }
    const owners = await query('SELECT submitted_by FROM security_requests WHERE id=?', [req.params.id]);
    if (!owners.length) return res.status(404).json({ message: 'Escalation not found' });
    await query('INSERT INTO security_comments (request_id,author_id,body,staff_visible,actor_role) VALUES (?,?,?,?,?)', [req.params.id, req.user.id, body.trim(), staff_visible, req.user.role]);
    publish('security-update', { id: Number(req.params.id) }, true);
    if (staff_visible) publish('escalation-update', { id: Number(req.params.id) }, false, owners[0].submitted_by);
    res.status(201).json({ message: 'Comment saved' });
  }));
}
module.exports = { installEscalations };
