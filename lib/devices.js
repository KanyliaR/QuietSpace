const {randomBytes}=require('node:crypto');
const {digest}=require('./passwords');
const {asyncRoute}=require('./http');
const cookie='quietspace_device';
function installDevices(app,{query,production}){
 const cookieOptions={httpOnly:true,sameSite:'strict',secure:production,path:'/api'};
 const select=`SELECT d.id,d.room_id,r.room_name,r.monitoring_enabled AS room_monitoring_enabled,
   (r.monitoring_enabled AND COALESCE((SELECT system_enabled FROM system_settings WHERE id=1),FALSE)) AS monitoring_enabled
   FROM room_devices d JOIN rooms r ON r.id=d.room_id`;
 const tokenOf=req=>/(?:^|;\s*)quietspace_device=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
 const deviceAuth=asyncRoute(async(req,res,next)=>{
   const key=/^Bearer ([a-f0-9]{64})$/.exec(req.get('Authorization')||'')?.[1];let devices;
   if(key)devices=await query(select+' WHERE d.key_hash=? AND d.enabled=TRUE',[digest(key)]);
   else{const token=tokenOf(req);if(!token)return res.status(401).json({message:'Device authentication required'});
     req.deviceSessionHash=digest(token);
     devices=await query(select+` JOIN room_device_sessions s ON s.device_id=d.id WHERE s.token_hash=? AND s.expires_at>NOW() AND d.enabled=TRUE`,[req.deviceSessionHash]);
   }
   if(!devices.length){res.clearCookie(cookie,cookieOptions);return res.status(401).json({message:'Device credential invalid, expired or revoked. Operator enrollment required.'});}
   if(req.deviceSessionHash&&['POST','PUT','PATCH','DELETE'].includes(req.method)&&req.get('X-QuietSpace-Request')!=='1')return res.status(403).json({message:'Missing request protection header'});
   if(req.query.room_id!==undefined&&Number(req.query.room_id)!==devices[0].room_id)return res.status(403).json({message:'Device is bound to another room'});
   req.device=devices[0];next();
 });
 app.post('/api/device/enroll',asyncRoute(async(req,res)=>{
   if(req.get('X-QuietSpace-Request')!=='1')return res.status(403).json({message:'Missing request protection header'});
   const key=/^Bearer ([a-f0-9]{64})$/.exec(req.get('Authorization')||'')?.[1],room=Number(req.body?.room_id);
   if(!key||!Number.isSafeInteger(room)||room<1)return res.status(400).json({message:'A device key and registered room ID are required'});
   const rows=await query(select+' WHERE d.key_hash=? AND d.enabled=TRUE',[digest(key)]);
   if(!rows.length)return res.status(401).json({message:'Invalid or revoked device key'});
   if(rows[0].room_id!==room)return res.status(403).json({message:'Device is bound to another room'});
   const token=randomBytes(32).toString('hex'),old=tokenOf(req);
   if(old)await query('DELETE FROM room_device_sessions WHERE token_hash=?',[digest(old)]);
   await query('INSERT INTO room_device_sessions (token_hash,device_id,expires_at) VALUES (?,?,DATE_ADD(NOW(),INTERVAL 90 DAY))',[digest(token),rows[0].id]);
   res.cookie(cookie,token,{...cookieOptions,maxAge:90*86400000});res.json({room_id:room,room_name:rows[0].room_name,message:'Device enrolled'});
 }));
 app.post('/api/device/disconnect',deviceAuth,asyncRoute(async(req,res)=>{
   if(req.deviceSessionHash)await query('DELETE FROM room_device_sessions WHERE token_hash=?',[req.deviceSessionHash]);
   await query("UPDATE room_devices SET microphone_state='stopped',microphone_seen_at=NOW(3) WHERE id=?",[req.device.id]);
   res.clearCookie(cookie,cookieOptions);res.json({message:'Device session disconnected. Enrollment is required to reconnect.'});
 }));
 app.get('/api/device/config',deviceAuth,asyncRoute(async(req,res)=>{
   await query('UPDATE room_devices SET last_seen=NOW() WHERE id=?',[req.device.id]);
   if(req.deviceSessionHash){await query('UPDATE room_device_sessions SET last_seen=NOW(),expires_at=DATE_ADD(NOW(),INTERVAL 90 DAY) WHERE token_hash=?',[req.deviceSessionHash]);res.cookie(cookie,tokenOf(req),{...cookieOptions,maxAge:90*86400000});}
   const [settings]=await query('SELECT staff_settings FROM system_settings WHERE id=1');const raw=settings?.staff_settings,values=typeof raw==='string'?JSON.parse(raw):raw;
   const [incident]=await query(`SELECT i.id,i.timer_started_at,i.escalation_count,
     (EXISTS(SELECT 1 FROM report_notification_events e WHERE e.kind='quietscore' AND e.report_id=i.id)
      OR EXISTS(SELECT 1 FROM incident_activity a WHERE a.incident_id=i.id AND a.event_type='staff_alert_triggered')) AS notification_recorded
     FROM incidents i WHERE room_id=? AND status='open' ORDER BY id DESC LIMIT 1`,[req.device.room_id]);
   const [state]=await query('SELECT status_color FROM room_activity_state WHERE room_id=? AND observed=TRUE',[req.device.room_id]);
   res.json({...req.device,yellowThreshold:values?.yellowThreshold??10,redThreshold:values?.redThreshold??17,server_time:new Date().toISOString(),current_state:state?.status_color||'green',incident:incident||null});
 }));
 app.post('/api/device/heartbeat',deviceAuth,asyncRoute(async(req,res)=>{
   if(Number(req.body?.room_id)!==req.device.room_id)return res.status(403).json({message:'Device is bound to another room'});
   const state=req.body.microphone_state;
   if(!['starting','active','error','blocked','stopped'].includes(state))return res.status(400).json({message:'Invalid microphone state'});
   if(state==='active'&&!req.device.monitoring_enabled)return res.status(409).json({message:'Monitoring Disabled'});
   await query('UPDATE room_devices SET microphone_state=?,microphone_seen_at=NOW(3),last_seen=NOW() WHERE id=?',[state,req.device.id]);res.json({received:true});
 }));
 return deviceAuth;
}
function deviceStatus(room){
 if(!room.system_enabled||!room.monitoring_enabled)return 'disabled';
 if(!Number(room.registered_devices))return 'unregistered';
 if(!Number(room.connected_devices))return 'offline';
 if(Number(room.active_devices))return 'active';
 return Number(room.error_devices)?'microphone_error':'connected';
}
module.exports={installDevices,deviceStatus};
