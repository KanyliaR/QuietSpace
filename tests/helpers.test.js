const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  getStateFromLevel,
  getQuietScore,
  formatText,
  buildSeverityBadge,
  getPriorityLabel,
  formatTimerRemaining,
  validateThresholds,
  isMoreSevere,
  shouldEscalateIncident
} = require("../utils/helpers");

describe("QuietSpace Helper Utilities", () => {
  describe("getStateFromLevel", () => {
    it("returns 'green' when level is below 10", () => {
      assert.equal(getStateFromLevel(0), "green");
      assert.equal(getStateFromLevel(5.5), "green");
      assert.equal(getStateFromLevel(9.99), "green");
    });

    it("returns 'yellow' when level is between 10 and 16.99", () => {
      assert.equal(getStateFromLevel(10), "yellow");
      assert.equal(getStateFromLevel(13.5), "yellow");
      assert.equal(getStateFromLevel(16.99), "yellow");
    });

    it("returns 'red' when level is 17 or greater", () => {
      assert.equal(getStateFromLevel(17), "red");
      assert.equal(getStateFromLevel(25), "red");
      assert.equal(getStateFromLevel(100), "red");
    });

    it("handles edge cases and invalid inputs gracefully", () => {
      assert.equal(getStateFromLevel(null), "green");
      assert.equal(getStateFromLevel(undefined), "green");
      assert.equal(getStateFromLevel("invalid"), "green");
      assert.equal(getStateFromLevel(NaN), "green");
    });

    it("supports custom threshold values", () => {
      const customThresholds = { yellow: 15, red: 25 };
      assert.equal(getStateFromLevel(5, customThresholds), "green");
      assert.equal(getStateFromLevel(14.99, customThresholds), "green");
      assert.equal(getStateFromLevel(15, customThresholds), "yellow");
      assert.equal(getStateFromLevel(24.99, customThresholds), "yellow");
      assert.equal(getStateFromLevel(25, customThresholds), "red");
      assert.equal(getStateFromLevel(30, customThresholds), "red");
    });
  });

  describe("getQuietScore", () => {
    it("maps states to correct QuietScore descriptions", () => {
      assert.equal(getQuietScore("green"), "Quiet");
      assert.equal(getQuietScore("yellow"), "Warning");
      assert.equal(getQuietScore("red"), "Too Loud");
    });

    it("defaults to 'Quiet' for unrecognized state", () => {
      assert.equal(getQuietScore("unknown"), "Quiet");
      assert.equal(getQuietScore(""), "Quiet");
    });
  });

  describe("formatText", () => {
    it("converts snake_case to Title Case", () => {
      assert.equal(formatText("needs_staff_attention"), "Needs Staff Attention");
      assert.equal(formatText("loud_talking"), "Loud Talking");
      assert.equal(formatText("in_review"), "In Review");
      assert.equal(formatText("resolved"), "Resolved");
    });

    it("handles empty or invalid inputs", () => {
      assert.equal(formatText(""), "");
      assert.equal(formatText(null), "");
      assert.equal(formatText(undefined), "");
      assert.equal(formatText(123), "");
    });
  });

  describe("buildSeverityBadge", () => {
    it("returns appropriate exclamation marks", () => {
      assert.equal(buildSeverityBadge("low"), "!");
      assert.equal(buildSeverityBadge("LOW"), "!");
      assert.equal(buildSeverityBadge("medium"), "!!");
      assert.equal(buildSeverityBadge("Medium"), "!!");
      assert.equal(buildSeverityBadge("high"), "!!!");
      assert.equal(buildSeverityBadge("HIGH"), "!!!");
    });

    it("returns dash or original text for invalid/empty inputs", () => {
      assert.equal(buildSeverityBadge(""), "—");
      assert.equal(buildSeverityBadge(null), "—");
      assert.equal(buildSeverityBadge(undefined), "—");
      assert.equal(buildSeverityBadge("custom"), "custom");
    });
  });

  describe("getPriorityLabel", () => {
    it("returns low priority for 0 or negative escalation", () => {
      assert.deepEqual(getPriorityLabel(0, "open"), {
        text: "—",
        className: "priority-low"
      });
      assert.deepEqual(getPriorityLabel(null, "open"), {
        text: "—",
        className: "priority-low"
      });
    });

    it("returns 'NEEDS ATTENTION' for open incidents with 3 or more escalations", () => {
      assert.deepEqual(getPriorityLabel(3, "open"), {
        text: "NEEDS ATTENTION",
        className: "priority-high"
      });
      assert.deepEqual(getPriorityLabel(4, "open"), {
        text: "NEEDS ATTENTION",
        className: "priority-high"
      });
    });

    it("returns '!!' with high priority for open incidents with 2 escalations", () => {
      assert.deepEqual(getPriorityLabel(2, "open"), {
        text: "!!",
        className: "priority-high"
      });
    });

    it("returns '!' with medium priority for open incidents with 1 escalation", () => {
      assert.deepEqual(getPriorityLabel(1, "open"), {
        text: "!",
        className: "priority-medium"
      });
    });

    it("retains exclamation marks for resolved incidents without high attention label", () => {
      assert.deepEqual(getPriorityLabel(3, "resolved"), {
        text: "!!!",
        className: "priority-high"
      });
      assert.deepEqual(getPriorityLabel(1, "resolved"), {
        text: "!",
        className: "priority-medium"
      });
    });
  });

  describe("formatTimerRemaining", () => {
    it("formats minutes and seconds accurately for ongoing timer", () => {
      const timerStart = "2026-10-22T01:00:00.000Z";
      const totalDuration = 2 * 60 * 1000;
      const now1 = new Date("2026-10-22T01:00:30.000Z").getTime();
      const now2 = new Date("2026-10-22T01:01:05.000Z").getTime();

      assert.equal(
        formatTimerRemaining(timerStart, totalDuration, now1),
        "1:30 remaining"
      );
      assert.equal(
        formatTimerRemaining(timerStart, totalDuration, now2),
        "0:55 remaining"
      );
    });

    it("returns 'Completed' when time has fully elapsed", () => {
      const timerStart = "2026-10-22T01:00:00.000Z";
      const totalDuration = 2 * 60 * 1000;
      const now = new Date("2026-10-22T01:02:01.000Z").getTime();

      assert.equal(
        formatTimerRemaining(timerStart, totalDuration, now),
        "Completed"
      );
    });

    it("returns 'Completed' for null or invalid dates", () => {
      assert.equal(formatTimerRemaining(null), "Completed");
      assert.equal(formatTimerRemaining("invalid-date"), "Completed");
    });
  });

  describe("validateThresholds", () => {
    it("passes for valid default thresholds", () => {
      const result = validateThresholds(10, 17);
      assert.equal(result.valid, true);
      assert.equal(result.error, null);
    });

    it("passes for valid string numeric thresholds", () => {
      const result = validateThresholds("12", "20");
      assert.equal(result.valid, true);
      assert.equal(result.error, null);
    });

    it("fails if red threshold is less than yellow threshold", () => {
      const result = validateThresholds(20, 15);
      assert.equal(result.valid, false);
      assert.match(result.error, /strictly higher than yellow/i);
    });

    it("fails if red threshold equals yellow threshold", () => {
      const result = validateThresholds(15, 15);
      assert.equal(result.valid, false);
      assert.match(result.error, /strictly higher than yellow/i);
    });

    it("fails if yellow threshold is less than 1", () => {
      assert.equal(validateThresholds(0, 15).valid, false);
      assert.match(validateThresholds(0, 15).error, /yellow threshold must be a valid number of at least 1/i);
      assert.equal(validateThresholds(-5, 15).valid, false);
    });

    it("fails if red threshold is less than 1", () => {
      assert.equal(validateThresholds(10, 0).valid, false);
      assert.match(validateThresholds(10, 0).error, /red threshold must be a valid number of at least 1/i);
      assert.equal(validateThresholds(10, -2).valid, false);
    });

    it("fails for invalid/missing threshold values", () => {
      assert.equal(validateThresholds(null, 17).valid, false);
      assert.equal(validateThresholds(undefined, 17).valid, false);
      assert.equal(validateThresholds("", 17).valid, false);
      assert.equal(validateThresholds("abc", 17).valid, false);
      assert.equal(validateThresholds(10, null).valid, false);
      assert.equal(validateThresholds(10, undefined).valid, false);
      assert.equal(validateThresholds(10, "").valid, false);
      assert.equal(validateThresholds(10, "xyz").valid, false);
    });
  });

  describe("isMoreSevere", () => {
    it("returns true when newState has higher severity than oldState", () => {
      assert.equal(isMoreSevere("yellow", "green"), true);
      assert.equal(isMoreSevere("red", "yellow"), true);
      assert.equal(isMoreSevere("red", "green"), true);
    });

    it("returns false when newState has equal or lower severity", () => {
      assert.equal(isMoreSevere("green", "green"), false);
      assert.equal(isMoreSevere("yellow", "yellow"), false);
      assert.equal(isMoreSevere("red", "red"), false);
      assert.equal(isMoreSevere("green", "yellow"), false);
      assert.equal(isMoreSevere("yellow", "red"), false);
      assert.equal(isMoreSevere("green", "red"), false);
    });

    it("handles unknown states safely", () => {
      assert.equal(isMoreSevere("unknown", "green"), false);
      assert.equal(isMoreSevere("green", "unknown"), true);
    });
  });

  describe("shouldEscalateIncident", () => {
    it("escalates when timer has expired and latest detected state is red", () => {
      assert.equal(shouldEscalateIncident({
        remainingMs: 0,
        latestDetectedState: "red",
        countdownFinished: false
      }), true);

      assert.equal(shouldEscalateIncident({
        remainingMs: -500,
        latestDetectedState: "red",
        countdownFinished: false
      }), true);
    });

    it("does not escalate if timer still has time remaining", () => {
      assert.equal(shouldEscalateIncident({
        remainingMs: 30000,
        latestDetectedState: "red",
        countdownFinished: false
      }), false);
    });

    it("does not escalate if room noise subsided to green or yellow", () => {
      assert.equal(shouldEscalateIncident({
        remainingMs: 0,
        latestDetectedState: "green",
        countdownFinished: false
      }), false);

      assert.equal(shouldEscalateIncident({
        remainingMs: 0,
        latestDetectedState: "yellow",
        countdownFinished: false
      }), false);
    });

    it("does not escalate if countdown was already marked finished", () => {
      assert.equal(shouldEscalateIncident({
        remainingMs: 0,
        latestDetectedState: "red",
        countdownFinished: true
      }), false);
    });
  });
});
