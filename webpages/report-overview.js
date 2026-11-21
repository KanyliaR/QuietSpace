/* Existing overview panels, with durable per-account unread state over the staff SSE stream. */
(() => {
  window.QuietSpaceReportNotifications = { install({ api, events }) {
    const tabs = [...document.querySelectorAll('[data-report-tab]')];
    let active = tabs.length ? 'quietscore' : null, through = 0, ready, queue = Promise.resolve();
    let lastStudentSound = -Infinity;
    const names = { quietscore: 'QuietScore Report', student: 'Student Report' };
    function badges(snapshot) {
      through = Math.max(through, snapshot.through);
      for (const tab of tabs) {
        const count = snapshot.unread[tab.dataset.reportTab], badge = tab.querySelector('.qs-unread');
        badge.textContent = String(count); badge.hidden = !count;
        const total = tab.querySelector('[data-report-total]')?.textContent;
        tab.setAttribute('aria-label', `${names[tab.dataset.reportTab]}s${total && total !== '—' ? `, ${total} total reports` : ''}${count ? `, ${count} unread` : ''}`);
      }
    }
    const serialize = work => { queue = queue.then(work).catch(error => console.error('Report notification sync failed:',error)); return queue; };
    async function readActive() {
      if (!active || document.hidden) return;
      badges(await api('/api/report-notifications/read', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({kind:active,through}) }));
    }
    function select(kind, focus = false) {
      if (!tabs.length) return;
      active = kind;
      for (const tab of tabs) {
        const selected = tab.dataset.reportTab === kind;
        tab.setAttribute('aria-selected',String(selected)); tab.tabIndex = selected ? 0 : -1;
        document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
        if (selected && focus) tab.focus();
      }
      if (ready) ready.then(()=>serialize(readActive));
    }
    for (const tab of tabs) {
      tab.onclick = () => select(tab.dataset.reportTab);
      tab.onkeydown = event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();
        const index = tabs.indexOf(tab);
        const next = event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
        select(tabs[next].dataset.reportTab,true);
      };
    }
    async function locate(kind,id) {
      if (!tabs.length) { const destination=window.quietspaceUser?.role==='admin'?'reports.html':'dashboard.html';location.href=`${destination}?report_tab=${kind}&report_id=${encodeURIComponent(id)}`; return; }
      select(kind);
      if (kind==='quietscore') await window.loadIncidents?.(); else await window.loadReports?.();
      const panel = document.getElementById(kind==='quietscore'?'quietscoreReportsSection':'studentReportsSection');
      const row = [...panel.querySelectorAll('[data-report-id]')].find(e=>String(e.dataset.reportId)===String(id));
      const target = row || panel;
      target.scrollIntoView({behavior:'smooth',block:'center'});
      target.classList.add('qs-report-highlight'); setTimeout(()=>target.classList.remove('qs-report-highlight'),4000);
    }
    function notify(event, allowSound) {
      const preferences = window.quietspacePreferences;
      if (allowSound && event.kind==='student' && preferences.student_sound && preferences.sound_enabled && performance.now()-lastStudentSound>4000) {
        lastStudentSound=performance.now(); window.quietspaceBeep({student:true});
      }
      if (!preferences.toast_enabled || !preferences[event.kind==='quietscore'?'quietscore_visual':'student_visual']) return;
      let stack = document.getElementById('qsReportNotifications');
      if (!stack) { stack=document.createElement('div'); stack.id='qsReportNotifications'; stack.className='qs-report-notifications'; stack.setAttribute('aria-live','polite'); document.body.append(stack); }
      const toast=document.createElement('div'); toast.className='qs-report-notice';
      const open=document.createElement('button'); open.type='button'; open.className='qs-report-notice-open';
      open.textContent=`New ${names[event.kind]} · ${event.room_name}`;
      open.onclick=()=>{toast.remove();locate(event.kind,event.report_id).catch(console.error);};
      const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','Dismiss notification');close.onclick=()=>toast.remove();
      toast.append(open,close); stack.append(toast);
      // A bounded stack prevents bursts from covering the dashboard.
      while(stack.children.length>4) stack.firstElementChild.remove();
      setTimeout(()=>toast.remove(),10000);
    }
    async function sync() {
      const result=await api('/api/report-notifications/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      badges(result);
      let allowSound=result.student_sound;
      for (const event of result.events) { notify(event,allowSound); if(event.kind==='student') allowSound=false; }
      if (result.events.length && tabs.length) {
        if(result.events.some(e=>e.kind==='student')) await window.loadReports?.();
        if(result.events.some(e=>e.kind==='quietscore')) await window.loadIncidents?.();
      }
      await readActive();
    }
    events.addEventListener('report-created',()=>ready.then(()=>serialize(sync)));
    events.addEventListener('open',()=>ready.then(()=>serialize(sync)));
    events.addEventListener('report-notifications-read',()=>ready.then(()=>serialize(async()=>badges(await api('/api/report-notifications')))));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden) ready.then(()=>serialize(sync));});
    ready=(async()=>{
      const result=await api('/api/report-notifications/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"silent":true}'});
      badges(result);
      const params=new URLSearchParams(location.search), kind=params.get('report_tab');
      if(tabs.length) select(['quietscore','student'].includes(kind)?kind:'quietscore');
      await readActive();
      if(tabs.length && kind && params.get('report_id')) await locate(kind,params.get('report_id'));
    })();
    ready.catch(error=>console.error('Report notification initialization failed:',error));
    window.quietspaceReportNotifications={select,locate,ready};
    return ready;
  }};
})();
