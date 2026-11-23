const {randomBytes}=require('node:crypto');
const {digest}=require('./passwords');
const {asyncRoute}=require('./http');
const cookie='quietspace_device';

const sensorRegistry = new Map();

function updateSensorReading(roomId, level, recordedAt = new Date(), statusColor = null, publish = null) {
  const rid = Number(roomId);
  const nowIso = recordedAt instanceof Date ? recordedAt.toISOString() : new Date(recordedAt).toISOString();
  const numLevel = Number(level);

  let sensor = sensorRegistry.get(rid);
  if (!sensor) {
    sensor = {
      room_id: rid,
      status: 'online',
      last_recorded_at: nowIso,
      zero_db_streak: 0,
      total_readings: 0,
      last_level: numLevel,
      fault_reason: null
    };
    sensorRegistry.set(rid, sensor);
  }

  sensor.total_readings += 1;
  sensor.last_level = numLevel;
  sensor.last_recorded_at = nowIso;

  if (sensor.status === 'offline') {
    sensor.status = 'online';
    sensor.fault_reason = null;
    if (publish) {
      publish('sensor_status_changed', {
        room_id: rid,
        status: 'online',
        last_seen: nowIso
      });
    }
  }

  if (numLevel <= 0) {
    sensor.zero_db_streak += 1;
    if (sensor.zero_db_streak >= 3) {
      sensor.status = 'fault';
      sensor.fault_reason = 'Microphone Fault / Obstructed';
      if (publish) {
        publish('sensor_fault', {
          room_id: rid,
          status: 'fault',
          fault: 'Microphone Fault / Obstructed',
          zero_count: sensor.zero_db_streak,
          last_seen: nowIso
        });
        publish('sensor_status_changed', {
          room_id: rid,
          status: 'fault',
          reason: 'Microphone Fault / Obstructed',
          last_seen: nowIso
        });
      }
    }
  } else {
    if (sensor.status === 'fault') {
      sensor.status = 'online';
      sensor.fault_reason = null;
      if (publish) {
        publish('sensor_status_changed', {
          room_id: rid,
          status: 'online',
          last_seen: nowIso
        });
      }
    }
    sensor.zero_db_streak = 0;
  }

  return sensor;
}

function checkHardwareWatchdog(now = Date.now(), timeoutMs = 30000, publish = null) {
  const offlineEvents = [];
  const currentMs = typeof now === 'number' ? now : new Date(now).getTime();

  for (const [rid, sensor] of sensorRegistry.entries()) {
    if (sensor.status === 'online' && sensor.last_recorded_at) {
      const lastMs = new Date(sensor.last_recorded_at).getTime();
      if (currentMs - lastMs > timeoutMs) {
        sensor.status = 'offline';
        sensor.fault_reason = 'Sensor Disconnected / Timeout';
        const payload = {
          room_id: Number(rid),
          status: 'offline',
          reason: 'Sensor Disconnected / Timeout',
          last_seen: sensor.last_recorded_at
        };
        offlineEvents.push(payload);
        if (publish) {
          publish('sensor_status_changed', payload);
          publish('room_sensor_offline', payload);
        }
      }
    }
  }

  return offlineEvents;
}

function resetSensorRegistry() {
  sensorRegistry.clear();
}

function installDevices(app,{query,production,publish}){
 const broadcast = (event, data) => { if (typeof publish === 'function') publish(event, data); };
 const cookieOptions={httpOnly:true,sameSite:'strict',secure:production,path:'/api'};
 const select=`SELECT d.id,d.room_id,r.room_name,r.monitoring_enabled AS room_monitoring_enabled,
   (r.monitoring_enabled AND COALESCE((SELECT system_enabled FROM system_settings WHERE id=1),FALSE)) AS monitoring_enabled
   FROM room_devices d JOIN rooms r ON r.id=d.room_id`;
 const tokenOf=req=>/(?:^|;\s*)quietspace_device=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
 const deviceAuth=asyncRoute(async(req,res,next)=>{
  if(req.device)return next();
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

 app.get('/api/hardware/status', (req, res) => {
   const sensors = Array.from(sensorRegistry.values());
   res.json({
     sensors,
     total_sensors: sensors.length,
     online_count: sensors.filter(s => s.status === 'online').length,
     offline_count: sensors.filter(s => s.status === 'offline').length,
     fault_count: sensors.filter(s => s.status === 'fault').length,
     timestamp: new Date().toISOString()
   });
 });

 app.post('/api/hardware/heartbeat', (req, res) => {
   const { room_id, status } = req.body || {};
   if (room_id == null) {
     return res.status(400).json({ message: 'room_id is required' });
   }

   const rid = Number(room_id);
   const nowIso = new Date().toISOString();
   let sensor = sensorRegistry.get(rid);

   if (!sensor) {
     sensor = {
       room_id: rid,
       status: status === 'disconnected' ? 'offline' : 'online',
       last_recorded_at: nowIso,
       zero_db_streak: 0,
       total_readings: 0,
       last_level: null,
       fault_reason: status === 'disconnected' ? 'Sensor Reported Disconnected' : null
     };
     sensorRegistry.set(rid, sensor);
   } else {
     const wasOffline = sensor.status === 'offline';
     sensor.last_recorded_at = nowIso;
     if (status === 'disconnected') {
       sensor.status = 'offline';
       sensor.fault_reason = 'Sensor Reported Disconnected';
       broadcast('sensor_status_changed', {
         room_id: rid,
         status: 'offline',
         reason: 'Sensor Reported Disconnected',
         last_seen: nowIso
       });
     } else if (wasOffline) {
       sensor.status = 'online';
       sensor.fault_reason = null;
       broadcast('sensor_status_changed', {
         room_id: rid,
         status: 'online',
         last_seen: nowIso
       });
     }
   }

   res.json({
     message: 'Heartbeat acknowledged',
     sensor
   });
 });

 app.post('/api/hardware/watchdog/check', (req, res) => {
   const { timeout_ms } = req.body || {};
   const events = checkHardwareWatchdog(Date.now(), timeout_ms ? Number(timeout_ms) : 30000, broadcast);
   res.json({
     checked_at: new Date().toISOString(),
     offline_count: events.length,
     events
   });
 });

 const watchdogInterval = setInterval(() => {
   checkHardwareWatchdog(Date.now(), 30000, broadcast);
 }, 10000);
 if (watchdogInterval.unref) {
   watchdogInterval.unref();
 }
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
module.exports={
  installDevices,
  deviceStatus,
  sensorRegistry,
  updateSensorReading,
  checkHardwareWatchdog,
  resetSensorRegistry
};
