const { randomUUID } = require('node:crypto');
const { digest } = require('./passwords');
const { visibleReports } = require('./report-data');
const { appendReportNotification } = require('./report-notifications');
const { incidentAlerts } = require('./incident-alerts');
const fail = (status, message) => Object.assign(Error(message), { status, publicMessage: message });
async function reportEvent(connection, reportId, type, description, { previous = null, next = null, actor = null, method = null, securityId = null, occurredAt = null, legacy = false } = {}) {
  await connection.query(`INSERT INTO noise_report_activity
    (report_id,event_type,previous_status,new_status,actor_id,actor_role,resolution_method,security_request_id,description,occurred_at,legacy)
    VALUES (?,?,?,?,?,?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP(3)),?)`, [reportId,type,previous,next,actor?.id || null,actor?.role || null,method,securityId,description,occurredAt,legacy]);
  if(!legacy){
    const [[report]]=await connection.query('SELECT room_id FROM noise_reports WHERE id=?',[reportId]);
    const labels={report_submitted:'Student report submitted',report_resolved:method==='automatic'?'Student report automatically resolved':'Student report resolved manually',report_reopened:'Student report reopened',report_in_review:'Student report marked In Review',report_status_changed:'Student report status changed',security_attached:'Student report attached to security escalation'};
    await require('./audit').appendAudit(connection,{actor,anonymous:type==='report_submitted',category:'reports',action:method==='automatic'?'report_auto_resolved':type,description:labels[type]||'Student report updated',entity:'student_report',id:reportId,room:report?.room_id,previous:previous?{status:previous}:null,next:{status:next,resolution_method:method,security_request_id:securityId}});
  }

}
function createActivity(pool, publish) {
  const db = pool.promise ? pool.promise() : pool;
  const query = async (sql, values = []) => (await db.query(sql, values))[0];
  async function transaction(work) {
    const connection = await db.getConnection();
    try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; }
    catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async function incidentEvent(c, context, type, description, extra = {}) {
    await c.query(`INSERT INTO incident_activity
      (incident_id,room_id,episode_key,event_type,from_state,to_state,cycle,description,metadata,device_id,actor_id,event_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [context.incident?.id || null,context.room,context.episode,type,
      extra.from || null,extra.to || null,extra.cycle ?? context.incident?.escalation_count ?? null,description,
      extra.metadata ? JSON.stringify(extra.metadata) : null,context.device || null,extra.actor || null,extra.key || null]);
  }
  async function triggerAlert(c, context) {
    if (!context.incident || Number(context.incident.escalation_count) < 3) return;
    const [existing] = await c.query("SELECT id FROM incident_activity WHERE incident_id=? AND event_type='staff_alert_triggered' LIMIT 1", [context.incident.id]);
    if (existing.length) return;
    const crossingKnown=!!context.incident.tracking_started_at || context.crossedThreshold;
    await incidentEvent(c,context,crossingKnown?'staff_attention_threshold':'staff_attention_observed',
      crossingKnown?'Staff attention threshold reached (cycle 3).':`Existing incident meets the staff threshold at cycle ${context.incident.escalation_count}; the original crossing time is unknown.`,
      {key:`threshold:${context.incident.id}`});
    await incidentEvent(c,context,'staff_alert_triggered','Staff alert generated for the monitoring dashboard.', { key:`alert:${context.incident.id}`, metadata:{ channel:'in_app', delivery_confirmed:false } });
    context.alert = { incident_id:context.incident.id, room_id:context.room };
  }
  async function restart(c, context) {
    if (!context.incident) return false;
    await c.query('UPDATE incidents SET escalation_count=escalation_count+1,timer_started_at=NOW() WHERE id=?', [context.incident.id]);
    context.crossedThreshold=Number(context.incident.escalation_count)<3;
    context.incident.escalation_count++;
    await incidentEvent(c,context,'countdown_restarted',`Red countdown restarted: cycle ${context.incident.escalation_count} (${context.incident.escalation_count-1} restart(s)).`);
    await triggerAlert(c,context); return true;
  }
  async function stateChange(c, context, state, triggerLevel = 'red') {
    const previous = context.state;
    if (state !== 'green' && !context.episode) context.episode = randomUUID();
    // The device supplies its state; the server records transitions, not microphone thresholds/timers.
    if (state === 'red' && !context.incident) {
      const [created] = await c.query(`INSERT INTO incidents
        (room_id,trigger_level,status,escalation_count,timer_started_at,tracking_started_at)
        VALUES (?,?,'open',1,NOW(),NOW(3))`, [context.room,String(triggerLevel)]);
      await appendReportNotification(c,'quietscore',created.insertId,context.room);
      context.incident = { id:created.insertId, escalation_count:1, tracking_started_at:true }; context.created = true;
      await c.query('UPDATE incident_activity SET incident_id=? WHERE room_id=? AND episode_key=? AND incident_id IS NULL', [context.incident.id,context.room,context.episode]);

    }
    if (previous !== state) {
      await incidentEvent(c,context,`status_${state}`,`Room changed from ${previous || "unknown"} to ${state}.`, { from:previous,to:state });
      if (state === 'yellow') await incidentEvent(c,context,'yellow_warning','Yellow warning activated.', { from:previous,to:state });
    }
    if (context.created) {
      await incidentEvent(c,context,'incident_started','QuietScore incident created when the room entered red.');
      await incidentEvent(c,context,'countdown_started','Initial red countdown started (cycle 1; not a restart).');
    } else if (state === 'red' && previous !== null && previous !== 'red' && context.incident) await restart(c,context);
    if (state === 'green' && context.incident) {
      await c.query("UPDATE incidents SET status='resolved',resolved_at=NOW() WHERE id=? AND status='open'", [context.incident.id]);
      await incidentEvent(c,context,'incident_resolved','Incident resolved when the room returned to green.', { from:previous,to:'green' });
      context.resolved = context.incident.id; context.incident = null;
    }
    context.state = state;
    if (state === 'green') context.episode = null;
    await c.query('UPDATE room_activity_state SET status_color=?,episode_key=?,observed=TRUE WHERE room_id=?', [state,context.episode,context.room]);
    if (state === 'red') await triggerAlert(c,context);
  }
  async function monitoring(req, action) {
    const room = Number(req.body.room_id);
    let requestId = req.body.request_id;
    if (!Number.isSafeInteger(room) || room < 1) throw fail(400,'A valid room_id is required');
    if (requestId != null && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId))) throw fail(400,'Invalid request_id');
    if (action === 'state' && !requestId) throw fail(400,'A stable request_id is required for this device action');
    if (action === 'escalate' && !requestId) requestId = require('node:crypto').randomBytes(16).toString('hex');
    if (action === 'state' && !['green','yellow','red'].includes(req.body.state)) throw fail(400,'Invalid room state');
    if (action === 'start' && (req.body.trigger_level == null || String(req.body.trigger_level).length > 20)) throw fail(400,'trigger_level is required (maximum 20 characters)');
    const payloadHash = digest(JSON.stringify({action,body:req.body}));
    let notification;
    const result = await transaction(async c => {
      // Serializes every incident mutation per room, including simultaneous device requests.
      const [rooms] = await c.query('SELECT monitoring_enabled FROM rooms WHERE id=? FOR UPDATE', [room]);
      if (!rooms.length) throw fail(404,'Room not found');
      if (!rooms[0].monitoring_enabled) throw fail(409,'Monitoring Disabled');
      if (requestId) {
        const [saved] = await c.query('SELECT response_json,payload_hash FROM monitoring_commands WHERE device_id=? AND request_id=?', [req.device.id,requestId]);
        if (saved.length) {
          if (saved[0].payload_hash !== payloadHash) throw fail(409,'request_id was already used for a different action');
          return typeof saved[0].response_json === 'string' ? JSON.parse(saved[0].response_json) : saved[0].response_json;
        }
      }
      await c.query('INSERT IGNORE INTO room_activity_state (room_id) VALUES (?)',[room]);
      const [[snapshot]] = await c.query('SELECT * FROM room_activity_state WHERE room_id=?',[room]);
      const [incidents] = await c.query("SELECT id,escalation_count,tracking_started_at FROM incidents WHERE room_id=? AND status='open' ORDER BY started_at DESC,id DESC LIMIT 1",[room]);
      const context={room,device:req.device.id,state:snapshot.observed?snapshot.status_color:null,episode:snapshot.episode_key,incident:incidents[0]};
      if (context.incident && !context.episode) context.episode=randomUUID();
      if (action === 'state') await stateChange(c,context,req.body.state);
      if (action === 'start') await stateChange(c,context,'red',req.body.trigger_level);
      if (action === 'resolve') await stateChange(c,context,'green');
      if (action === 'escalate') {
        if (context.incident && context.state !== null && context.state !== 'red') throw fail(409,'Only a red countdown can restart');
        if (context.incident && context.state === null) {
          await incidentEvent(c,context,'status_red','Red observed from an authenticated countdown restart.',{to:'red'});
          context.state='red';
          await c.query("UPDATE room_activity_state SET status_color='red',episode_key=?,observed=TRUE WHERE room_id=?",[context.episode,room]);
        }
        await restart(c,context);
      }
      const [[delivery]]=await c.query("SELECT (EXISTS(SELECT 1 FROM report_notification_events WHERE kind='quietscore' AND report_id=?) OR EXISTS(SELECT 1 FROM incident_activity WHERE incident_id=? AND event_type='staff_alert_triggered')) AS recorded",[context.incident?.id||0,context.incident?.id||0]);
      const response={notification_recorded:!!delivery.recorded,incident_id:context.incident?.id || context.resolved || null,changed:context.incident || context.resolved ? 1 : 0,
        message:context.created ? 'Incident started' : context.resolved ? 'Incident resolved' : 'Monitoring activity recorded',
        created:!!context.created,cycle:context.incident?.escalation_count ?? null};
      if (requestId) await c.query('INSERT INTO monitoring_commands (device_id,request_id,payload_hash,response_json) VALUES (?,?,?,?)', [req.device.id,requestId,payloadHash,JSON.stringify(response)]);
      notification=context.alert; return response;
    });
    if (notification) publish('staff-alert',notification);
    publish('activity-update',{room_id:room});
    if (result.created) publish('report-created',{changed:true});
    return result;
  }
  async function createReport(body) {
    const {room_id,noise_type,severity,comments}=body;
    if (!Number.isSafeInteger(Number(room_id)) || Number(room_id)<1 || typeof noise_type!=='string' || !noise_type.trim() || noise_type.length>100 ||
      !['low','medium','high'].includes(severity) || (comments!=null && (typeof comments!=='string' || comments.length>4000))) throw fail(400,'Valid room_id, noise_type and severity are required');
    return transaction(async c=>{
      const [room]=await c.query('SELECT id FROM rooms WHERE id=?',[room_id]); if(!room.length) throw fail(404,'Room not found');
      const [result]=await c.query('INSERT INTO noise_reports (room_id,noise_type,severity,comments) VALUES (?,?,?,?)',[room_id,noise_type,severity,comments||null]);
      await appendReportNotification(c,'student',result.insertId,Number(room_id));
      await reportEvent(c,result.insertId,'report_submitted','Student noise report submitted.',{next:'open'});
      return {report_id:result.insertId,message:'Report submitted successfully'};
    });
  }
  async function reportStatus(id,status,actor) {
    if(!actor || !['admin','security','library_monitor'].includes(actor.role))throw fail(403,'Access denied for this role');
    if(!['open','in_review','resolved'].includes(status))throw fail(400,'Invalid report status');
    return transaction(async c=>{
      const [[report]]=await c.query('SELECT report_status,resolved_at,resolution_method,submitted_at FROM noise_reports WHERE id=? FOR UPDATE',[id]);
      if(!report || (actor.role==='library_monitor'&&!visibleReports([report],'submitted_at').length))throw fail(404,'Report not found');
      if(report.report_status===status)return {changed:0,message:'Report status unchanged'};
      if (report.resolved_at) {
        const [recorded] = await c.query("SELECT id FROM noise_report_activity WHERE report_id=? AND event_type='report_resolved' LIMIT 1",[id]);
        if (!recorded.length) await reportEvent(c,id,'report_resolved','Existing resolution timestamp retained from the legacy report record.',
          {next:'resolved',method:report.resolution_method,occurredAt:report.resolved_at,legacy:true});
      }
      await c.query(`UPDATE noise_reports SET report_status=?,resolution_method=IF(?='resolved','manual',NULL),
        resolved_at=IF(?='resolved',NOW(),NULL) WHERE id=?`,[status,status,status,id]);
      const type=report.report_status==='resolved'?'report_reopened':status==='resolved'?'report_resolved':status==='in_review'?'report_in_review':'report_status_changed';
      await reportEvent(c,id,type,`Report changed from ${report.report_status} to ${status}${status==='resolved'?' (manual resolution)':''}.`,{previous:report.report_status,next:status,actor,method:status==='resolved'?'manual':null});
      return {changed:1,message:'Report status updated'};
    });
  }
  async function autoResolve() {
    return transaction(async c=>{
      const [rows]=await c.query(`SELECT n.id FROM noise_reports n JOIN system_settings s ON s.id=1
        WHERE n.report_status='open' AND s.auto_resolve_enabled=1
        AND n.submitted_at<=DATE_SUB(NOW(),INTERVAL s.auto_resolve_minutes MINUTE) FOR UPDATE`);
      for(const row of rows){
        await c.query("UPDATE noise_reports SET report_status='resolved',resolution_method='automatic',resolved_at=NOW() WHERE id=? AND report_status='open'",[row.id]);
        await reportEvent(c,row.id,'report_resolved','Report automatically resolved after the configured timeout.',{previous:'open',next:'resolved',method:'automatic'});
      }
      return rows.length;
    });
  }
  async function authorizedReport(id,user) {
    const rows=await query('SELECT * FROM noise_reports WHERE id=?',[id]);
    if(!rows.length || (user.role==='library_monitor'&&!visibleReports(rows,'submitted_at').length))throw fail(404,'Report not found');
    return rows[0];
  }
  async function reportHistory(id,user) {
    const report=await authorizedReport(id,user);
    const securityFilter="(a.security_request_id IS NULL OR ?='security' OR (?='library_monitor' AND s.submitted_by=?))";
    const base=await query(`SELECT a.*,u.name AS actor_name FROM noise_report_activity a LEFT JOIN staff_users u ON u.id=a.actor_id
      LEFT JOIN security_requests s ON s.id=a.security_request_id WHERE a.report_id=? AND ${securityFilter} ORDER BY a.occurred_at,a.id`,[id,user.role,user.role,user.id]);
    const linked=await query(`SELECT h.id,h.status,h.created_at,h.actor_id,u.name AS actor_name,h.actor_role,h.request_id
      FROM security_student_evidence e JOIN security_request_history h ON h.request_id=e.request_id
      JOIN security_requests s ON s.id=e.request_id JOIN staff_users u ON u.id=h.actor_id
      WHERE e.report_id=? AND h.status<>'pending' AND (?='security' OR (?='library_monitor' AND s.submitted_by=?))
      ORDER BY h.created_at,h.id`,[id,user.role,user.role,user.id]);
    const comments=await query(`SELECT c.id,c.body,c.created_at,c.author_id,u.name AS actor_name,c.actor_role,c.request_id
      FROM security_student_evidence e JOIN security_comments c ON c.request_id=e.request_id
      JOIN security_requests s ON s.id=e.request_id JOIN staff_users u ON u.id=c.author_id
      WHERE e.report_id=? AND c.staff_visible=TRUE AND (?='security' OR (?='library_monitor' AND s.submitted_by=?)) ORDER BY c.created_at,c.id`,[id,user.role,user.role,user.id]);
    const events=base.map(r=>({...r,id:'report:'+r.id}));
    for(const row of linked)events.push({id:'security:'+row.id,event_type:'security_status_changed',occurred_at:row.created_at,actor_id:row.actor_id,actor_name:row.actor_name,actor_role:row.actor_role,security_request_id:row.request_id,new_status:row.status,description:`Linked Security escalation #${row.request_id}: ${row.status}.`});
    for(const row of comments)events.push({id:'security-comment:'+row.id,event_type:'security_update',occurred_at:row.created_at,actor_id:row.author_id,actor_name:row.actor_name,actor_role:row.actor_role,security_request_id:row.request_id,description:row.body});
    // Old timestamps are real report metadata, explicitly marked as legacy rather than backfilled into the database.
    if(!base.some(r=>r.event_type==='report_submitted'))events.push({id:'legacy:submitted',event_type:'report_submitted',occurred_at:report.submitted_at,description:'Report submission timestamp retained from the existing record.',legacy:true});
    if(report.resolved_at&&!base.some(r=>r.event_type==='report_resolved'))events.push({id:'legacy:resolved',event_type:'report_resolved',occurred_at:report.resolved_at,resolution_method:report.resolution_method,description:`Recorded ${report.resolution_method||''} resolution.`,legacy:true});
    events.sort((a,b)=>new Date(a.occurred_at)-new Date(b.occurred_at)||a.id.localeCompare(b.id,undefined,{numeric:true}));
    const related=await query(`SELECT DISTINCT i.*,r.room_name,e.request_id AS security_request_id,
      EXISTS (SELECT 1 FROM incident_activity ia WHERE ia.incident_id=i.id AND ia.event_type='staff_alert_triggered') AS recorded_staff_alert,
      EXISTS (SELECT 1 FROM incident_activity ia WHERE ia.incident_id=i.id AND ia.event_type='staff_alert_delivered') AS recorded_staff_display
      FROM security_student_evidence e JOIN security_quietscore_evidence q ON q.request_id=e.request_id
      JOIN security_requests s ON s.id=e.request_id JOIN incidents i ON i.id=q.incident_id JOIN rooms r ON r.id=i.room_id
      WHERE e.report_id=? AND (?='security' OR (?='library_monitor' AND s.submitted_by=?)) ORDER BY i.id,e.request_id`,[id,user.role,user.role,user.id]);
    const linked_incident_assessments=related.map(row=>({incident_id:row.id,room_name:row.room_name,security_request_id:row.security_request_id,...incidentAlerts(row)}))
      .filter(row=>row.legacy_alert_inference);
    return {events,linked_incident_assessments};
  }
  async function incidentHistory(id,user) {
    const rows=await query('SELECT * FROM incidents WHERE id=?',[id]);
    if(!rows.length||(user.role==='library_monitor'&&!visibleReports(rows,'started_at').length))throw fail(404,'Incident not found');
    const events=await query(`SELECT a.*,u.name AS actor_name FROM incident_activity a LEFT JOIN staff_users u ON u.id=a.actor_id WHERE a.incident_id=? ORDER BY a.occurred_at,a.id`,[id]);
    const assessment=incidentAlerts({...rows[0],recorded_staff_alert:events.some(e=>e.event_type==='staff_alert_triggered'),recorded_staff_display:events.some(e=>e.event_type==='staff_alert_delivered')});
    return {events,tracking_complete:!!rows[0].tracking_started_at,...assessment};
  }
  async function alertDisplayed(id,user) {
    if(user.role==='library_monitor')await incidentHistory(id,user);
    return transaction(async c=>{
      const [[lookup]]=await c.query('SELECT room_id FROM incidents WHERE id=?',[id]); if(!lookup)throw fail(404,'Incident not found');
      await c.query('SELECT id FROM rooms WHERE id=? FOR UPDATE',[lookup.room_id]);
      const [[incident]]=await c.query('SELECT id,room_id,status,escalation_count,tracking_started_at FROM incidents WHERE id=? FOR UPDATE',[id]);
      const [alerts]=await c.query("SELECT id FROM incident_activity WHERE incident_id=? AND event_type='staff_alert_triggered'",[id]);
      const legacyEligible=!incident.tracking_started_at && incident.status==='open' && incident.escalation_count>=3;
      if(!alerts.length && !legacyEligible)throw fail(409,'No recorded or currently eligible legacy alert exists for this incident');
      const key=`display:${id}:${user.id}`;
      const [seen]=await c.query('SELECT id FROM incident_activity WHERE event_key=?',[key]);
      if(!seen.length) await incidentEvent(c,{room:incident.room_id,incident,episode:null},'staff_alert_delivered','Browser reported that the in-app staff alert was displayed.',{actor:user.id,key,metadata:{channel:'in_app',confirmation:'browser_display',human_read_confirmed:false,actor_role:user.role,generation_recorded:!!alerts.length}});
      return {recorded:!seen.length};
    });
  }
  return {monitoring,createReport,reportStatus,autoResolve,reportHistory,incidentHistory,alertDisplayed,query};
}
module.exports={createActivity,reportEvent};
