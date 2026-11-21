/* Chart-only grouping. Metric averages, status durations and episode counts are unchanged. */
const GAP_MS=15000;
const MAX_DETAIL_POINTS=2000;
function orderedSessions(room,readings,start,end) {
  const rows=readings.filter(r=>Number(r.room_id)===Number(room.id)).map(r=>({...r,time:+new Date(r.recorded_at)}))
    .filter(r=>Number.isFinite(r.time)&&r.time>=start&&r.time<end).sort((a,b)=>a.time-b.time||Number(a.id)-Number(b.id));
  const positions=[];
  for(const row of rows) {
    let position=positions.at(-1);
    if(!position||position.time!==row.time) {position={time:row.time,id:String(row.id),sum:0,samples:0};positions.push(position);}
    const value=row.level===null?NaN:Number(row.level);
    if(Number.isFinite(value)&&value>=0){if(!position.samples)position.id=String(row.id);position.sum+=value;position.samples++;}
  }
  const sessions=[];let previous=null,current;
  for(const position of positions) {
    if(!position.samples){previous=null;continue;}
    if(!previous||position.time-previous.time>GAP_MS) {
      current={id:`${room.id}:${position.id}`,room_id:room.id,room_name:room.room_name,color:room.color,points:[],reading_count:0};sessions.push(current);
    }
    current.points.push({timestamp:new Date(position.time).toISOString(),end_at:new Date(position.time).toISOString(),average_index:position.sum/position.samples,samples:position.samples,kind:'reading'});
    current.reading_count+=position.samples;previous=position;
  }
  return sessions;
}
// Preserve real observed values/extrema rather than inventing interpolated samples
// when a long session contains more points than can be usefully drawn at once.
function representativePoints(points,limit=MAX_DETAIL_POINTS) {
  if(points.length<=limit)return points;
  const selected=new Set([points[0],points.at(-1)]),size=Math.ceil(points.length/Math.max(1,Math.floor((limit-2)/2)));
  for(let i=0;i<points.length;i+=size) {
    const group=points.slice(i,i+size);
    selected.add(group.reduce((a,b)=>b.average_index<a.average_index?b:a));
    selected.add(group.reduce((a,b)=>b.average_index>a.average_index?b:a));
  }
  return [...selected].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
}
function withConnections(points) {return points.map((p,i)=>({...p,connected:i>0}));}
function summarySegment(session,buckets) {
  const groups=new Map();
  for(const point of session.points) {
    const period=buckets.bucket(Date.parse(point.timestamp));
    if(!groups.has(period.start))groups.set(period.start,{period,points:[],sum:0,samples:0});
    const group=groups.get(period.start);group.points.push(point);group.sum+=point.average_index*point.samples;group.samples+=point.samples;
  }
  // A single coarse bucket must not turn a multi-reading session into one dot.
  const detailed=groups.size===1;
  const points=detailed?representativePoints(session.points):[...groups.values()].map(group=>({
    timestamp:group.points[Math.floor(group.points.length/2)].timestamp,
    end_at:group.points.at(-1).timestamp,period_start:new Date(group.period.start).toISOString(),period_end:new Date(group.period.end).toISOString(),
    average_index:group.sum/group.samples,samples:group.samples,kind:buckets.unit
  }));
  return {session_id:session.id,kind:detailed?'readings':buckets.unit,source_positions:session.points.length,rendered_positions:points.length,points:withConnections(points)};
}
function paddedWindow(start,end,period) {
  const padding=Math.min(GAP_MS,Math.max(1000,(end-start)*.03));
  return {start:new Date(Math.max(period.start,start-padding)).toISOString(),end:new Date(Math.min(period.end,end+padding)).toISOString()};
}
function buildChart(rooms,readings,window,buckets,sessionId=null) {
  const all=rooms.map(room=>({room,sessions:orderedSessions(room,readings,window.start,window.end)}));
  const sessions=all.flatMap(group=>group.sessions.map(s=>({id:s.id,room_id:s.room_id,room_name:s.room_name,color:s.color,start:s.points[0].timestamp,end:s.points.at(-1).timestamp,reading_count:s.reading_count,positions:s.points.length})))
    .sort((a,b)=>Date.parse(b.end)-Date.parse(a.end)||Number(a.room_id)-Number(b.room_id));
  const summarySeries=all.map(({room,sessions})=>({room_id:room.id,room_name:room.room_name,color:room.color,segments:sessions.map(s=>summarySegment(s,buckets))}));
  const first=sessions.length?Math.min(...sessions.map(s=>Date.parse(s.start))):window.start;
  const last=sessions.length?Math.max(...sessions.map(s=>Date.parse(s.end))):window.end;
  const chart={sessions,summary_series:summarySeries,observed_window:sessions.length?paddedWindow(first,last,window):{start:new Date(window.start).toISOString(),end:new Date(window.end).toISOString()},session_id:null,detail_series:[],detail_window:null,max_detail_points:MAX_DETAIL_POINTS};
  if(sessionId) {
    const selected=sessions.find(s=>s.id===sessionId);
    if(!selected)throw Object.assign(Error('Recording session not found in this room/time selection'),{status:404,publicMessage:'Recording session not found in this room/time selection'});
    chart.session_id=selected.id;chart.detail_window=paddedWindow(Date.parse(selected.start),Date.parse(selected.end),window);
    const from=Date.parse(chart.detail_window.start),to=Date.parse(chart.detail_window.end);
    // Retain other selected rooms that were genuinely observed in the zoomed
    // interval, and never join separate sessions, even when they share a bucket.
    chart.detail_series=all.map(({room,sessions})=>({room_id:room.id,room_name:room.room_name,color:room.color,segments:sessions.map(s=>{
      const points=s.points.filter(p=>Date.parse(p.timestamp)>=from&&Date.parse(p.timestamp)<=to);
      const shown=representativePoints(points);
      return {session_id:s.id,kind:'readings',source_positions:points.length,rendered_positions:shown.length,points:withConnections(shown)};
    }).filter(s=>s.points.length)}));
  }
  return chart;
}
module.exports={buildChart,orderedSessions,representativePoints,GAP_MS,MAX_DETAIL_POINTS};
