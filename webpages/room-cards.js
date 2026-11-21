/* One backend-derived room presentation for all staff roles. No threshold calculations. */
((root,factory)=>{const cards=factory();if(typeof module==='object'&&module.exports)module.exports=cards;else root.QuietSpaceRoomCards=cards;})(typeof window!=='undefined'?window:globalThis,()=>{
 function presentation(room){
  const state=room.device_state;
  if(state==='disabled')return {label:'Monitoring Disabled',tone:'neutral',indicator:'Monitoring Disabled',activity:'disabled'};
  if(state==='active'){
   const noise={green:['Quiet','green'],yellow:['Warning','yellow'],red:['Too Loud','red']}[room.status_color];
   return {label:noise?.[0]||'Status Unavailable',tone:noise?.[1]||'neutral',indicator:'Monitoring Active',activity:'active'};
  }
  const label={unregistered:'No Registered Device',offline:'Device Offline',microphone_error:'Microphone Error',connected:'Microphone Not Active'}[state]||'Monitoring Unavailable';
  const permitted=['unregistered','connected'].includes(state);
  return {label,tone:'neutral',indicator:permitted?'Monitoring Enabled':'Monitoring Unavailable',activity:permitted?'enabled':'unavailable'};
 }
 function render(container,rooms,user,busy=new Set()){
  const document=container.ownerDocument;
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const focused=document.activeElement?.closest('[data-monitor-room],[data-escalate-room]');
  const focusKey=focused&&[focused.hasAttribute('data-monitor-room')?'data-monitor-room':'data-escalate-room',focused.dataset.monitorRoom||focused.dataset.escalateRoom];
  const fragment=document.createDocumentFragment();
  for(const room of rooms){
   const state=presentation(room),card=node('article',undefined,'card qs-room-card'+(['unregistered','offline','disabled'].includes(room.device_state)?' qs-room-unavailable':''));
   card.dataset.roomId=room.room_id;card.dataset.roomName=room.room_name;card.dataset.deviceState=room.device_state;
   const heading=node('h3','Study '+String(room.room_name).replace(/^Study\s+/i,''));
   const status=node('div',state.label,'qs-room-status qs-room-status-'+state.tone);
   const bottom=node('div',undefined,'qs-room-bottom');
   const indicator=node('span',undefined,'qs-room-indicator qs-room-indicator-'+state.activity),dot=node('span',undefined,'qs-room-dot');dot.setAttribute('aria-hidden','true');indicator.append(dot,node('span',state.indicator));bottom.append(indicator);
   if(user?.role==='admin'){
    const enabled=Boolean(room.monitoring_enabled),button=node('button',enabled?'Disable Room Monitoring':'Enable Room Monitoring','qs-escalate-button qs-room-control '+(enabled?'qs-room-disable':'qs-room-enable'));
    button.type='button';button.dataset.monitorRoom=room.room_id;button.dataset.enabled=String(enabled);button.disabled=busy.has(String(room.room_id))||(enabled&&(['unregistered','offline'].includes(room.device_state)||room.system_enabled===0||room.system_enabled===false||room.registered_devices===0));if(button.disabled&&!busy.has(String(room.room_id)))button.title='Monitoring is unavailable. Enroll or reconnect the room device, or restore system monitoring in Settings.';button.setAttribute('aria-label',`${button.textContent} — ${heading.textContent}`);bottom.append(button);
   }
   card.append(heading,status,bottom);
   if(user?.role==='library_monitor'&&room.device_state==='active'&&room.monitoring_enabled){
    const actions=node('div',undefined,'qs-room-escalation-actions'),button=node('button','Escalate to Security','qs-escalate-button');button.type='button';button.dataset.escalateRoom=room.room_id;actions.append(button);card.append(actions);
   }
   fragment.append(card);
  }
  container.replaceChildren(fragment);
  if(focusKey){const button=[...container.querySelectorAll('button')].find(n=>n.getAttribute(focusKey[0])===focusKey[1]);button?.focus({preventScroll:true});}
 }
 return {presentation,render};
});
