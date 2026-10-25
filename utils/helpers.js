/**
 * Utility functions for QuietSpace metrics, formatting, and calculations.
 */

/**
 * Determine the room state ('green', 'yellow', 'red') based on average dB level.
 * @param {number} level - Current decibel/volume level
 * @param {{ yellow?: number, red?: number }} [thresholds] - Configured thresholds (default: 10, 17)
 * @returns {'green' | 'yellow' | 'red'}
 */
function getStateFromLevel(level, thresholds = { yellow: 10, red: 17 }) {
  if (level == null || typeof level !== "number" || isNaN(level)) {
    return "green";
  }
  const yellow = (thresholds && typeof thresholds.yellow === "number" && !isNaN(thresholds.yellow))
    ? thresholds.yellow
    : 10;
  const red = (thresholds && typeof thresholds.red === "number" && !isNaN(thresholds.red))
    ? thresholds.red
    : 17;

  if (level < yellow) return "green";
  if (level < red) return "yellow";
  return "red";
}

/**
 * Validate decibel threshold settings.
 * Yellow and Red must be valid numbers of at least 1, and Red must be strictly higher than Yellow.
 * @param {number|string} yellow
 * @param {number|string} red
 * @returns {{ valid: boolean, error: string | null }}
 */
function validateThresholds(yellow, red) {
  const y = Number(yellow);
  const r = Number(red);

  if (yellow === null || yellow === undefined || yellow === "" || isNaN(y) || y < 1) {
    return {
      valid: false,
      error: "Yellow threshold must be a valid number of at least 1."
    };
  }

  if (red === null || red === undefined || red === "" || isNaN(r) || r < 1) {
    return {
      valid: false,
      error: "Red threshold must be a valid number of at least 1."
    };
  }

  if (y >= r) {
    return {
      valid: false,
      error: `Red threshold (${r}) must be strictly higher than Yellow threshold (${y}).`
    };
  }

  return {
    valid: true,
    error: null
  };
}

/**
 * Compare severity between two room states: green < yellow < red.
 * @param {'green' | 'yellow' | 'red'} newState
 * @param {'green' | 'yellow' | 'red'} oldState
 * @returns {boolean} True if newState is strictly more severe than oldState
 */
function isMoreSevere(newState, oldState) {
  const severity = {
    green: 0,
    yellow: 1,
    red: 2
  };
  const newRank = severity[newState] ?? -1;
  const oldRank = severity[oldState] ?? -1;
  return newRank > oldRank;
}

/**
 * Evaluate if incident escalation conditions are met.
 * Escalation occurs when the red countdown timer has expired (remainingMs <= 0),
 * the countdown is not already marked finished, and the latest measured room state is 'red'.
 * @param {object} params
 * @param {number} params.remainingMs - Remaining countdown timer milliseconds
 * @param {string} params.latestDetectedState - Current detected room state
 * @param {boolean} [params.countdownFinished=false] - Whether countdown already finished
 * @returns {boolean}
 */
function shouldEscalateIncident({ remainingMs, latestDetectedState, countdownFinished = false }) {
  if (countdownFinished) {
    return false;
  }
  return remainingMs <= 0 && latestDetectedState === "red";
}

/**
 * Map status color to human-readable QuietScore string.
 * @param {'green' | 'yellow' | 'red'} state
 * @returns {string}
 */
function getQuietScore(state) {
  if (state === "green") return "Quiet";
  if (state === "yellow") return "Warning";
  if (state === "red") return "Too Loud";
  return "Quiet";
}

/**
 * Format underscores to title-case text (e.g. 'needs_staff_attention' -> 'Needs Staff Attention').
 * @param {string} text
 * @returns {string}
 */
function formatText(text) {
  if (!text || typeof text !== "string") {
    return "";
  }
  return text
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Return severity exclamation marks based on level.
 * @param {string} level - 'low' | 'medium' | 'high'
 * @returns {string}
 */
function buildSeverityBadge(level) {
  if (!level || typeof level !== "string") {
    return "—";
  }
  const value = level.toLowerCase();
  if (value === "low") return "!";
  if (value === "medium") return "!!";
  if (value === "high") return "!!!";
  return level;
}

/**
 * Translate incident escalation count into priority badge indicator.
 * @param {number} escalationCount
 * @param {string} status - 'open' | 'resolved'
 * @returns {{ text: string, className: string }}
 */
function getPriorityLabel(escalationCount, status) {
  if (!escalationCount || escalationCount < 1) {
    return {
      text: "—",
      className: "priority-low"
    };
  }

  const marks = "!".repeat(escalationCount);

  if (status === "open") {
    if (escalationCount >= 3) {
      return {
        text: "NEEDS ATTENTION",
        className: "priority-high"
      };
    }
    if (escalationCount >= 2) {
      return {
        text: marks,
        className: "priority-high"
      };
    }
    return {
      text: marks,
      className: "priority-medium"
    };
  }

  if (escalationCount >= 2) {
    return {
      text: marks,
      className: "priority-high"
    };
  }

  return {
    text: marks,
    className: "priority-medium"
  };
}

/**
 * Format remaining incident countdown time.
 * @param {string | Date} timerStartedAt
 * @param {number} [redTimeMs=120000] - Total countdown duration in ms
 * @param {number} [now=Date.now()] - Current epoch ms
 * @returns {string}
 */
function formatTimerRemaining(timerStartedAt, redTimeMs = 2 * 60 * 1000, now = Date.now()) {
  if (!timerStartedAt) return "Completed";
  const timerStart = new Date(timerStartedAt).getTime();
  if (isNaN(timerStart)) return "Completed";
  const elapsed = now - timerStart;
  const remaining = Math.max(0, redTimeMs - elapsed);
  if (remaining <= 0) return "Completed";
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")} remaining`;
}

module.exports = {
  getStateFromLevel,
  getQuietScore,
  formatText,
  buildSeverityBadge,
  getPriorityLabel,
  formatTimerRemaining,
  validateThresholds,
  isMoreSevere,
  shouldEscalateIncident
};
