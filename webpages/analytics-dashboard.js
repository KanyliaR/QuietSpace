/* Existing native-canvas Noise Trends, now fed by authorized historical analytics. */
(() => {
  const $=id=>document.getElementById(id);
  const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
  const stateColors={green:'#18d7a1',yellow:'#ffda59',red:'#f5637e'};
  const stateNames={green:'Green (Quiet)',yellow:'Yellow (Elevated)',red:'Red (High Noise)'};
  let data=null,requestNumber=0,controller,hoverTime=null,chartView='summary';
  const decimal=value=>value===null||value===undefined?'—':Number(value).toLocaleString(undefined,{maximumFractionDigits:1,minimumFractionDigits:1});
  const percent=value=>value===null||value===undefined?'—':decimal(value)+'%';
  const duration=ms=>{if(!ms)return '0s';const seconds=Math.round(ms/1000);return seconds>=3600?`${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m`:seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`;};
  const formatTime=(value,options={})=>new Date(value).toLocaleString('en-US',{timeZone:data?.meta.time_zone||'America/New_York',month:'short',day:'numeric',...options});
  function applyGlobalTheme() {
    const theme=localStorage.getItem('quietspace_theme')||'dark';
    const dark=theme==='dark'||(theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('dark-theme',dark);document.body.classList.toggle('light-theme',!dark);drawCharts();
  }
  window.applyGlobalTheme=applyGlobalTheme;
  window.addEventListener('storage',e=>{if(e.key==='quietspace_theme')applyGlobalTheme();});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(localStorage.getItem('quietspace_theme')==='system')applyGlobalTheme();});
  function swatch(color) {const e=node('i',undefined,'an-swatch');e.style.background=color;return e;}
  function selectedName() {return data.room==='all'?'All Rooms':data.rooms.find(r=>String(r.id)===data.room)?.room_name||'Selected room';}
  const isSessionView=()=>!['summary','period'].includes(chartView);
  function chartSeries() {
    if(!data)return [];
    return data.chart?(data.chart.session_id===chartView?data.chart.detail_series:data.chart.summary_series):data.series.map(r=>({...r,segments:[{points:r.points}]}));
  }
  function chartWindow() {
    return data.chart?(data.chart.session_id===chartView?data.chart.detail_window:chartView==='period'?data.window:data.chart.observed_window):data.window;
  }
  function pointGroups(room) { return room.segments.flatMap(segment=>segment.points.map(point=>({...point,session_id:segment.session_id,source_positions:segment.source_positions,rendered_positions:segment.rendered_positions}))); }
  function renderChartControls() {
    const sessions=data.chart?.sessions||[],select=$('trendView');
    select.replaceChildren(new Option('Historical summary · observed span','summary'),new Option('Historical summary · full period','period'));
    for(const session of sessions) {
      const label=`${session.room_name} · ${formatTime(session.start,{hour:'numeric',minute:'2-digit',second:'2-digit'})} – ${new Date(session.end).toLocaleTimeString('en-US',{timeZone:data.meta.time_zone,hour:'numeric',minute:'2-digit',second:'2-digit'})} · ${session.reading_count} readings`;
      select.append(new Option(label,session.id));
    }
    if(isSessionView()&&!sessions.some(s=>s.id===chartView))chartView='summary';
    select.value=chartView;$('latestRecordingSession').disabled=!sessions.length;
    const unit=data.bucket_unit==='hour'?'Hourly':data.bucket_unit==='day'?'Daily':'Weekly';
    $('trendCaption').textContent=`${isSessionView()?'Recording session detail':unit+' session summaries'} · ${selectedName()} · ${$('rangeFilter').selectedOptions[0].textContent}`;
    $('trendViewNote').textContent=isSessionView()
      ? 'Chart zoom only; dashboard metrics retain the global filters. Recorded points connect within sessions; other selected rooms appear only where observations exist in this interval.'
      : `${sessions.length} recorded segment(s). ${chartView==='period'?'Full selected timeline':'Axis fitted to observed timestamps within the selected period'}. Short sessions retain recorded points; gaps over 15 seconds remain disconnected.`;
    if(chartSeries().some(r=>r.segments.some(s=>s.rendered_positions<s.source_positions)))$('trendViewNote').textContent+=' Long sessions show representative recorded positions, preserving boundaries and extrema; metrics still use every valid reading.';
  }
  function render() {
    const s=data.summary;
    $('dataProvenance').textContent=data.meta.provenance_label;
    $('dataCoverage').textContent=`${s.reading_count.toLocaleString()} saved readings in this selection · ${data.meta.index_definition} ${data.meta.provenance_note}`;
    $('averageIndex').textContent=decimal(s.average_index);
    $('averageComparison').textContent=s.comparison.average_percent===null?'No comparable previous-period mean.':`${s.comparison.average_percent>0?'+':''}${decimal(s.comparison.average_percent)}% vs. previous equal-length window (${s.comparison.previous_readings} samples)`;
    $('quietPercentage').textContent=percent(s.quiet_percent);
    $('quietComparison').textContent=s.comparison.quiet_percentage_points===null?'Timestamp-derived room-time; gaps excluded.':`${s.comparison.quiet_percentage_points>0?'+':''}${decimal(s.comparison.quiet_percentage_points)} percentage points vs. previous window`;
    const peak=s.loudest;
    $('loudestPeriod').textContent=peak?(data.bucket_unit==='hour'?new Date(peak.timestamp).toLocaleTimeString('en-US',{timeZone:data.meta.time_zone,hour:'numeric'}):formatTime(peak.timestamp)):'—';
    $('loudestCaption').textContent=peak?`${formatTime(peak.timestamp)} · highest ${data.bucket_unit==='hour'?'hourly':data.bucket_unit==='day'?'daily':'weekly'} recorded mean (${decimal(peak.average_index)})`:'No historical readings in this selection.';
    $('thresholdEvents').textContent=s.reading_count||s.monitored_ms?String(s.episodes.total):'—';
    $('thresholdBreakdown').textContent=s.reading_count||s.monitored_ms?`${s.episodes.yellow} Yellow · ${s.episodes.red} Red observed runs${s.episodes.partial?` · ${s.episodes.partial} partial`:''}`:'No recorded status runs in this selection.';
    renderChartControls();
    $('comparisonCaption').textContent=`Historical noise and observed episodes · all rooms${data.room==='all'?'':' · selected room highlighted'}`;
    $('durationCoverage').textContent=s.monitored_ms?`${duration(s.monitored_ms)} of observed room-time · ${s.coverage_percent>0&&s.coverage_percent<.01?'<0.01':s.coverage_percent.toFixed(2)}% period coverage. Gaps and final unbounded samples excluded.`:'Unavailable: no consecutive status readings close enough to measure monitored time. Isolated samples do not establish duration.';
    $('episodeCoverage').textContent=`Observed state runs, not sample counts or verified incident starts. ${s.episodes.partial} partial run(s) in the selection. Gaps break continuity.`;
    $('donutQuiet').textContent=percent(s.quiet_percent);$('donutCaption').textContent=s.monitored_ms?'Quiet Time':'No duration data';
    $('distributionLegend').replaceChildren();
    for(const status of ['green','yellow','red']) {
      const li=node('li'),label=node('span');label.append(swatch(stateColors[status]),document.createTextNode(stateNames[status]));
      li.append(label,node('strong',percent(s.distribution[status])));li.title=s.monitored_ms?`${stateNames[status]}: ${duration(s.durations_ms[status])} observed`:'Unavailable: no measurable observation intervals';$('distributionLegend').append(li);
    }
    $('distributionChart').setAttribute('aria-label',s.monitored_ms?`Observed room-time: ${['green','yellow','red'].map(k=>`${stateNames[k]} ${percent(s.distribution[k])}`).join(', ')}`:'Status distribution unavailable: no measurable observation intervals');
    $('trendsLegend').replaceChildren();
    for(const room of chartSeries()){const item=node('span');item.append(swatch(room.color),document.createTextNode(room.room_name));$('trendsLegend').append(item);}
    renderComparison();renderBars();renderInsights();renderChartTable();drawCharts();
    const methods=$('analyticsMethods');methods.replaceChildren();
    for(const text of [
      `Period: ${formatTime(data.window.start,{hour:'numeric',minute:'2-digit'})} – ${formatTime(data.window.end,{hour:'numeric',minute:'2-digit'})} (${data.meta.time_zone}). Updated ${formatTime(data.meta.generated_at,{hour:'numeric',minute:'2-digit'})}.`,
      'Average Noise Index is a reading-weighted mean of stored values, not an average of room means and not calibrated dB. Comparisons use the immediately preceding equal-duration window; unavailable means no supported comparison.',
      'The chart splits observed readings into segments before aggregation. Means never combine different segments. Segments contained in one historical bucket retain recorded positions, with representative real extrema used only for very long sequences. Observed-span and individual-session views zoom the chart only; global metric calculations and the 15-second continuity rule are unchanged.',
      data.meta.duration_method+' Percentages are weighted by observed room-time, not by record counts. No time after an isolated final reading is assumed.',
      data.meta.episode_method+' Episodes already underway at the period boundary count once as overlapping partial runs. Duplicate timestamps use the last stored status for duration/episodes; all valid numeric samples contribute to index means.',
      data.meta.performance_method,
      `Current configured boundaries: Yellow ${data.meta.current_thresholds.yellow}, Red ${data.meta.current_thresholds.red}. Historical stored status colors remain authoritative; current boundaries do not reclassify old measurements.`,
      `${data.meta.recorded_transitions} recorded transition events in the period. ${data.meta.history_note}`])methods.append(node('p',text));
    $('analyticsMessage').textContent=s.reading_count?'':'No saved readings for this room and period. Try a longer period or another room.';
  }
  function renderComparison() {
    const body=$('comparisonRows');body.replaceChildren();
    const names={high:'High noise observed',elevated:'Elevated observed',quiet:'Quiet observed',unavailable:'Unavailable'};
    for(const room of data.rooms) {
      const row=node('tr');row.dataset.roomId=room.id;if(room.selected)row.classList.add('an-selected');
      const name=node('th');name.scope='row';name.append(swatch(room.color),document.createTextNode(room.room_name));row.append(name);
      for(const value of [decimal(room.average_index),percent(room.quiet_percent),room.reading_count||room.monitored_ms?String(room.episodes.yellow):'—',room.reading_count||room.monitored_ms?String(room.episodes.red):'—'])row.append(node('td',value));
      const cell=node('td');cell.append(node('span',names[room.performance],'an-performance '+room.performance));row.append(cell);body.append(row);
    }
    if(!data.rooms.length){const row=node('tr'),cell=node('td','No monitored rooms are configured.');cell.colSpan=6;row.append(cell);body.append(row);}
  }
  function renderBars() {
    const container=$('thresholdBars');container.replaceChildren();
    const max=Math.max(1,...data.rooms.map(r=>r.episodes.total));
    for(const room of data.rooms) {
      const row=node('div',undefined,'an-bar-row'+(room.selected?' an-selected':''));row.dataset.roomId=room.id;
      const name=node('span',undefined,'an-bar-name');name.append(swatch(room.color),document.createTextNode(room.room_name));
      const known=room.reading_count||room.monitored_ms;
      const track=node('div',undefined,'an-bar-track');track.setAttribute('role','img');track.setAttribute('aria-label',known?`${room.room_name}: ${room.episodes.yellow} Yellow, ${room.episodes.red} Red observed episodes, ${room.episodes.partial} partial`:`${room.room_name}: unavailable, no observations in this period`);
      for(const status of ['yellow','red']) {
        const count=room.episodes[status];if(!count)continue;
        const segment=node('span',count/max>0.055?String(count):'',`an-bar-segment an-${status}-fill`);segment.style.width=(count/max*100)+'%';segment.title=`${room.room_name} · ${count} ${status==='yellow'?'Yellow':'Red'} observed episodes`;track.append(segment);
      }
      row.append(name,track,node('span',known?String(room.episodes.total):'—','an-bar-total'));
      const detail=node('small',known?`${room.episodes.yellow} Yellow · ${room.episodes.red} Red${room.episodes.partial?` · ${room.episodes.partial} partial`:''}`:'No observations in this period','an-bar-detail');row.append(detail);container.append(row);
    }
  }
  function renderInsights() {
    const list=$('keyInsights');list.replaceChildren();const s=data.summary;
    if(s.loudest)list.append(node('li',`${selectedName()}: the highest historical ${data.bucket_unit} mean was ${decimal(s.loudest.average_index)} on ${formatTime(s.loudest.timestamp,{hour:'numeric',minute:'2-digit'})}, from ${s.loudest.samples} stored sample(s).`));
    const noisy=[...data.rooms].filter(r=>r.reading_count||r.monitored_ms).sort((a,b)=>b.episodes.total-a.episodes.total||Number(a.id)-Number(b.id))[0];
    if(noisy)list.append(node('li',noisy.episodes.total?`${noisy.room_name} had the most observed elevated-state runs: ${noisy.episodes.total} (${noisy.episodes.yellow} Yellow, ${noisy.episodes.red} Red; ${noisy.episodes.partial} partial).`:'No elevated-state episodes were observed in the available records for this period.'));
    const quiet=[...data.rooms].filter(r=>r.quiet_percent!==null).sort((a,b)=>b.quiet_percent-a.quiet_percent||b.monitored_ms-a.monitored_ms)[0];
    if(quiet)list.append(node('li',`Among rooms with measurable coverage, ${quiet.room_name} had the highest quiet-time share: ${percent(quiet.quiet_percent)} over ${duration(quiet.monitored_ms)} of observed room-time.`));
    if(s.comparison.average_percent!==null)list.append(node('li',s.comparison.average_percent===0?`${selectedName()}'s mean recorded noise index was unchanged from the previous equal-length window.`:`${selectedName()}'s mean recorded noise index ${s.comparison.average_percent<0?'decreased':'increased'} ${decimal(Math.abs(s.comparison.average_percent))}% compared with the previous equal-length window.`));
    else list.append(node('li','A previous-period comparison is unavailable for the selected room/window. No forecast or missing values have been substituted.'));
    if(!s.reading_count)list.prepend(node('li','No recorded noise measurements in this selection; choose a longer historical period to inspect available data.'));
  }
  function renderChartTable() {
    $('trendData').replaceChildren();
    const rows=chartSeries().flatMap(room=>pointGroups(room).map(p=>({...p,room_name:room.room_name}))).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
    for(const item of rows){const row=node('tr');for(const value of [formatTime(item.timestamp,{hour:'numeric',minute:'2-digit',second:'2-digit'})+(item.kind&&item.kind!=='reading'?' · '+item.kind+' mean':''),item.room_name,decimal(item.average_index),String(item.samples)])row.append(node('td',value));$('trendData').append(row);}
    if(!rows.length){const row=node('tr'),cell=node('td','No chart values are available.');cell.colSpan=4;row.append(cell);$('trendData').append(row);}
  }
  // Native canvas setup and axes reuse the original Noise Trends approach, with
  // responsive dimensions, a data-derived axis, real timestamps and gap breaks.
  function prepareCanvas(id) {
    const canvas=$(id),width=Math.max(1,canvas.parentElement.clientWidth),height=id==='distributionChart'?200:210,dpr=devicePixelRatio||1;
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);canvas.style.width=width+'px';canvas.style.height=height+'px';
    const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
    return {canvas,ctx,width,height,muted:getComputedStyle(document.querySelector('.analytics-dashboard')).getPropertyValue('--an-muted').trim(),border:getComputedStyle(document.querySelector('.analytics-dashboard')).getPropertyValue('--an-border').trim()};
  }
  function drawAxes(chart,max) {
    const {ctx,width,height,muted}=chart,left=43,right=width-14,top=18,bottom=height-44;
    const y=value=>bottom-value/max*(bottom-top);
    ctx.font='11px Arial';ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillStyle=muted;
    for(let n=0;n<=4;n++){const value=max*n/4;ctx.beginPath();ctx.strokeStyle='rgba(124,153,198,.28)';ctx.moveTo(left,y(value));ctx.lineTo(right,y(value));ctx.stroke();ctx.fillText(Number(value.toFixed(1)).toString(),left-7,y(value));}
    const domain=chartWindow(),start=Date.parse(domain.start),end=Date.parse(domain.end),span=Math.max(1,end-start);
    const x=time=>left+(time-start)/span*(right-left),ticks=width<450?3:5;
    ctx.textBaseline='top';ctx.textAlign='center';
    for(let n=0;n<ticks;n++) {
      ctx.textAlign=n===0?'left':n===ticks-1?'right':'center';const time=start+span*n/(ticks-1);
      const label=span<60000?new Date(time).toLocaleTimeString('en-US',{timeZone:data.meta.time_zone,hour:'numeric',minute:'2-digit',second:'2-digit'}):span<86400000?new Date(time).toLocaleTimeString('en-US',{timeZone:data.meta.time_zone,hour:'numeric',minute:'2-digit'}):formatTime(time);
      ctx.fillText(label,left+(right-left)*n/(ticks-1),bottom+12);
    }
    return {x,y,left,right,top,bottom,start,end};
  }
  function drawTrends() {
    if(!data)return;
    const chart=prepareCanvas('trendsChart'),{ctx}=chart,series=chartSeries(),all=series.flatMap(r=>pointGroups(r)),max=Math.max(10,Math.ceil(all.reduce((maximum,p)=>Math.max(maximum,p.average_index),0)/10)*10);
    const axes=drawAxes(chart,max);let connections=0;
    $('trendEmpty').hidden=all.length>0;
    for(const room of series) {
      ctx.strokeStyle=room.color;ctx.lineWidth=2.5;
      for(const segment of room.segments) {
        ctx.beginPath();
        segment.points.forEach((point,index)=>{const x=axes.x(Date.parse(point.timestamp)),y=axes.y(point.average_index);if(!index||!point.connected)ctx.moveTo(x,y);else {ctx.lineTo(x,y);connections++;}});ctx.stroke();
        for(const point of segment.points){ctx.beginPath();ctx.arc(axes.x(Date.parse(point.timestamp)),axes.y(point.average_index),all.length>180?2:3.5,0,Math.PI*2);ctx.fillStyle=room.color;ctx.fill();}
      }
    }
    window.quietspaceAnalyticsChart={axes,width:chart.width,connections,points:all.length,view:chartView};
    if(hoverTime!==null){ctx.save();ctx.setLineDash([4,4]);ctx.strokeStyle='#9dbbea';const x=axes.x(hoverTime);ctx.beginPath();ctx.moveTo(x,axes.top);ctx.lineTo(x,axes.bottom);ctx.stroke();ctx.restore();}
  }
  function drawDistribution() {
    if(!data)return;const {ctx,width,height}=prepareCanvas('distributionChart'),centerX=width/2,centerY=height/2,radius=82,thickness=30;
    ctx.lineWidth=thickness;ctx.strokeStyle='rgba(124,153,198,.22)';ctx.beginPath();ctx.arc(centerX,centerY,radius,0,Math.PI*2);ctx.stroke();
    if(!data.summary.monitored_ms)return;let start=-Math.PI/2;
    for(const state of ['green','yellow','red']){const end=start+data.summary.distribution[state]/100*Math.PI*2;if(end>start){ctx.strokeStyle=stateColors[state];ctx.beginPath();ctx.arc(centerX,centerY,radius,start,end);ctx.stroke();}start=end;}
  }
  function drawCharts(){if(data){drawTrends();drawDistribution();}}
  function showTooltip(time) {
    hoverTime=time;const tooltip=$('trendTooltip');tooltip.replaceChildren(node('strong',formatTime(time,{hour:'numeric',minute:'2-digit',second:'2-digit'})));
    for(const room of chartSeries())for(const point of pointGroups(room).filter(p=>Date.parse(p.timestamp)===time)) {
      const line=node('p');line.append(swatch(room.color),document.createTextNode(` ${room.room_name}: ${decimal(point.average_index)} · ${point.samples} ${point.samples===1?'reading':'readings'}${point.kind&&point.kind!=='reading'?' · '+point.kind+' mean':''}`));tooltip.append(line);
      if(point.period_start)tooltip.append(node('p',`${formatTime(point.period_start,{hour:'numeric',minute:'2-digit'})} – ${formatTime(point.period_end,{hour:'numeric',minute:'2-digit'})}`));
      if(point.source_positions>point.rendered_positions)tooltip.append(node('p',`${point.rendered_positions} representative observed positions shown from ${point.source_positions}; no interpolated readings.`));
    }
    tooltip.hidden=false;drawTrends();
  }
  const times=()=>[...new Set(chartSeries().flatMap(r=>pointGroups(r).map(p=>Date.parse(p.timestamp))))].sort((a,b)=>a-b);
  $('trendsChart').addEventListener('pointermove',event=>{
    if(!data)return;const list=times();if(!list.length)return;const rect=event.currentTarget.getBoundingClientRect(),axes=window.quietspaceAnalyticsChart.axes,target=axes.start+(event.clientX-rect.left-axes.left)/Math.max(1,axes.right-axes.left)*(axes.end-axes.start);
    showTooltip(list.reduce((a,b)=>Math.abs(b-target)<Math.abs(a-target)?b:a));
  });
  $('trendsChart').addEventListener('pointerleave',()=>{hoverTime=null;$('trendTooltip').hidden=true;drawTrends();});
  $('trendsChart').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End','Escape'].includes(event.key))return;event.preventDefault();const list=times();if(!list.length)return;if(event.key==='Escape'){hoverTime=null;$('trendTooltip').hidden=true;drawTrends();return;}const index=list.indexOf(hoverTime),next=event.key==='Home'?0:event.key==='End'?list.length-1:Math.max(0,Math.min(list.length-1,index+(event.key==='ArrowRight'?1:-1)));showTooltip(list[next]);});
  async function refreshAnalytics() {
    const request=++requestNumber;controller?.abort();controller=new AbortController();
    $('analyticsMessage').textContent='Loading historical analytics…';$('refreshAnalytics').disabled=true;document.querySelector('.analytics-dashboard').setAttribute('aria-busy','true');
    try {
      const response=await fetch(`/api/analytics?room=${encodeURIComponent($('roomFilter').value)}&range=${encodeURIComponent($('rangeFilter').value)}${isSessionView()?'&session='+encodeURIComponent(chartView):''}`,{signal:controller.signal,cache:'no-store'});
      const result=await response.json();if(!response.ok)throw Error(result.message||'Analytics could not be loaded');if(request!==requestNumber)return;
      data=result;window.quietspaceAnalyticsData=data;hoverTime=null;$('trendTooltip').hidden=true;
      const selected=$('roomFilter').value;$('roomFilter').replaceChildren(new Option('All Rooms','all'));
      for(const room of data.rooms)$('roomFilter').append(new Option(room.room_name+(room.monitoring_enabled?'':' (currently paused)'),String(room.id)));
      $('roomFilter').value=selected;render();
    } catch(error) {
      if(error.name==='AbortError'||request!==requestNumber)return;
      $('analyticsMessage').textContent='Analytics could not be loaded: '+error.message;
      data=null;window.quietspaceAnalyticsData=null;$('dataProvenance').textContent='Historical analytics unavailable';$('analyticsMethods').replaceChildren();$('trendTooltip').hidden=true;
      // Hide stale results rather than presenting another filter's data as current.
      for(const section of document.querySelectorAll('.an-summary,.an-chart-grid,.an-comparison-grid,.an-insights'))section.hidden=true;
      return;
    } finally {if(request===requestNumber){$('refreshAnalytics').disabled=false;document.querySelector('.analytics-dashboard').setAttribute('aria-busy','false');}}
    for(const section of document.querySelectorAll('.an-summary,.an-chart-grid,.an-comparison-grid,.an-insights'))section.hidden=false;
  }
  const explanations={
    trends:{title:'Noise Levels Over Time',paragraphs:[
      'Readings are sorted by room and timestamp, then split wherever the gap exceeds 15 seconds. Lines stay inside those segments; isolated observations remain dots.',
      'Historical summaries average each segment separately into hourly, daily or weekly buckets. Short segments retain their recorded points. Time view and Latest session zoom only this chart; the other cards keep the global filters.',
      'Segments are reconstructed observations, not verified capture sessions. Coincident timestamps show their reading mean. Very long segments retain representative actual positions and extrema rather than adding interpolated readings.'
    ]},
    distribution:{title:'Noise Status Distribution',paragraphs:[
      'Each stored status contributes time until the next reading only when it arrives within 15 seconds. Green, Yellow and Red percentages divide those durations by total observed room-time.',
      'Larger gaps and the final unbounded sample contribute no assumed duration. Unknown or offline time is not counted as quiet. Without measurable intervals, percentages are unavailable.',
      'These are timestamp-derived interval estimates. Measurement sources and exact capture start/stop times are not recorded for historical readings.'
    ]},
    comparison:{title:'Room Comparison',paragraphs:[
      'Average Noise Index is the mean of stored readings. Quiet Time is duration-weighted. Yellow/Red counts are distinct observed state runs, not repeated samples.',
      'Any observed Red run gives High noise observed; otherwise Yellow gives Elevated observed. Measurable Green-only intervals give Quiet observed. Missing coverage is unavailable.',
      'All rooms remain visible for comparison; the selected room is highlighted. These describe the selected historical period, not current status or future predictions.'
    ]},
    threshold:{title:'Threshold Activity by Room',paragraphs:[
      'Adjacent repeated Yellow or Red readings count as one observed run. A color change or a gap exceeding 15 seconds starts another run.',
      'Runs with unknown beginnings/ends or clipped period boundaries are partial. They cannot establish an exact historical incident start; repeated countdowns in continuous Red do not create extra Red runs.',
      'Yellow and Red are the saved classifications. Current monitoring thresholds are not retroactively applied to old readings. No-observation rooms display unavailable counts.'
    ]}
  };
  let infoButton=null;
  const popover=node('div',undefined,'an-info-popover');popover.id='analyticsInfoPopover';popover.hidden=true;popover.tabIndex=-1;popover.setAttribute('role','dialog');popover.setAttribute('aria-labelledby','analyticsInfoTitle');document.body.append(popover);
  function closeInfo(restoreFocus=false) {
    const trigger=infoButton;if(trigger)trigger.setAttribute('aria-expanded','false');
    popover.hidden=true;infoButton=null;if(restoreFocus)trigger?.focus();
  }
  function positionInfo() {
    if(!infoButton||popover.hidden)return;
    const anchor=infoButton.getBoundingClientRect();
    if(anchor.bottom<0||anchor.top>innerHeight){closeInfo();return;}
    const width=popover.offsetWidth,height=popover.offsetHeight;
    popover.style.left=Math.max(12,Math.min(innerWidth-width-12,anchor.left))+'px';
    popover.style.top=Math.max(12,Math.min(innerHeight-height-12,anchor.bottom+8+height<=innerHeight-12?anchor.bottom+8:anchor.top-height-8))+'px';
  }
  for(const button of document.querySelectorAll('[data-analytics-info]'))button.onclick=()=>{
    if(infoButton===button){closeInfo(true);return;}
    closeInfo();infoButton=button;const explanation=explanations[button.dataset.analyticsInfo];
    const header=node('div',undefined,'an-info-popover-header'),heading=node('h4',explanation.title);heading.id='analyticsInfoTitle';
    const dismiss=node('button','×');dismiss.type='button';dismiss.setAttribute('aria-label','Close explanation');dismiss.onclick=()=>closeInfo(true);header.append(heading,dismiss);
    popover.replaceChildren(header,...explanation.paragraphs.map(text=>node('p',text)));popover.hidden=false;button.setAttribute('aria-expanded','true');positionInfo();popover.focus({preventScroll:true});
  };
  document.addEventListener('click',event=>{if(infoButton&&!event.target.closest('[data-analytics-info]')&&!popover.contains(event.target))closeInfo();},true);
  document.addEventListener('keydown',event=>{if(infoButton&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeInfo(true);}},true);
  document.addEventListener('scroll',positionInfo,true);window.addEventListener('resize',positionInfo);
  const refreshFiltered=()=>{chartView='summary';refreshAnalytics();};
  $('roomFilter').addEventListener('change',refreshFiltered);$('rangeFilter').addEventListener('change',refreshFiltered);$('refreshAnalytics').onclick=refreshAnalytics;
  $('trendView').onchange=()=>{
    chartView=$('trendView').value;hoverTime=null;$('trendTooltip').hidden=true;
    if(isSessionView())refreshAnalytics();else {renderChartControls();renderChartTable();drawTrends();}
  };
  $('latestRecordingSession').onclick=()=>{
    const sessions=data?.chart?.sessions||[],session=sessions.find(s=>s.positions>1)||sessions[0];
    if(session){$('trendView').value=session.id;$('trendView').dispatchEvent(new Event('change'));}
  };
  const observer=new ResizeObserver(drawCharts);observer.observe($('trendsChart').parentElement);
  window.addEventListener('resize',drawCharts);window.addEventListener('pagehide',()=>{controller?.abort();observer.disconnect();});
  applyGlobalTheme();refreshAnalytics();
})();
