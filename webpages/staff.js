/* Server identity and shared staff controls; authorization is enforced independently by Express. */
(() => {
  const user = window.quietspaceUser;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
      const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
      headers.set('X-QuietSpace-Request', '1');
      options = { ...options, headers };
    }
    const response = await originalFetch(input, options);
    if (response.status === 401 && !['/api/auth/login','/api/account/password'].includes(url.pathname)) location.replace('login.html?restricted=1');
    return response;
  };
  async function api(url, options) {
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw Error(result.message || 'Request failed');
    return result;
  }
  const json = body => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  window.quietspacePreferences = { toast_enabled: true, sound_enabled: true, volume: 50, quietscore_visual: true, student_visual: true, student_sound: false, theme: 'dark' };
  let notificationAudio, noticeTimer, savedAppearance;
  function applyPersonalAppearance(theme) {
    if (!['library_monitor','security'].includes(user?.role)) return;
    savedAppearance = theme;
    localStorage.setItem(`quietspace_theme_user_${user.id}`, theme);
    if (document.getElementById('themeSection')) window.selectTheme(theme);
    else {const light=theme==='light'||theme==='system'&&!matchMedia('(prefers-color-scheme: dark)').matches;document.body.classList.toggle('light-theme',light);document.body.classList.toggle('dark-theme',!light);window.dispatchEvent(new Event('resize'));}
  }
  window.addEventListener('storage',event=>{if(['quietspace_theme',`quietspace_theme_user_${user?.id}`].includes(event.key)&&savedAppearance)setTimeout(()=>applyPersonalAppearance(savedAppearance),0);});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(savedAppearance==='system')setTimeout(()=>applyPersonalAppearance(savedAppearance),0);});
  async function loadPreferences() {
    window.quietspacePreferences = await api('/api/preferences');
    if (['library_monitor','security'].includes(user.role) && savedAppearance !== window.quietspacePreferences.theme) applyPersonalAppearance(window.quietspacePreferences.theme);
  }
  async function enableAudio(preview = false) {
    if (!preview && !window.quietspacePreferences.sound_enabled) return;
    notificationAudio ||= new (window.AudioContext || window.webkitAudioContext)();
    await notificationAudio.resume();
  }
  window.quietspaceBeep = ({ student = false, preview = false, volume = window.quietspacePreferences.volume } = {}) => {
    const preferences = window.quietspacePreferences;
    if ((!preview && (!preferences.sound_enabled || (student && !preferences.student_sound))) || !notificationAudio || notificationAudio.state !== 'running') return;
    const oscillator = notificationAudio.createOscillator(), gain = notificationAudio.createGain();
    oscillator.connect(gain); gain.connect(notificationAudio.destination);
    const start=notificationAudio.currentTime;
    gain.gain.setValueAtTime(0,start); gain.gain.linearRampToValueAtTime(0.12 * volume / 100,start+0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001,start+0.22);
    oscillator.frequency.value = student || preview ? 660 : 740; oscillator.start(); oscillator.stop(start+0.24);
  };
  window.quietspaceNotify = (message, sound = false) => {
    if (sound) window.quietspaceBeep();
    if (!window.quietspacePreferences.toast_enabled) return;
    let notice = document.getElementById('quietspaceNotice');
    if (!notice) { notice = node('div', undefined, 'qs-notice' + (sound ? '' : ' qs-confirmation-notice')); notice.id = 'quietspaceNotice'; notice.setAttribute('role', 'status'); document.body.append(notice); }
    notice.classList.toggle('qs-confirmation-notice', !sound);
    notice.textContent = message; notice.hidden = false; clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
  };
  document.addEventListener('pointerdown', () => { enableAudio().catch(() => {}); });
  function initializePageHeader() {
    if (!/(dashboard|QuietScorePage|StudentReportsPage|settings|analytics|staff-accounts|reports|audit-logs)\.html$/.test(location.pathname)) return;
    const header = document.querySelector('main > .top-header');
    if (!header) return;
    header.classList.add('qs-page-header'); header.closest('main').classList.add('qs-header-main');
    let copy=header.querySelector('.overview-copy, .header-copy');
    if (!copy) {
      copy=node('div');
      for(const child of [...header.childNodes]) if(child.nodeType!==1 || !child.classList.contains('overview-date')) copy.append(child);
      header.prepend(copy);
    }
    copy.classList.add('qs-header-copy');
    let date=header.querySelector('.overview-date');
    if(!date) {
      date=node('div',undefined,'overview-date');date.id='overviewDate';date.setAttribute('aria-live','off');
      const time=node('span',undefined,'time-text'),icon=node('span','◷');icon.setAttribute('aria-hidden','true');
      const clock=node('span');clock.id='overviewTimeText';time.append(icon,document.createTextNode(' '),clock);
      const calendar=node('span',undefined,'date-text');calendar.id='overviewDateText';date.append(time,calendar);header.append(date);
    }
    if(!date.querySelector('#systemStatus')) {
      const status=node('span','Checking connection…','qs-system-status');status.id='systemStatus';status.dataset.state='unknown';status.setAttribute('role','status');date.append(status);
    }
    window.quietspaceUpdateHeaderClock=()=>{
      const now=new Date(),timeZone=window.quietspaceLibraryTimeZone || 'America/New_York';
      document.getElementById('overviewTimeText').textContent=now.toLocaleTimeString('en-US',{timeZone,hour:'numeric',minute:'2-digit'});
      document.getElementById('overviewDateText').textContent=now.toLocaleDateString('en-US',{timeZone,weekday:'long',month:'long',day:'numeric',year:'numeric'});
    };
    window.quietspaceUpdateHeaderClock();
    if(typeof window.updateOverviewDate!=='function')setInterval(window.quietspaceUpdateHeaderClock,1000);
  }
  document.addEventListener('quietspace:settings-sections-added',()=>initializeSettingsCards());
  const settingsCards = [];
  function syncSettingsCards() {
    for (const card of settingsCards) {
      card.body.hidden = !card.expanded;
      card.button.setAttribute('aria-expanded', String(!card.body.hidden));
    }
  }
  function initializeSettingsCards() {
    if (!location.pathname.endsWith('/settings.html')) return;
    document.querySelector('main')?.classList.add('qs-settings-page');
    for (const section of document.querySelectorAll('.content-container > section.section:not(.qs-settings-card)')) {
      const heading = section.querySelector(':scope > h3');
      if (!heading) continue;
      const title = heading.textContent.trim();
      const text = node('span', title, 'qs-settings-title');
      const button = node('button', title, 'qs-settings-toggle'); button.type = 'button';
      const body = node('div', undefined, 'qs-settings-body'); body.id = section.id + '-content';
      button.setAttribute('aria-controls', body.id);
      for (const child of [...section.childNodes]) if (child !== heading) body.append(child);
      heading.replaceChildren(text, button); section.append(body); section.classList.add('qs-settings-card');
      const card = { button, body, expanded: false }; settingsCards.push(card);
      button.onclick = () => { card.expanded = !card.expanded; syncSettingsCards(); };
    }
    syncSettingsCards();
  }
  document.addEventListener('invalid', event => {
    const card = settingsCards.find(item => item.body.contains(event.target));
    if (card) { card.expanded = true; syncSettingsCards(); }
  }, true);
  function setSidebarExpanded(expanded) {
    document.body.classList.toggle('sidebar-collapsed', !expanded);
    document.querySelector('.sidebar-toggle')?.setAttribute('aria-expanded', String(expanded));
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('.sidebar-toggle, .sidebar-backdrop')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    setSidebarExpanded(document.body.classList.contains('sidebar-collapsed'));
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]') && window.innerWidth <= 900) setSidebarExpanded(false);
  });
  document.addEventListener('click', async event => {
    if (!event.target.closest('#logout, .logout-btn, [onclick="logout()"]')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    try { await api('/api/auth/logout', { method: 'POST' }); location.href = 'login.html?logout=1'; }
    catch (error) { alert(error.message); }
  }, true);
  document.addEventListener('DOMContentLoaded', async () => {
    if (!user) return;
    initializePageHeader();
    initializeSettingsCards();
    setSidebarExpanded(window.innerWidth > 700);
    if (user.role === 'library_monitor') {
      const roleLabel = document.querySelector('.sidebar > p');
      if (roleLabel) roleLabel.textContent = 'Monitor Dashboard';
    }
    try { await loadPreferences(); } catch {}
    const style = node('style');
    style.textContent = '[hidden]{display:none!important}.qs-control{padding:12px;margin:10px 0;border:1px solid #637694;border-radius:8px}.qs-control button,.qs-control select,.qs-control textarea{padding:8px;margin:6px;max-width:100%;font:inherit}.qs-control textarea{display:block;width:90%}.qs-control button{cursor:pointer}.qs-alert{padding:12px;border:2px solid #e1a52b;border-radius:8px}';
    document.head.append(style);
    for (const link of document.querySelectorAll('a[href]')) {
      const file = link.getAttribute('href').split('/').pop();
      if (user.role === 'library_monitor' && link.closest('.sidebar') && !['dashboard.html','settings.html'].includes(file)) link.hidden = true;
    }
    const section = document.getElementById('securityEscalationsSection');
    if (section) {
      section.replaceChildren(node('h3', user.role === 'security' ? 'Security Escalations' : 'Request Security Assistance'));
      const message = node('p'); message.setAttribute('role', 'status'); section.append(message);
      if (user.role === 'library_monitor') {
        window.QuietSpaceEscalations.install({ api, section, user });
      } else if (user.role !== 'security') {
        window.QuietSpaceEscalations.install({ api, section, user });
        const form = node('form', undefined, 'qs-control');
        const select = node('select'); select.setAttribute('aria-label', 'Room');
        const reason = node('textarea'); reason.required = true; reason.maxLength = 2000;
        reason.placeholder = 'Describe the assistance needed'; reason.setAttribute('aria-label', 'Reason for assistance');
        const submit = node('button', 'Request Security'); submit.type = 'submit';
        form.append(select, reason, submit); section.append(form);
        try { for (const room of await api('/api/rooms')) {
          const option = node('option', room.room_name); option.value = room.id; select.append(option);
        } } catch (e) { message.textContent = e.message; }
        form.addEventListener('submit', async event => {
          event.preventDefault(); submit.disabled = true;
          try {
            await api('/api/security/requests', { ...json({ room_id: Number(select.value), reason: reason.value }), method: 'POST' });
            message.textContent = 'Security assistance requested.'; reason.value = '';
          } catch (e) { message.textContent = e.message; } finally { submit.disabled = false; }
        });
      } else {
        section.classList.add('qs-escalations');
        const header=node('div',undefined,'qs-tracking-header');
        const title=node('div'); title.append(node('h3','Security Escalations'),node('p','Review and respond to staff security escalations.','qs-tracking-description'));
        const activeCount=node('span','Loading…','qs-active-count');header.append(title,activeCount);
        section.replaceChildren(header,message);
        const list = node('div', undefined, 'qs-escalation-scroll'); list.tabIndex = 0; list.setAttribute('role', 'region'); list.setAttribute('aria-label', 'Security escalation queue'); section.append(list);
        let savedRequests=[];
        const tabs=window.QuietSpaceEscalations.filters(renderQueue);section.insertBefore(tabs.element,message);
        function renderQueue(){
          const requests=tabs.select(savedRequests);
          list.replaceChildren();
          if(!requests.length)list.append(node('p',tabs.empty(),'qs-tracking-empty'));
            for (const request of requests) {
              const card = window.QuietSpaceEscalations.trackingCard(request, { monitor:false, api, requests });
              const metadata=node('div',undefined,'qs-security-metadata');
              metadata.append(node('p',`Request #${request.id} · Submitted by ${request.submitted_by_name}`),node('p',`Submitted ${new Date(request.created_at).toLocaleString()}`),node('p',request.reason,'qs-security-reason'));
              card.insertBefore(metadata,card.querySelector('.qs-tracking-evidence'));
              const actions=node('div',undefined,'qs-security-actions');
              if (!['resolved','dismissed'].includes(request.status)) {
                for (const status of ['acknowledged','in_review','resolved','dismissed']) {
                  if (request.status === status || (request.status === 'in_review' && status === 'acknowledged')) continue;
                  const button = node('button', status === 'acknowledged' ? 'Acknowledge' : status === 'in_review' ? 'In Review' : status === 'resolved' ? 'Resolve' : 'Dismiss', 'view-btn');
                  button.onclick = async () => {
                    button.disabled = true;
                    try { await api(`/api/security/requests/${request.id}/status`, json({ status })); await refresh(); }
                    catch (e) { message.textContent = e.message; } finally { button.disabled = false; }
                  }; actions.append(button);
                }
              }
              if (actions.childElementCount) card.insertBefore(actions,card.querySelector('.qs-tracking-bottom'));
              list.append(card);
            }
        }
        let known = new Set(), initialized = false, loading = false, refreshAgain = false;
        async function refresh() {
          if (loading) {refreshAgain=true;return;} loading = true;
          try {
            const requests = await api('/api/security/requests');
            activeCount.textContent = `${requests.filter(r=>!['resolved','dismissed'].includes(r.status)).length} Active`;
            const fresh = requests.filter(r => r.status === 'pending' && !known.has(String(r.id)));
            if (fresh.length && initialized) { window.quietspaceNotify(`${fresh.length} new Security assistance request(s).`, true); }
            message.textContent = '';
            known = new Set(requests.map(r => String(r.id))); initialized = true;
            savedRequests=requests;renderQueue();
          } catch (e) { message.textContent = e.message; } finally { loading = false;if(refreshAgain){refreshAgain=false;await refresh();} }
        }
        await refresh();
        const events = new EventSource('/api/security/events');
        events.addEventListener('security-request', refresh); events.addEventListener('security-update', refresh);
        setInterval(refresh, 15000); // Recover requests missed during a disconnect.
        window.addEventListener('pagehide', () => events.close());
      }
    }
    if (user.role === 'admin' && location.pathname.endsWith('/settings.html')) {
      try {
        const settings=await api('/api/settings');
        const saved=typeof settings.staff_settings==='string'?JSON.parse(settings.staff_settings):settings.staff_settings||{};
        localStorage.setItem('quietspace_settings',JSON.stringify(saved));
        if(['dark','light','system'].includes(saved.theme))localStorage.setItem('quietspace_theme',saved.theme);
        window.quietspaceSecurityPolicy=settings.security_policy;
        if(typeof loadSettings==='function')loadSettings();
        document.getElementById('saveBtn').disabled=false;
      }catch(error){window.showAlert?.('Unable to load server settings. Refresh before saving.','error');}
    }
    initializeSettingsCards();
    const appearanceSave = document.getElementById('savePersonalAppearance');
    if (appearanceSave) {
      for (const card of document.querySelectorAll('#themeSection .theme-card')) {
        card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-pressed',String(card.classList.contains('active')));
        card.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();card.click();}});
      }
      appearanceSave.onclick = async () => {
        const message=document.getElementById('personalAppearanceMessage');
        if (appearanceSave.disabled) return;
        appearanceSave.disabled=true;
        try {
          window.quietspacePreferences=await api('/api/preferences',json({theme:document.getElementById('themeSection').dataset.theme}));
          applyPersonalAppearance(window.quietspacePreferences.theme);
          message.textContent='Appearance saved.';
        } catch(error) { message.textContent=error.message; } finally { appearanceSave.disabled=false; }
      };
    }
    const preferenceForm = document.getElementById('notificationPreferencesForm');
    function populatePreferences() {
      if (!preferenceForm) return;
      document.getElementById('preferenceToast').checked = window.quietspacePreferences.toast_enabled;
      document.getElementById('preferenceSound').checked = window.quietspacePreferences.sound_enabled;
      document.getElementById('preferenceQuietScore').checked = window.quietspacePreferences.quietscore_visual;
      document.getElementById('preferenceStudent').checked = window.quietspacePreferences.student_visual;
      document.getElementById('preferenceStudentSound').checked = window.quietspacePreferences.student_sound;
      document.getElementById('preferenceVolume').value = window.quietspacePreferences.volume;
      document.getElementById('preferenceVolumeValue').textContent = window.quietspacePreferences.volume + '%';
    }
    populatePreferences();
    if (preferenceForm) {
      document.getElementById('testNotificationSound').onclick = async () => {
        const message = document.getElementById('preferenceMessage');
        try { await enableAudio(true); window.quietspaceBeep({preview:true,volume:Number(document.getElementById('preferenceVolume').value)}); message.textContent='Playing sound preview.'; }
        catch { message.textContent='Sound is unavailable in this browser.'; }
      };
      document.getElementById('preferenceVolume').oninput = event => { document.getElementById('preferenceVolumeValue').textContent = event.target.value + '%'; };
      preferenceForm.onsubmit = async event => {
        event.preventDefault(); const button = preferenceForm.querySelector('button[type="submit"]'); button.disabled = true;
        const message = document.getElementById('preferenceMessage');
        try {
          window.quietspacePreferences = await api('/api/preferences', json({
            toast_enabled: document.getElementById('preferenceToast').checked,
            sound_enabled: document.getElementById('preferenceSound').checked,
            quietscore_visual: document.getElementById('preferenceQuietScore').checked,
            student_visual: document.getElementById('preferenceStudent').checked,
            student_sound: document.getElementById('preferenceStudentSound').checked,
            volume: Number(document.getElementById('preferenceVolume').value)
          }));
          message.textContent = 'Preferences saved.';
        } catch (e) { message.textContent = e.message; } finally { button.disabled = false; }
      };
    }
    const accountInfo = document.getElementById('personalAccountInfo');
    if (accountInfo) {
      const message = document.getElementById('personalAccountMessage');
      try {
        const account = await api('/api/account'); accountInfo.replaceChildren();
        const roles = { library_monitor: 'Monitor', security: 'Security Officer', admin: 'Library Administrator' };
        for (const [label, value] of [['Name',account.name],['Username',account.username],['Email',account.email],['Role',roles[account.role]]]) {
          const field = node('div'); field.append(node('dt',label),node('dd',value || 'Not provided')); accountInfo.append(field);
        }
      } catch (error) { message.textContent = error.message; }
      const form = document.getElementById('personalPasswordForm');
      form.onsubmit = async event => {
        event.preventDefault();
        const current = document.getElementById('currentAccountPassword'), next = document.getElementById('newAccountPassword'), confirm = document.getElementById('confirmAccountPassword');
        if (next.value !== confirm.value) { message.textContent = 'The new passwords do not match.'; return; }
        const submit = form.querySelector('button'); if (submit.disabled) return;
        submit.disabled = true;
        try {
          const result = await api('/api/account/password', json({ current_password: current.value, new_password: next.value }));
          form.reset(); message.textContent = result.message;
        } catch (error) { message.textContent = error.message; } finally { submit.disabled = false; }
      };
    }
    const status = document.getElementById('systemStatus');
    if (status) {
      let busy = false;
      async function checkStatus() {
        if (busy) return; busy = true;
        try {
          const result = await api('/api/system/status', { signal: AbortSignal.timeout(4000) });
          window.quietspaceLibraryTimeZone = result.time_zone;
          status.dataset.state = result.state;
          status.textContent = ({ live: 'Live', system_disabled: 'System Disabled', monitoring_paused: 'Monitoring Paused', unknown: 'Monitoring Unknown' })[result.state] || 'Monitoring Unknown';
        } catch {
          status.dataset.state = 'disconnected'; status.textContent = 'Disconnected';
        } finally { busy = false; }
      }
      checkStatus(); setInterval(checkStatus, 5000);
      window.addEventListener('offline', () => { status.dataset.state = 'disconnected'; status.textContent = 'Disconnected'; });
      window.addEventListener('online', checkStatus);
    }
    const events = new EventSource('/api/events');
    // The enclosing Reports page owns notifications; hidden embedded panels must not claim them.
    if (!document.body.hasAttribute('data-admin-report-embed')) window.QuietSpaceReportNotifications.install({api,events});
    events.addEventListener('reports-updated', () => { if (location.pathname.endsWith('/dashboard.html') && (typeof isEditingReportStatus === 'undefined' || !isEditingReportStatus)) window.loadReports?.(); });
    events.addEventListener('staff-alert', () => { if (typeof loadIncidents === 'function') loadIncidents(); });
    events.addEventListener('preferences', async () => {
      try { await loadPreferences(); populatePreferences(); } catch {}
    });
    events.addEventListener('escalation-update', () => {
      window.quietspaceRefreshEscalations?.();
      if (!document.body.hasAttribute('data-admin-report-embed')) window.quietspaceNotify('Security updated one of your escalations.', true);
    });
    events.addEventListener('monitoring', () => {
      if (typeof loadLatestReadings === 'function') loadLatestReadings();
      window.quietspaceReloadControls?.();
    });
    window.addEventListener('pagehide', () => events.close());
  });
})();
