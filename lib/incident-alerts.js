/* Read-only legacy-testing assessment; never creates historical events or timestamps. */
function incidentAlerts(incident) {
  const generated = incident.recorded_staff_alert === true || Number(incident.recorded_staff_alert) === 1;
  const displayed = incident.recorded_staff_display === true || Number(incident.recorded_staff_display) === 1;
  const legacy = !incident.tracking_started_at;
  const cycles = Number(incident.escalation_count);
  const inferredDisplay = legacy && Number.isFinite(cycles) && cycles >= 3 && !displayed;
  const inferredAlert = legacy && Number.isFinite(cycles) && cycles >= 3 && !generated && !displayed;
  return {
    staff_alert_triggered: generated ? true : legacy ? null : false,
    staff_alert_displayed: displayed ? true : legacy ? null : false,
    legacy_staff_alert_inferred: inferredAlert,
    staff_alert_display_inferred: inferredDisplay,
    legacy_alert_inference: inferredAlert || inferredDisplay ? {
      source: 'legacy_testing_inference', countdown_cycles: cycles, threshold: 3, occurred_at: null,
      description: `Recorded cycle count ${cycles} met the legacy staff-alert threshold. Alert display is inferred; no display receipt or exact display time was recorded.`
    } : null
  };
}
module.exports = { incidentAlerts };
