const { asyncRoute } = require('./http');
const { buildChart, GAP_MS } = require('./analytics-sessions');
const { libraryDay, libraryTimeZone } = require('./report-data');
// Existing device capture evaluates every second; the system considers devices
// stale after 15 seconds. Analytics excludes the entire interval beyond that
// continuity limit rather than treating offline time as quiet.
const CONTINUITY_GAP_MS = GAP_MS;
const DAY = 86400000;
const STATES = ['green','yellow','red'];
const COLORS = ['#409bff','#18d7a1','#ac76f4','#ffae5b','#58c8e8','#ed86be'];
const partsFormatter = new Intl.DateTimeFormat('en-CA',{timeZone:libraryTimeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function shiftDay(day, delta) { const date=new Date(day+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+delta);return date.toISOString().slice(0,10); }
function midnight(day) {
  const target=Date.parse(day+'T00:00:00Z');let guess=target;
  for(let n=0;n<3;n++) {
    const p=Object.fromEntries(partsFormatter.formatToParts(new Date(guess)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    const local=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
    guess+=target-local;
  }
  return guess;
}
function windowFor(range, now, earliest) {
  const end=+new Date(now);
  const start=range==='today'?midnight(libraryDay(end)):range==='all'?(earliest?Math.min(+new Date(earliest),end):midnight(libraryDay(end))):end-Number(range)*DAY;
  const duration=end-start;
  return {start,end,previousStart:start-duration,previousEnd:start,compare:range!=='all'&&duration>0};
}
function bucketsFor(start,end) {
  const span=end-start;
  const unit=span<=7*DAY?'hour':span<=90*DAY?'day':'week';
  const firstDay=libraryDay(start);
  function bucket(time) {
    let from,to;
    if(unit==='hour') {from=Math.floor(time/3600000)*3600000;to=from+3600000;}
    else {
      let day=libraryDay(time);
      if(unit==='week') {const offset=Math.floor((Date.parse(day)-Date.parse(firstDay))/DAY);day=shiftDay(firstDay,Math.floor(offset/7)*7);}
      from=midnight(day);to=midnight(shiftDay(day,unit==='week'?7:1));
    }
    return {start:Math.max(start,from),end:Math.min(end,to)};
  }
  return {unit,bucket};
}
function blank(room) {return {...room,reading_count:0,sum:0,average_index:null,durations_ms:{green:0,yellow:0,red:0},monitored_ms:0,quiet_percent:null,episodes:{yellow:0,red:0,total:0,partial:0},gap_breaks:0,duplicate_timestamps:0,performance:'unavailable',points:[]};}
function summarize(rooms, readings, start, end) {
  const result=rooms.map(blank);
  const {unit,bucket}=bucketsFor(start,end);
  for(const room of result) {
    const rows=readings.filter(r=>Number(r.room_id)===Number(room.id)).map(r=>({...r,time:+new Date(r.recorded_at)})).filter(r=>Number.isFinite(r.time)).sort((a,b)=>a.time-b.time||Number(a.id)-Number(b.id));
    const points=new Map(),unique=[];
    for(const row of rows) {
      if(row.time>=start&&row.time<end) {
        const value=row.level===null?NaN:Number(row.level);
        if(Number.isFinite(value)&&value>=0) {
          room.sum+=value;room.reading_count++;
          const b=bucket(row.time);
          if(!points.has(b.start))points.set(b.start,{...b,sum:0,samples:0,first:row.time,last:row.time});
          const point=points.get(b.start);point.sum+=value;point.samples++;point.last=row.time;
        }
      }
      if(unique.length&&unique[unique.length-1].time===row.time) {
        if(row.time>=start&&row.time<end)room.duplicate_timestamps++;
        unique[unique.length-1]=row; // Last stored state wins when second-precision timestamps collide.
      } else unique.push(row);
    }
    let previous=null,serial=0;const runs=new Map(),observed=new Map();
    const includeRun=(row)=>{if(row&&['yellow','red'].includes(row.status_color))observed.set(row.run,runs.get(row.run));};
    for(const row of unique) {
      if(!STATES.includes(row.status_color)) {previous=null;continue;}
      const delta=previous?row.time-previous.time:Infinity;
      const connected=previous&&delta>0&&delta<=CONTINUITY_GAP_MS;
      if(previous&&delta>CONTINUITY_GAP_MS&&row.time>start&&previous.time<end)room.gap_breaks++;
      if(!connected||row.status_color!==previous.status_color) {
        if(previous) { if(connected)runs.get(previous.run).end=row.time;else runs.get(previous.run).partial=true; }
        row.run=++serial;
        runs.set(row.run,{state:row.status_color,partial:!connected||row.time<start,end:null});
      } else row.run=previous.run;
      if(row.time>=start&&row.time<end)includeRun(row);
      if(connected) {
        const duration=Math.max(0,Math.min(end,row.time)-Math.max(start,previous.time));
        room.durations_ms[previous.status_color]+=duration;
        if(duration>0)includeRun(previous);
      }
      previous=row;
    }
    for(const run of observed.values()) {room.episodes[run.state]++;if(run.partial||run.end===null||run.end>end)room.episodes.partial++;}
    room.episodes.total=room.episodes.yellow+room.episodes.red;
    room.monitored_ms=Object.values(room.durations_ms).reduce((a,b)=>a+b,0);
    room.quiet_percent=room.monitored_ms?room.durations_ms.green/room.monitored_ms*100:null;
    room.average_index=room.reading_count?room.sum/room.reading_count:null;
    room.performance=room.episodes.red?'high':room.episodes.yellow?'elevated':room.monitored_ms?'quiet':'unavailable';
    let prior;
    room.points=[...points.values()].map(p=>{
      const point={timestamp:new Date(p.start).toISOString(),end_at:new Date(p.end).toISOString(),average_index:p.sum/p.samples,samples:p.samples,connected:!!prior&&p.first-prior.last<=CONTINUITY_GAP_MS};
      prior=p;return point;
    });
    delete room.sum;
  }
  return {rooms:result,unit};
}
function combined(rooms) {
  const count=rooms.reduce((n,r)=>n+r.reading_count,0),durations={green:0,yellow:0,red:0},episodes={yellow:0,red:0,total:0,partial:0};
  for(const r of rooms){for(const k of STATES)durations[k]+=r.durations_ms[k];for(const k of Object.keys(episodes))episodes[k]+=r.episodes[k];}
  const monitored=Object.values(durations).reduce((a,b)=>a+b,0);
  const points=new Map();
  for(const r of rooms)for(const p of r.points){if(!points.has(p.timestamp))points.set(p.timestamp,{timestamp:p.timestamp,end_at:p.end_at,sum:0,samples:0});const b=points.get(p.timestamp);b.sum+=p.average_index*p.samples;b.samples+=p.samples;}
  let loudest=null;
  for(const p of points.values()){const value=p.sum/p.samples;if(!loudest||value>loudest.average_index||(value===loudest.average_index&&p.timestamp<loudest.timestamp))loudest={timestamp:p.timestamp,end_at:p.end_at,average_index:value,samples:p.samples};}
  return {reading_count:count,average_index:count?rooms.reduce((n,r)=>n+(r.average_index||0)*r.reading_count,0)/count:null,monitored_ms:monitored,durations_ms:durations,quiet_percent:monitored?durations.green/monitored*100:null,distribution:Object.fromEntries(STATES.map(k=>[k,monitored?durations[k]/monitored*100:null])),episodes,loudest};
}
function calculate(rooms,readings,window,roomId='all',sessionId=null) {
  const current=summarize(rooms,readings,window.start,window.end),previous=summarize(rooms,readings,window.previousStart,window.previousEnd);
  const selected=current.rooms.filter(r=>roomId==='all'||Number(r.id)===Number(roomId));
  const prior=previous.rooms.filter(r=>roomId==='all'||Number(r.id)===Number(roomId));
  const summary=combined(selected),before=combined(prior);
  const noiseChange=window.compare&&summary.average_index!==null&&before.average_index>0?(summary.average_index-before.average_index)/before.average_index*100:null;
  const quietChange=window.compare&&summary.quiet_percent!==null&&before.quiet_percent!==null?summary.quiet_percent-before.quiet_percent:null;
  const chart=buildChart(rooms.filter(r=>roomId==='all'||Number(r.id)===Number(roomId)),readings,window,bucketsFor(window.start,window.end),sessionId);
  return {chart,summary:{...summary,coverage_percent:(window.end-window.start)>0&&selected.length?summary.monitored_ms/((window.end-window.start)*selected.length)*100:null,comparison:{average_percent:noiseChange,quiet_percentage_points:quietChange,previous_readings:window.compare?before.reading_count:0}},bucket_unit:current.unit,series:selected.map(r=>({room_id:r.id,room_name:r.room_name,color:r.color,points:r.points})),rooms:current.rooms.map(({points,...r})=>({...r,selected:roomId!=='all'&&Number(r.id)===Number(roomId)}))};
}
function installAnalytics(app,{query,requireRoles}) {
  app.get('/api/analytics',requireRoles('admin','security'),asyncRoute(async(req,res)=>{
    const range=req.query.range??'7',room=req.query.room??'all',session=req.query.session??null;
    if(Object.keys(req.query).some(k=>!['range','room','session'].includes(k))||typeof range!=='string'||!['today','7','30','90','all'].includes(range)||typeof room!=='string'||(room!=='all'&&!/^[1-9]\d*$/.test(room)))return res.status(400).json({message:'Choose a valid room and time period'});
    if(session!==null&&(typeof session!=='string'||!/^\d+:\d+$/.test(session)))return res.status(400).json({message:'Choose a valid recording session'});
    const rooms=await query('SELECT id,room_name,monitoring_enabled FROM rooms ORDER BY id');
    if(room!=='all'&&!rooms.some(r=>String(r.id)===room))return res.status(404).json({message:'Room not found'});
    rooms.forEach(r=>{r.color=COLORS[(Number(r.id)-1)%COLORS.length];});
    const now=new Date();
    const [availability]=await query('SELECT MIN(recorded_at) AS first_reading,MAX(recorded_at) AS last_reading,COUNT(*) AS total_readings FROM sound_readings WHERE recorded_at<=?',[now]);
    const window=windowFor(range,now,availability.first_reading);
    const dataStart=(window.compare?window.previousStart:window.start)-CONTINUITY_GAP_MS;
    const readings=rooms.length?await query('SELECT id,room_id,level,status_color,recorded_at FROM sound_readings WHERE room_id IN (?) AND recorded_at>=? AND recorded_at<=? ORDER BY room_id,recorded_at,id',[rooms.map(r=>r.id),new Date(dataStart),now]):[];
    const [configuration]=await query('SELECT staff_settings FROM system_settings WHERE id=1');
    const saved=typeof configuration?.staff_settings==='string'?JSON.parse(configuration.staff_settings):configuration?.staff_settings;
    const [eventCoverage]=await query("SELECT COUNT(*) AS transitions FROM incident_activity WHERE event_type IN ('status_green','status_yellow','status_red') AND occurred_at>=? AND occurred_at<? AND room_id IN (?)",[new Date(window.start),now,room==='all'?(rooms.length?rooms.map(r=>r.id):[0]):[Number(room)]]);
    res.set('Cache-Control','no-store');
    res.json({...calculate(rooms,readings,window,room,session),range,room,window:{start:new Date(window.start).toISOString(),end:now.toISOString(),previous_start:window.compare?new Date(window.previousStart).toISOString():null,previous_end:window.compare?new Date(window.previousEnd).toISOString():null},meta:{time_zone:libraryTimeZone,generated_at:now.toISOString(),availability,current_thresholds:{yellow:saved?.yellowThreshold??10,red:saved?.redThreshold??17},continuity_gap_ms:CONTINUITY_GAP_MS,recorded_transitions:Number(eventCoverage.transitions),provenance:'unverified',provenance_label:'Stored monitoring history',provenance_note:'Measurement sources are not identified in the stored records.',index_definition:'Stored relative noise index; current capture uses averaged microphone RMS × 500. Historical readings are not calibrated decibels.',duration_method:'Time between consecutive readings no more than 15 seconds apart. Entire larger gaps and the final unbounded sample are excluded; simultaneous states use the last stored record.',episode_method:'Distinct observed Yellow and Red state runs overlapping the period. Repeated samples are deduplicated; a gap starts a separate observed run. Partial runs do not prove a true incident start.',performance_method:'Any observed Red run: high noise observed. Otherwise any Yellow run: elevated observed. Only measurable Green intervals: quiet observed. Otherwise unavailable.',history_note:'Measurement sources and historical calibration/threshold versions are unavailable for these records.'}});
  }));
}
module.exports={installAnalytics,calculate,summarize,windowFor,midnight,CONTINUITY_GAP_MS};
