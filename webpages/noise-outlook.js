/* Preserved illustrative outlook data/renderer from the original analytics page.
 * Not loaded by historical analytics; these examples are not measurements or forecasts. */
(() => {
    const OUTLOOK = {
      A: {
        prediction: "Elevated Noise Expected",
        type: "elevated",
        monitoring: "Active",
        time: "2:00–4:00 PM",
        description:
          "Based on historical readings, Room A may experience increased noise during this time.",
        action:
          "Prioritize Room A during afternoon rounds."
      },

      B: {
        prediction: "Typically Quiet",
        type: "quiet",
        monitoring: "Not Active",
        time: "No elevated period predicted",
        description:
          "Historical readings suggest no recurring elevated-noise period for today.",
        action:
          "Continue routine monitoring."
      },

      C: {
        prediction: "Elevated Noise Expected",
        type: "elevated",
        monitoring: "Not Active",
        time: "5:00–6:00 PM",
        description:
          "Based on historical readings, Room C may experience increased noise during this time.",
        action:
          "Consider checking Room C during evening rounds."
      }
    };

    function renderOutlook(container, rooms = Object.keys(OUTLOOK)) {
      if (!container) return;

      container.innerHTML = rooms.filter(room => Object.hasOwn(OUTLOOK, room))
        .map(room => {
          const item = OUTLOOK[room];

          const predictionClass =
            item.type === "elevated"
              ? "badge-elevated"
              : "badge-quiet";

          const monitoringClass =
            item.monitoring === "Active"
              ? "badge-active"
              : "badge-inactive";

          return `
            <article class="room-card">

              <h4 class="room-title">
                Room ${room}
              </h4>

              <div class="badge-row">
                <span class="badge ${predictionClass}">
                  ${item.prediction}
                </span>

                <span class="badge ${monitoringClass}">
                  ${item.monitoring}
                </span>
              </div>

              <div class="predicted-time">
                ${item.time}
              </div>

              <p class="prediction-description">
                ${item.description}
              </p>

              <div class="suggestion">
                <strong>Suggested Action</strong>
                ${item.action}
              </div>

            </article>
          `;
        }).join("");
    }


  window.QuietSpaceNoiseOutlook = { data: OUTLOOK, render: renderOutlook, demonstration: true };
})();
