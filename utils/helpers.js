/**
 * Utility functions for QuietSpace metrics, formatting, and calculations.
 */

/**
 * Determine the room state ('green', 'yellow', 'red') based on average dB level.
 * @param {number} level - Current decibel/volume level
 * @returns {'green' | 'yellow' | 'red'}
 */
function getStateFromLevel(level) {
  if (level == null || typeof level !== "number" || isNaN(level)) {
    return "green";
  }
  if (level < 10) return "green";
  if (level < 17) return "yellow";
  return "red";
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
  formatTimerRemaining
};
