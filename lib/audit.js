// Canonical, backend-only audit writer. Call inside the business transaction.
const {libraryDay,libraryTimeZone}=require('./report-data');
const {midnight}=require('./analytics');
const {asyncRoute}=require('./http');
const {idleClause}=require('./auth-policy');
const categories=['account','monitoring','reports','escalations','devices','thresholds','system'];
const fail=message=>{throw Object.assign(Error(message),{status:400,publicMessage:message});};
const safeEnums={role:['admin','library_monitor','security'],requested_role:['admin','library_monitor','security'],assigned_role:['admin','library_monitor','security'],account_status:['active','inactive','pending_setup','deleted'],status:['open','pending','approved','declined','acknowledged','in_review','resolved','dismissed'],resolution_method:['manual','automatic'],theme:['dark','light','system']};
function safeValues(value){
 if(!value)return null;
 const result={};
 for(const [key,item] of Object.entries(value)){
  if(safeEnums[key]&&(item===null||safeEnums[key].includes(item)))result[key]=item;
  if(['locked','enabled','auto_resolve_enabled','lockoutTime','automaticLogout','sessionsExpire'].includes(key)&&typeof item==='boolean')result[key]=item;
  if(['yellowThreshold','redThreshold'].includes(key)&&Number.isFinite(item)&&item>=0&&item<=200)result[key]=item;
  if(['auto_resolve_minutes','roomAmount','security_request_id','maxLoginAttempts','lockoutMinutes','autoLogoutMinutes'].includes(key)&&(item===null||Number.isSafeInteger(item)&&item>=0))result[key]=item;
 }
 return JSON.stringify(result);
}
async function appendAudit(c,{actor=null,anonymous=false,category,action,description,entity,id,room=null,previous=null,next=null}){
  let name=anonymous?'Anonymous student submission':'QuietSpace System',role=anonymous?'anonymous':'automated',actorId=null;
  if(actor){const [[user]]=await c.query('SELECT id,name,role FROM staff_users WHERE id=?',[typeof actor==='object'?actor.id:actor]);if(!user)throw Error('Audit actor not found');name=user.name;role=user.role;actorId=user.id;}
  const [[location]]=room?await c.query('SELECT room_name FROM rooms WHERE id=?',[room]):[[]];
  await c.query(`INSERT INTO audit_events (actor_type,actor_id,actor_name,actor_role,category,action,description,entity_type,entity_id,room_id,room_name,previous_values,new_values)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,[actor?'staff':anonymous?'anonymous':'system',actorId,name,role,category,action,description,entity,String(id),room,location?.room_name||null,safeValues(previous),safeValues(next)]);
}
function dayBounds(day=libraryDay()){
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day+'T12:00:00Z').toISOString().slice(0,10)!==day)fail('Choose a valid calendar date');
  const tomorrow=new Date(day+'T12:00:00Z');tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
  return [new Date(midnight(day)),new Date(midnight(tomorrow.toISOString().slice(0,10)))];
}
function auditFilters(input){
  if(Object.keys(input).some(k=>!['search','role','category','room','from','to','page','limit'].includes(k))||Object.values(input).some(v=>typeof v!=='string'))fail('Invalid audit filters');
  const {search='',role='',category='',room='',from='',to='',page='1',limit='25'}=input;
  if(search.length>255||role&&!['admin','library_monitor','security','automated'].includes(role)||category&&!categories.includes(category)||room&&!/^[1-9]\d*$/.test(room)||!/^\d+$/.test(page)||+page<1||+page>1000000||!/^\d+$/.test(limit)||+limit<1||+limit>100)fail('Invalid audit filters');
  const where=[],args=[];
  if(search){where.push('(INSTR(LOWER(actor_name),LOWER(?))>0 OR INSTR(LOWER(description),LOWER(?))>0 OR INSTR(LOWER(COALESCE(room_name,\'\')),LOWER(?))>0 OR INSTR(LOWER(CONCAT(entity_type,\' #\',entity_id)),LOWER(?))>0)');args.push(search,search,search,search);}
  for(const [col,value] of [['actor_role',role],['category',category],['room_id',room]])if(value){where.push(col+'=?');args.push(value);}
  if(from){where.push('occurred_at>=?');args.push(dayBounds(from)[0]);}if(to){where.push('occurred_at<?');args.push(dayBounds(to)[1]);}if(from&&to&&from>to)fail('Start date must precede end date');
  return {clause:where.length?'WHERE '+where.join(' AND '):'',args,page:+page,limit:+limit};
}
const monitorEscalations=`FROM security_requests s JOIN rooms r ON r.id=s.room_id JOIN staff_users u ON u.id=s.submitted_by
 WHERE (EXISTS(SELECT 1 FROM security_request_history h WHERE h.request_id=s.id AND h.status='pending' AND h.actor_role='library_monitor')
 OR (u.role='library_monitor' AND NOT EXISTS(SELECT 1 FROM security_request_history h WHERE h.request_id=s.id AND h.status='pending' AND h.actor_role IS NOT NULL)))`;
const resolvedAt="(SELECT MAX(h.created_at) FROM security_request_history h WHERE h.request_id=s.id AND h.status='resolved')";
function escalationFilter(bucket,start,end){if(bucket==='open')return {sql:"s.status='pending'",args:[]};if(bucket==='review')return {sql:"s.status IN ('acknowledged','in_review')",args:[]};if(bucket==='resolved')return {sql:`s.status='resolved' AND ${resolvedAt}>=? AND ${resolvedAt}<?`,args:[start,end]};fail('Invalid escalation category');}
function installAdministration(app,{db,query,requireRoles,publish}){
 const admin=requireRoles('admin');
 app.get('/api/admin/audit-logs',admin,asyncRoute(async(req,res)=>{const f=auditFilters(req.query);await require('./lockout-audit').observeExpiredLockouts(db);const [[count],events]=await Promise.all([query(`SELECT COUNT(*) total FROM audit_events ${f.clause}`,f.args),query(`SELECT a.*,(u.deleted_at IS NOT NULL) actor_deleted FROM audit_events a LEFT JOIN staff_users u ON u.id=a.actor_id ${f.clause} ORDER BY a.occurred_at DESC,a.id DESC LIMIT ? OFFSET ?`,[...f.args,f.limit,(f.page-1)*f.limit])]);res.json({events,total:Number(count.total),page:f.page,limit:f.limit,time_zone:libraryTimeZone});}));
 app.get('/api/admin/overview',admin,asyncRoute(async(req,res)=>{
   const today=libraryDay(),[start,end]=dayBounds(today);
   // One consistent snapshot for counters and their preview records; polls cover idle expiry/midnight.
   const c=await db.getConnection();try{await c.beginTransaction();const q=async(sql,args=[]) =>(await c.query(sql,args))[0];
   const staff=await q(`SELECT u.role,COUNT(DISTINCT u.id) count FROM staff_users u JOIN staff_sessions s ON s.user_id=u.id WHERE u.account_status='active' AND u.setup_complete=TRUE AND u.deleted_at IS NULL AND s.expires_at>NOW() AND 1=1 ${idleClause(req.authPolicy)} AND (?=FALSE OR u.is_demo=FALSE) GROUP BY u.role`,[process.env.NODE_ENV==='production']);
   const [[pending]]=await c.query("SELECT COUNT(*) count FROM staff_account_requests WHERE status='pending'");
   const counts={};for(const bucket of ['open','review','resolved']){const f=escalationFilter(bucket,start,end);const [row]=await q(`SELECT COUNT(*) count ${monitorEscalations} AND ${f.sql}`,f.args);counts[bucket]=Number(row.count);}
   const events=await q('SELECT a.*,(u.deleted_at IS NOT NULL) actor_deleted FROM audit_events a LEFT JOIN staff_users u ON u.id=a.actor_id WHERE a.occurred_at>=? AND a.occurred_at<? ORDER BY a.occurred_at DESC,a.id DESC LIMIT 50',[start,end]);await c.commit();
   res.json({staff:Object.fromEntries(staff.map(r=>[r.role,Number(r.count)])),pending_requests:Number(pending.count),escalations:counts,events,library_date:today,time_zone:libraryTimeZone});
   }catch(e){await c.rollback();throw e;}finally{c.release();}
 }));
 app.get('/api/admin/escalations',admin,asyncRoute(async(req,res)=>{
   if(Object.keys(req.query).some(k=>!['bucket','page'].includes(k))||Object.values(req.query).some(v=>typeof v!=='string')||req.query.page&&(!/^\d+$/.test(req.query.page)||+req.query.page<1||+req.query.page>1000000))fail('Invalid preview page');
   const [start,end]=dayBounds(),f=escalationFilter(req.query.bucket,start,end),page=Number(req.query.page||1);
   const [count]=await query(`SELECT COUNT(*) total ${monitorEscalations} AND ${f.sql}`,f.args);
   const events=await query(`SELECT s.id,s.room_id,r.room_name,s.created_at,s.status,s.reason,u.name submitted_by_name,
    (SELECT MIN(h.created_at) FROM security_request_history h WHERE h.request_id=s.id AND h.status='acknowledged') acknowledged_at,
    ${resolvedAt} resolved_at ${monitorEscalations} AND ${f.sql} ORDER BY s.created_at DESC,s.id DESC LIMIT 25 OFFSET ?`,[...f.args,(page-1)*25]);
   // Deliberately excludes internal security comments and all response controls.
   res.json({events,total:Number(count.total),page,limit:25,time_zone:libraryTimeZone});
 }));
 async function change(req,kind){
   if(!req.body||typeof req.body.enabled!=='boolean'||Object.keys(req.body).some(k=>k!=='enabled'))fail('enabled must be boolean');
   if(kind==='room'&&(!/^[1-9]\d*$/.test(req.params.id)||!Number.isSafeInteger(Number(req.params.id))))fail('Invalid room identifier');
   const c=await db.getConnection();try{await c.beginTransaction();
    const room=kind==='room',table=room?'rooms':'system_settings',column=room?'monitoring_enabled':'system_enabled',id=room?Number(req.params.id):1;
    const [[current]]=await c.query(`SELECT ${column} enabled FROM ${table} WHERE id=? FOR UPDATE`,[id]);
    if(!current)throw Object.assign(Error('Room not found'),{status:404,publicMessage:'Room not found'});
    const changed=Boolean(current.enabled)!==req.body.enabled;
    if(changed){await c.query(`UPDATE ${table} SET ${column}=? WHERE id=?`,[req.body.enabled,id]);await appendAudit(c,{actor:req.user,category:'monitoring',action:`${kind}_monitoring_${req.body.enabled?'enabled':'disabled'}`,description:`${room?'Room':'System'} monitoring ${req.body.enabled?'enabled':'disabled'}`,entity:room?'room':'system',id,room:room?id:null,previous:{enabled:Boolean(current.enabled)},next:{enabled:req.body.enabled}});}
    await c.commit();if(changed)publish('monitoring',{changed:true,...(room?{room_id:id,monitoring_enabled:req.body.enabled}:{system_enabled:req.body.enabled})});return {changed,enabled:req.body.enabled,...(room?{room_id:id,monitoring_enabled:req.body.enabled}:{system_enabled:req.body.enabled})};
   }catch(e){await c.rollback();throw e;}finally{c.release();}
 }
 app.put('/api/rooms/:id/monitoring',admin,asyncRoute(async(req,res)=>res.json(await change(req,'room'))));
 app.put('/api/settings/monitoring',admin,asyncRoute(async(req,res)=>res.json(await change(req,'system'))));
}
module.exports={appendAudit,installAdministration,dayBounds,auditFilters,safeValues};
