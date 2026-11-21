/* Current dashboard components for owned escalations, evidence selection and Security details. */
(() => {
  // Shared navigation stays scoped to the open detail view and its authorized list.
  window.QuietSpaceDetailNavigation = function (modal, { items, current, open, isOpen = () => modal.open }) {
    modal.querySelector('.qs-detail-navigation')?.remove();
    modal._detailNavigationCleanup?.();
    const bar = document.createElement('nav'); bar.className = 'qs-detail-navigation';
    bar.setAttribute('aria-label', 'Detail navigation');
    const move = direction => {
      const rows = items(), index = rows.findIndex(row => String(row.id) === String(current()));
      if (index >= 0 && rows[index + direction]) open(rows[index + direction]);
    };
    for (const [direction, symbol, label] of [[-1, '←', 'Previous'], [1, '→', 'Next']]) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = symbol; button.className = 'qs-detail-arrow'; button.setAttribute('aria-label', label);
      const rows = items(), index = rows.findIndex(row => String(row.id) === String(current()));
      button.style.visibility = index >= 0 && rows[index + direction] ? 'visible' : 'hidden';
      button.onclick = () => move(direction); bar.append(button);
    }
    const panel = modal.classList.contains('modal-backdrop') ? modal.querySelector('.modal') : modal;
    panel.classList.add('qs-has-detail-navigation');
    panel.append(bar);
    const position = () => {
      const bounds = panel.getBoundingClientRect();
      const [previous, next] = bar.children;
      for (const button of bar.children) button.style.top = `${bounds.top + bounds.height / 2}px`;
      previous.style.left = `${bounds.left + 4}px`;
      next.style.left = `${bounds.right - 48}px`;
    };
    const observer = new ResizeObserver(position); observer.observe(panel);
    window.addEventListener('resize', position);
    const frame = requestAnimationFrame(position);
    const keyboard = event => {
      if (!isOpen() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          event.target.closest?.('input, textarea, select, [contenteditable="true"]') ||
          !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1);
    };
    document.addEventListener('keydown', keyboard);
    modal._detailNavigationCleanup = () => {
      document.removeEventListener('keydown', keyboard);
      window.removeEventListener('resize', position);
      observer.disconnect(); cancelAnimationFrame(frame);
    };
    modal.addEventListener('close', modal._detailNavigationCleanup, { once: true });
  };
  const sources = { inside_room: 'Inside the selected room', surrounding_area: 'General area surrounding the room', unsure: 'Unsure of the source' };
  const statuses = { pending: 'Submitted', acknowledged: 'Acknowledged', in_review: 'In Review', resolved: 'Resolved', dismissed: 'Dismissed' };
  const statusClass = status => status === 'resolved' ? 'status-resolved' : ['acknowledged','in_review','needs_staff_attention'].includes(status) ? 'status-in_review' : status === 'dismissed' ? 'inactive' : 'status-open';
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const badge = status => node('span', statuses[status] || String(status).replace(/_/g, ' '), 'status ' + statusClass(status));
  const studentBadge = report => node('span', report.status === 'resolved' && report.resolution_method === 'automatic' ? 'Auto-Resolved' : ({open:'Open',in_review:'In Review',resolved:'Resolved'}[report.status] || report.status), 'status qs-student-status status-' + report.status);
  const time = value => new Date(value).toLocaleString(undefined, { timeZone: window.quietspaceLibraryTimeZone || 'America/New_York' });
  function dialog(title) {
    document.querySelectorAll('dialog[data-transient-dialog]:not([open])').forEach(element => element.remove());
    const modal = node('dialog', undefined, 'qs-modal');
    modal.dataset.transientDialog = '';
    const header = node('div', undefined, 'qs-modal-header');
    const heading = node('h3', title); heading.id = 'qsDialogTitle' + Math.random().toString(36).slice(2);
    modal.setAttribute('aria-labelledby', heading.id);
    const close = node('button', '×', 'qs-modal-close'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
    header.append(heading, close); modal.append(header); document.body.append(modal);
    close.onclick = () => modal.close(); modal.addEventListener('close', () => modal.remove());
    return { modal, close };
  }
  function trackingCard(request, { monitor, api, requests }) {
    const row = node('article', undefined, 'qs-escalation-row');
    row.dataset.escalationId = String(request.id);
    const cardHeader = node('div', undefined, 'qs-tracking-card-header');
    cardHeader.append(node('h4', request.room_name), badge(request.status));
    const source = node('p', sources[request.noise_source] || 'Source not recorded', 'qs-tracking-source');
    const evidence = node('div', undefined, 'qs-tracking-evidence');
    for (const [count, type] of [[Number(request.quietscore_count), 'QuietScore'], [Number(request.student_count), 'Student']]) {
      evidence.append(node('span', `${count} ${type} report${count === 1 ? '' : 's'}`, 'qs-evidence-pill'));
    }
    const bottom = node('div', undefined, 'qs-tracking-bottom');
    const update = node('div', undefined, 'qs-tracking-update');
    update.append(node('p', request.latest_staff_update || 'No security updates yet.'));
    const timestamp = node('time', time(request.latest_staff_update_at || request.created_at));
    timestamp.dateTime = request.latest_staff_update_at || request.created_at; update.append(timestamp);
    const details = node('button', 'View Details', 'view-btn'); details.type = 'button';
    details.onclick = () => window.QuietSpaceEscalations.details(request.id, monitor, api, requests);
    bottom.append(update, details); row.append(cardHeader, source, evidence, bottom); return row;
  }
  function filters(onChange) {
    let selected='active';
    const element=node('div',undefined,'qs-escalation-filters');element.setAttribute('role','group');element.setAttribute('aria-label','Filter security escalations');
    const buttons=[];
    for(const [value,label] of [['active','Active'],['resolved','Resolved'],['all','All']]) {
      const button=node('button',label,'view-btn');button.type='button';button.dataset.escalationFilter=value;button.setAttribute('aria-pressed',String(value===selected));
      button.onclick=()=>{selected=value;for(const item of buttons)item.setAttribute('aria-pressed',String(item.dataset.escalationFilter===selected));onChange();};buttons.push(button);element.append(button);
    }
    return {element,select:rows=>rows.filter(row=>selected==='all'||(selected==='resolved'?row.status==='resolved':!['resolved','dismissed'].includes(row.status))),empty:()=>selected==='active'?'No active security escalations.':selected==='resolved'?'No resolved security escalations.':'No security escalations in your history.'};
  }
  window.QuietSpaceEscalations = { sources, statuses, badge, trackingCard, filters,
    async details(id, monitor, api, items = []) {
      const { modal } = dialog('Security Escalation Details');
      const content = node('div', 'Loading…'); modal.append(content); modal.showModal();
      window.QuietSpaceDetailNavigation(modal, { items: () => items, current: () => id, open: next => { modal.close(); window.QuietSpaceEscalations.details(next.id, monitor, api, items); } });
      try {
        const request = await api(`/api/security/requests/${monitor ? 'mine/' : ''}${id}`);
        if (!modal.open) return;
        content.classList.add('qs-details-content');
        const overview = node('section', undefined, 'qs-detail-section');
        const overviewHeader = node('div', undefined, 'qs-detail-heading');
        overviewHeader.append(node('h4', request.room_name), badge(request.status));
        const metadata = node('dl', undefined, 'qs-detail-fields');
        for (const [label, value] of [['Noise source', sources[request.noise_source] || 'Not recorded'], ['Submitted', time(request.created_at)]]) {
          const field = node('div'); field.append(node('dt', label), node('dd', value)); metadata.append(field);
        }
        overview.append(overviewHeader, metadata);
        const reason = node('section', undefined, 'qs-detail-section');
        reason.append(node('h4', 'Reason for Escalation'), node('p', request.reason, 'qs-detail-text'));
        content.replaceChildren(overview, reason);
        const evidence = node('section', undefined, 'qs-detail-section');
        evidence.append(node('h4', 'Supporting Reports'));
        const groups = node('div', undefined, 'qs-detail-evidence');
        for (const [title, rows] of [['QuietScore Reports', request.quietscore_reports], ['Student Reports', request.student_reports]]) {
          const group = node('div', undefined, 'qs-detail-report-group');
          const heading = node('div', undefined, 'qs-detail-heading');
          heading.append(node('h5', title), node('span', String(rows.length), 'qs-detail-count')); group.append(heading);
          if (!rows.length) group.append(node('p', 'None attached.', 'qs-detail-muted'));
          for (const report of rows) {
            const row = node('article', undefined, 'qs-detail-report');
            const top = node('div', undefined, 'qs-detail-heading'); top.append(node('strong', report.room_name), title === 'Student Reports' ? studentBadge(report) : badge(report.status));
            row.append(top, node('p', String(report.description), 'qs-detail-text'), node('time', time(report.timestamp), 'qs-detail-muted')); group.append(row);
          }
          groups.append(group);
        }
        evidence.append(groups); content.append(evidence);
        const updates = node('section', undefined, 'qs-detail-section'); updates.append(node('h4', 'Security Updates'));
        if (!request.comments.length) updates.append(node('p', monitor ? 'No staff-visible updates yet.' : 'No updates yet.', 'qs-detail-muted'));
        for (const comment of request.comments) {
          const update = node('article', undefined, 'qs-detail-update');
          const header = node('div', undefined, 'qs-detail-heading'); header.append(node('strong', comment.author_name));
          if (!monitor) header.append(node('span', comment.staff_visible ? 'Staff-visible' : 'Internal', 'qs-detail-count'));
          update.append(header, node('time', time(comment.created_at), 'qs-detail-muted'), node('p', comment.body, 'qs-detail-text')); updates.append(update);
        }
        content.append(updates);
        const history = node('section', undefined, 'qs-detail-section'); history.append(node('h4', 'Status History'));
        const timeline = node('ol', undefined, 'qs-detail-timeline');
        for (const event of request.history) {
          const item = node('li'); item.append(badge(event.status), node('span', event.actor_name), node('time', time(event.created_at))); timeline.append(item);
        }
        history.append(timeline); content.append(history);
        if (!monitor) {
          const form = node('form', undefined, 'qs-security-comment');
          const label = node('label', 'Security comment');
          const body = node('textarea'); body.required = true; body.maxLength = 2000; body.setAttribute('aria-label', 'Security comment');
          const visibilityLabel = node('label'); const visibility = node('input'); visibility.type = 'checkbox';
          visibilityLabel.append(visibility, document.createTextNode(' Share with the submitting staff member (unchecked = internal note)'));
          const submit = node('button', 'Add Comment', 'view-btn'); submit.type = 'submit';
          const message = node('p'); message.setAttribute('role', 'status');
          form.append(label, body, visibilityLabel, submit, message); content.append(form);
          form.onsubmit = async event => {
            event.preventDefault(); if (!body.value.trim() || submit.disabled) return;
            submit.disabled = true;
            try {
              await api(`/api/security/requests/${id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: body.value, staff_visible: visibility.checked }) });
              message.textContent = 'Comment saved.'; body.value = '';
            } catch (e) { message.textContent = e.message; } finally { submit.disabled = false; }
          };
        }
      } catch (e) { content.textContent = e.message; }
    },
    install({ api, section, user }) {
      const monitor = user.role === 'library_monitor';
      if (!monitor && user.role !== 'admin') return;
      const heading = node('div', undefined, 'qs-tracking-header');
      const title = node('div'); title.append(node('h3', 'Security Escalations'), node('p', 'Track your submitted security escalations.', 'qs-tracking-description'));
      const activeCount = node('span', 'Loading…', 'qs-active-count'); heading.append(title, activeCount);
      if (monitor) section.classList.add('qs-monitor-escalations', 'qs-escalations');
      const list = node('div', undefined, 'qs-escalation-scroll'); list.tabIndex = 0; list.setAttribute('role', 'region'); list.setAttribute('aria-label', 'Your security escalations'); const feedback = node('p'); feedback.setAttribute('role', 'status');
      let savedRequests=[];
      const tabs=filters(renderMine);
      function renderMine(){list.replaceChildren();const visible=tabs.select(savedRequests);if(!visible.length)list.append(node('p',tabs.empty(),'qs-tracking-empty'));for(const request of visible)list.append(trackingCard(request,{monitor:true,api,requests:visible}));}
      if (monitor) section.replaceChildren(heading, tabs.element, feedback, list);
      let refreshing = false, refreshAgain = false;
      async function refreshMine() {
        if (!monitor) return;
        if (refreshing) { refreshAgain = true; return; }
        refreshing = true;
        try {
          const requests = await api('/api/security/requests/mine'); savedRequests=requests;
          activeCount.textContent = `${requests.filter(r => !['resolved','dismissed'].includes(r.status)).length} Active`;
          renderMine();
          feedback.textContent = '';
        } catch (e) { feedback.textContent = e.message; } finally {
          refreshing = false;
          if (refreshAgain) { refreshAgain = false; await refreshMine(); }
        }
      }
      if (monitor) {
        window.quietspaceRefreshEscalations = refreshMine;
        refreshMine(); setInterval(refreshMine, 15000);
      }
      let activeModal = null;
      document.addEventListener('click', async event => {
        const trigger = event.target.closest('[data-escalate-room]');
        if (!trigger || activeModal?.open) return;
        const card = trigger.closest('[data-room-id]');
        const roomId = Number(trigger.dataset.escalateRoom), roomName = card.dataset.roomName;
        const { modal, close } = dialog('Escalate to Security'); activeModal = modal;
        const form = node('form');
        form.append(node('p', 'Primary Room: ' + roomName));
        const fieldset = node('fieldset'); fieldset.append(node('legend', 'Where is the noise or disturbance coming from? (Required)'));
        for (const [value, label] of Object.entries(sources)) {
          const choice = node('label'); const radio = node('input');
          radio.type = 'radio'; radio.name = 'noise_source'; radio.value = value; radio.required = true;
          choice.append(radio, document.createTextNode(' ' + label)); fieldset.append(choice);
        }
        const reasonLabel = node('label', 'Reason for Escalation (Required)');
        const reason = node('textarea'); reason.required = true; reason.maxLength = 2000;
        reason.placeholder = 'Describe the situation requiring security assistance…'; reason.id = 'escalationReason'; reasonLabel.htmlFor = reason.id;
        reason.oninput = () => reason.setCustomValidity('');
        const tabs = node('div', undefined, 'qs-evidence-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Supporting Reports');
        const evidenceLabel = node('h4', 'Supporting Reports (Optional)');
        const evidence = node('div', 'Loading reports…', 'qs-evidence-list'); evidence.id = 'escalationEvidence'; evidence.setAttribute('role', 'tabpanel');
        const summary = node('div', undefined, 'qs-summary'); summary.setAttribute('aria-live', 'polite');
        const error = node('p', undefined, 'qs-error'); error.setAttribute('role', 'alert');
        const actions = node('div', undefined, 'qs-modal-actions');
        const cancel = node('button', 'Cancel', 'view-btn'); cancel.type = 'button'; cancel.onclick = () => modal.close();
        const submit = node('button', 'Escalate to Security', 'qs-escalate-button'); submit.type = 'submit';
        actions.append(cancel, submit); form.append(fieldset, reasonLabel, reason, evidenceLabel, tabs, evidence, summary, error, actions); modal.append(form);
        let reports = { quietscore_reports: [], student_reports: [] }, tab = 'quietscore_reports', pending = false;
        const selected = { quietscore_reports: new Set(), student_reports: new Set() };
        const submissionKey = crypto.randomUUID();
        function updateSummary() {
          const source = form.querySelector('input[name="noise_source"]:checked')?.value;
          summary.replaceChildren(node('h4', 'Escalation Summary'));
          const fields = node('dl', undefined, 'qs-summary-fields');
          for (const [label, value] of [['Primary room', roomName], ['Noise source', sources[source] || 'Choose a source']]) {
            const field = node('div'); field.append(node('dt', label), node('dd', value)); fields.append(field);
          }
          const counts = node('div', undefined, 'qs-summary-counts');
          for (const [count, label] of [[selected.quietscore_reports.size, 'QuietScore'], [selected.student_reports.size, 'Student']]) {
            const item = node('div'); item.append(node('strong', String(count)), node('span', `${label} report${count === 1 ? '' : 's'}`)); counts.append(item);
          }
          summary.append(fields, counts);
        }
        fieldset.onchange = updateSummary;
        const tabButtons = {};
        function renderEvidence() {
          for (const [type, button] of Object.entries(tabButtons)) button.setAttribute('aria-selected', String(type === tab));
          evidence.replaceChildren();
          evidence.setAttribute('aria-labelledby', tabButtons[tab].id);
          if (!reports[tab].length) evidence.append(node('p', reports.scope === 'all' ? 'No stored reports available.' : 'No reports for the current library day.'));
          // Preserve API/dashboard order; never sort by room or report ID here.
          for (const report of reports[tab]) {
            const label = node('label', undefined, 'qs-evidence-row'); const check = node('input');
            check.type = 'checkbox'; check.checked = selected[tab].has(report.id);
            check.dataset.evidenceType = tab; check.dataset.reportId = report.id;
            check.onchange = () => { check.checked ? selected[tab].add(report.id) : selected[tab].delete(report.id); updateSummary(); };
            const detail = node('span', `${report.room_name} · ${report.description}`);
            detail.append(node('small', time(report.timestamp))); label.append(check, detail, tab === 'student_reports' ? studentBadge(report) : badge(report.status)); evidence.append(label);
          }
        }
        for (const [type, label] of [['quietscore_reports','QuietScore Reports'],['student_reports','Student Reports']]) {
          const button = node('button', label, 'view-btn'); button.type = 'button'; button.id = 'tab-' + type;
          button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', evidence.id);
          button.onclick = () => { tab = type; renderEvidence(); }; tabs.append(button); tabButtons[type] = button;
        }
        modal.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
        modal.addEventListener('close', () => {
          if (activeModal === modal) activeModal = null;
          if (!activeModal?.open) document.querySelector(`[data-escalate-room="${roomId}"]`)?.focus();
        });
        form.onsubmit = async event => {
          event.preventDefault(); if (pending) return;
          reason.setCustomValidity(reason.value.trim() ? '' : 'Enter a reason for the escalation.');
          if (!form.reportValidity()) return;
          const source = form.querySelector('input[name="noise_source"]:checked')?.value;
          if (!source) return;
          pending = true; submit.disabled = true; cancel.disabled = true; close.disabled = true; error.textContent = '';
          try {
            await api('/api/security/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
              room_id: roomId, noise_source: source, reason: reason.value.trim(), submission_key: submissionKey,
              quietscore_report_ids: [...selected.quietscore_reports], student_report_ids: [...selected.student_reports]
            }) });
            modal.close(); window.quietspaceNotify?.('Escalation submitted to Security.'); await refreshMine();
          } catch (e) { error.textContent = e.message; }
          finally { pending = false; submit.disabled = false; cancel.disabled = false; close.disabled = false; }
        };
        updateSummary(); modal.showModal();
        try {
          reports = await api('/api/escalation-support/today');
          window.quietspaceLibraryTimeZone = reports.time_zone;
          if (modal.open) {
            evidenceLabel.textContent = reports.scope === 'all' ? 'Supporting Reports (Optional) · All stored reports' : `Supporting Reports (Optional) · ${reports.library_date} (${reports.time_zone})`;
            renderEvidence();
          }
        } catch (e) { if (modal.open) { evidence.textContent = 'Supporting reports could not be loaded. You can submit without attachments.'; error.textContent = e.message; } }
      });
    }
  };
})();
