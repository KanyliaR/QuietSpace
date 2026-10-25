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
    test("returns 'green' when level is below 10", () => {
      expect(getStateFromLevel(0)).toBe("green");
      expect(getStateFromLevel(5.5)).toBe("green");
      expect(getStateFromLevel(9.99)).toBe("green");
    });

    test("returns 'yellow' when level is between 10 and 16.99", () => {
      expect(getStateFromLevel(10)).toBe("yellow");
      expect(getStateFromLevel(13.5)).toBe("yellow");
      expect(getStateFromLevel(16.99)).toBe("yellow");
    });

    test("returns 'red' when level is 17 or greater", () => {
      expect(getStateFromLevel(17)).toBe("red");
      expect(getStateFromLevel(25)).toBe("red");
      expect(getStateFromLevel(100)).toBe("red");
    });

    test("handles edge cases and invalid inputs gracefully", () => {
      expect(getStateFromLevel(null)).toBe("green");
      expect(getStateFromLevel(undefined)).toBe("green");
      expect(getStateFromLevel("invalid")).toBe("green");
      expect(getStateFromLevel(NaN)).toBe("green");
    });

    test("supports custom threshold values", () => {
      const customThresholds = { yellow: 15, red: 25 };
      expect(getStateFromLevel(5, customThresholds)).toBe("green");
      expect(getStateFromLevel(14.99, customThresholds)).toBe("green");
      expect(getStateFromLevel(15, customThresholds)).toBe("yellow");
      expect(getStateFromLevel(24.99, customThresholds)).toBe("yellow");
      expect(getStateFromLevel(25, customThresholds)).toBe("red");
      expect(getStateFromLevel(30, customThresholds)).toBe("red");
    });
  });

  describe("getQuietScore", () => {
    test("maps states to correct QuietScore descriptions", () => {
      expect(getQuietScore("green")).toBe("Quiet");
      expect(getQuietScore("yellow")).toBe("Warning");
      expect(getQuietScore("red")).toBe("Too Loud");
    });

    test("defaults to 'Quiet' for unrecognized state", () => {
      expect(getQuietScore("unknown")).toBe("Quiet");
      expect(getQuietScore("")).toBe("Quiet");
    });
  });

  describe("formatText", () => {
    test("converts snake_case to Title Case", () => {
      expect(formatText("needs_staff_attention")).toBe("Needs Staff Attention");
      expect(formatText("loud_talking")).toBe("Loud Talking");
      expect(formatText("in_review")).toBe("In Review");
      expect(formatText("resolved")).toBe("Resolved");
    });

    test("handles empty or invalid inputs", () => {
      expect(formatText("")).toBe("");
      expect(formatText(null)).toBe("");
      expect(formatText(undefined)).toBe("");
      expect(formatText(123)).toBe("");
    });
  });

  describe("buildSeverityBadge", () => {
    test("returns appropriate exclamation marks", () => {
      expect(buildSeverityBadge("low")).toBe("!");
      expect(buildSeverityBadge("LOW")).toBe("!");
      expect(buildSeverityBadge("medium")).toBe("!!");
      expect(buildSeverityBadge("Medium")).toBe("!!");
      expect(buildSeverityBadge("high")).toBe("!!!");
      expect(buildSeverityBadge("HIGH")).toBe("!!!");
    });

    test("returns dash or original text for invalid/empty inputs", () => {
      expect(buildSeverityBadge("")).toBe("—");
      expect(buildSeverityBadge(null)).toBe("—");
      expect(buildSeverityBadge(undefined)).toBe("—");
      expect(buildSeverityBadge("custom")).toBe("custom");
    });
  });

  describe("getPriorityLabel", () => {
    test("returns low priority for 0 or negative escalation", () => {
      expect(getPriorityLabel(0, "open")).toEqual({
        text: "—",
        className: "priority-low"
      });
      expect(getPriorityLabel(null, "open")).toEqual({
        text: "—",
        className: "priority-low"
      });
    });

    test("returns 'NEEDS ATTENTION' for open incidents with 3 or more escalations", () => {
      expect(getPriorityLabel(3, "open")).toEqual({
        text: "NEEDS ATTENTION",
        className: "priority-high"
      });
      expect(getPriorityLabel(4, "open")).toEqual({
        text: "NEEDS ATTENTION",
        className: "priority-high"
      });
    });

    test("returns '!!' with high priority for open incidents with 2 escalations", () => {
      expect(getPriorityLabel(2, "open")).toEqual({
        text: "!!",
        className: "priority-high"
      });
    });

    test("returns '!' with medium priority for open incidents with 1 escalation", () => {
      expect(getPriorityLabel(1, "open")).toEqual({
        text: "!",
        className: "priority-medium"
      });
    });

    test("retains exclamation marks for resolved incidents without alert banner", () => {
      expect(getPriorityLabel(3, "resolved")).toEqual({
        text: "!!!",
        className: "priority-high"
      });
      expect(getPriorityLabel(2, "resolved")).toEqual({
        text: "!!",
        className: "priority-high"
      });
      expect(getPriorityLabel(1, "resolved")).toEqual({
        text: "!",
        className: "priority-medium"
      });
    });
  });

  describe("formatTimerRemaining", () => {
    test("formats remaining minutes and seconds accurately", () => {
      const timerStart = "2026-10-22T01:00:00.000Z";
      const totalDuration = 2 * 60 * 1000; // 2 minutes

      // 30 seconds elapsed -> 1:30 remaining
      const now1 = new Date("2026-10-22T01:00:30.000Z").getTime();
      expect(formatTimerRemaining(timerStart, totalDuration, now1)).toBe(
        "1:30 remaining"
      );

      // 65 seconds elapsed -> 0:55 remaining
      const now2 = new Date("2026-10-22T01:01:05.000Z").getTime();
      expect(formatTimerRemaining(timerStart, totalDuration, now2)).toBe(
        "0:55 remaining"
      );
    });

    test("returns 'Completed' when time has fully elapsed", () => {
      const timerStart = "2026-10-22T01:00:00.000Z";
      const totalDuration = 2 * 60 * 1000;
      const now = new Date("2026-10-22T01:02:01.000Z").getTime();

      expect(formatTimerRemaining(timerStart, totalDuration, now)).toBe(
        "Completed"
      );
    });

    test("returns 'Completed' for null or invalid dates", () => {
      expect(formatTimerRemaining(null)).toBe("Completed");
      expect(formatTimerRemaining("invalid-date")).toBe("Completed");
    });
  });

  describe("validateThresholds", () => {
    test("passes for valid default thresholds", () => {
      const result = validateThresholds(10, 17);
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
    });

    test("passes for valid string numeric thresholds", () => {
      const result = validateThresholds("12", "20");
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
    });

    test("fails if red threshold is less than yellow threshold", () => {
      const result = validateThresholds(20, 15);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/strictly higher than yellow/i);
    });

    test("fails if red threshold equals yellow threshold", () => {
      const result = validateThresholds(15, 15);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/strictly higher than yellow/i);
    });

    test("fails if yellow threshold is less than 1", () => {
      expect(validateThresholds(0, 15).valid).toBe(false);
      expect(validateThresholds(0, 15).error).toMatch(/yellow threshold must be a valid number of at least 1/i);
      expect(validateThresholds(-5, 15).valid).toBe(false);
    });

    test("fails if red threshold is less than 1", () => {
      expect(validateThresholds(10, 0).valid).toBe(false);
      expect(validateThresholds(10, 0).error).toMatch(/red threshold must be a valid number of at least 1/i);
      expect(validateThresholds(10, -2).valid).toBe(false);
    });

    test("fails for invalid/missing threshold values", () => {
      expect(validateThresholds(null, 17).valid).toBe(false);
      expect(validateThresholds(undefined, 17).valid).toBe(false);
      expect(validateThresholds("", 17).valid).toBe(false);
      expect(validateThresholds("abc", 17).valid).toBe(false);
      expect(validateThresholds(10, null).valid).toBe(false);
      expect(validateThresholds(10, undefined).valid).toBe(false);
      expect(validateThresholds(10, "").valid).toBe(false);
      expect(validateThresholds(10, "xyz").valid).toBe(false);
    });
  });

  describe("isMoreSevere", () => {
    test("returns true when newState has higher severity than oldState", () => {
      expect(isMoreSevere("yellow", "green")).toBe(true);
      expect(isMoreSevere("red", "yellow")).toBe(true);
      expect(isMoreSevere("red", "green")).toBe(true);
    });

    test("returns false when newState has equal or lower severity", () => {
      expect(isMoreSevere("green", "green")).toBe(false);
      expect(isMoreSevere("yellow", "yellow")).toBe(false);
      expect(isMoreSevere("red", "red")).toBe(false);
      expect(isMoreSevere("green", "yellow")).toBe(false);
      expect(isMoreSevere("yellow", "red")).toBe(false);
      expect(isMoreSevere("green", "red")).toBe(false);
    });

    test("handles unknown states safely", () => {
      expect(isMoreSevere("unknown", "green")).toBe(false);
      expect(isMoreSevere("green", "unknown")).toBe(true);
    });
  });

  describe("shouldEscalateIncident", () => {
    test("escalates when timer has expired and latest detected state is red", () => {
      expect(shouldEscalateIncident({
        remainingMs: 0,
        latestDetectedState: "red",
        countdownFinished: false
      })).toBe(true);

      expect(shouldEscalateIncident({
        remainingMs: -500,
        latestDetectedState: "red",
        countdownFinished: false
      })).toBe(true);
    });

    test("does not escalate if timer still has time remaining", () => {
      expect(shouldEscalateIncident({
        remainingMs: 30000,
        latestDetectedState: "red",
        countdownFinished: false
      })).toBe(false);
    });

    test("does not escalate if room noise subsided to green or yellow", () => {
      expect(shouldEscalateIncident({
        remainingMs: 0,
        latestDetectedState: "green",
        countdownFinished: false
      })).toBe(false);

      expect(shouldEscalateIncident({
        remainingMs: 0,
        latestDetectedState: "yellow",
        countdownFinished: false
      })).toBe(false);
    });

    test("does not escalate if countdown was already marked finished", () => {
      expect(shouldEscalateIncident({
        remainingMs: 0,
        latestDetectedState: "red",
        countdownFinished: true
      })).toBe(false);
    });
  });
});
