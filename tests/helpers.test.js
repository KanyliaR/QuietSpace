const {
  getStateFromLevel,
  getQuietScore,
  formatText,
  buildSeverityBadge,
  getPriorityLabel,
  formatTimerRemaining
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
});
