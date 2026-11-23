const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const QuietSpaceStore = require("../webpages/demo-store.js");

describe("QuietSpaceStore Client-Side Demo Layer", () => {
  beforeEach(() => {
    const store = {};
    global.localStorage = {
      getItem: (key) => store[key] || null,
      setItem: (key, value) => {
        store[key] = String(value);
      },
      removeItem: (key) => {
        delete store[key];
      },
      clear: () => {
        Object.keys(store).forEach((k) => delete store[k]);
      }
    };
    global.window = {
      location: {
        hostname: "kanyliar.github.io",
        protocol: "https:",
        port: ""
      },
      dispatchEvent: () => {},
      CustomEvent: class CustomEvent {
        constructor(name, detail) {
          this.name = name;
          this.detail = detail;
        }
      }
    };
  });

  afterEach(() => {
    delete global.localStorage;
    delete global.window;
  });

  it("isGitHubPages returns true for kanyliar.github.io", () => {
    assert.equal(QuietSpaceStore.isGitHubPages(), true);
  });

  it("isGitHubPages returns false for localhost", () => {
    global.window.location.hostname = "localhost";
    global.window.location.protocol = "http:";
    assert.equal(QuietSpaceStore.isGitHubPages(), false);
  });

  it("getApiBase returns null on GitHub Pages when no custom API is configured", () => {
    assert.equal(QuietSpaceStore.getApiBase(), null);
  });

  it("getApiBase returns custom API URL when configured", () => {
    QuietSpaceStore.setCustomApiUrl("https://my-backend.onrender.com/");
    assert.equal(QuietSpaceStore.getApiBase(), "https://my-backend.onrender.com");
  });

  it("getRooms returns seeded demo rooms on GitHub Pages", async () => {
    const result = await QuietSpaceStore.getRooms();
    assert.equal(result.source, "demo");
    assert.ok(result.rooms.length >= 3);
    assert.ok(result.rooms.some((r) => r.room_name === "Room 311"));
  });

  it("addRoom creates a new room in demo storage", async () => {
    const result = await QuietSpaceStore.addRoom("Room 314", "Bluford Library 3rd Floor");
    assert.equal(result.success, true);
    assert.equal(result.room.room_name, "Room 314");
    assert.equal(result.source, "demo");

    const roomsRes = await QuietSpaceStore.getRooms();
    assert.ok(roomsRes.rooms.some((r) => r.room_name === "Room 314"));
  });

  it("updateRoom updates room name and location in demo storage", async () => {
    const updateRes = await QuietSpaceStore.updateRoom(1, {
      room_name: "Quiet Pod 311",
      location: "West Wing"
    });
    assert.equal(updateRes.success, true);
    assert.equal(updateRes.room.room_name, "Quiet Pod 311");
    assert.equal(updateRes.room.location, "West Wing");

    const roomsRes = await QuietSpaceStore.getRooms();
    const updated = roomsRes.rooms.find((r) => r.id === 1);
    assert.equal(updated.room_name, "Quiet Pod 311");
  });

  it("toggleRoomStatus toggles is_active state in demo storage", async () => {
    const toggleRes = await QuietSpaceStore.toggleRoomStatus(1);
    assert.equal(toggleRes.success, true);
    assert.equal(toggleRes.room.is_active, 0);

    const toggleBack = await QuietSpaceStore.toggleRoomStatus(1);
    assert.equal(toggleBack.room.is_active, 1);
  });

  it("getReports returns seed reports and addReport prepends new report", async () => {
    const initial = await QuietSpaceStore.getReports();
    assert.equal(initial.reports.length, 3);

    const added = await QuietSpaceStore.addReport({
      room_id: 1,
      noise_type: "loud_music",
      severity: "high",
      comments: "Speaker placed on desk"
    });
    assert.equal(added.success, true);
    assert.equal(added.report.noise_type, "loud_music");

    const updated = await QuietSpaceStore.getReports();
    assert.equal(updated.reports.length, 4);
    assert.equal(updated.reports[0].noise_type, "loud_music");
  });

  it("updateReportStatus updates student report status in demo storage", async () => {
    const updateRes = await QuietSpaceStore.updateReportStatus(1, "resolved");
    assert.equal(updateRes.success, true);

    const reportsRes = await QuietSpaceStore.getReports();
    const target = reportsRes.reports.find((r) => r.id === 1);
    assert.equal(target.report_status, "resolved");
  });

  it("getIncidents returns demo incidents with timers and escalation counts", async () => {
    const res = await QuietSpaceStore.getIncidents();
    assert.ok(res.incidents.length >= 2);
    assert.ok(res.incidents.some((i) => i.room_name === "Room 313"));
  });

  it("formatCsv correctly formats rows and quotes special characters", () => {
    const headers = ["ID", "Room", "Notes"];
    const rows = [
      [1, "Room 311", "Normal noise"],
      [2, "Room 312", 'Loud "laughter", yelling\nnext room']
    ];
    const csv = QuietSpaceStore.formatCsv(headers, rows);
    assert.ok(csv.includes("ID,Room,Notes"));
    assert.ok(csv.includes("1,Room 311,Normal noise"));
    assert.ok(csv.includes('2,Room 312,"Loud ""laughter"", yelling\nnext room"'));
  });

  it("exportCsv generates incidents CSV in demo mode", async () => {
    const result = await QuietSpaceStore.exportCsv("incidents", { month: "2026-11" });
    assert.equal(result.source, "demo");
    assert.ok(result.filename.includes("quietspace-incidents-2026-11.csv"));
    assert.ok(result.csv.includes("Incident ID,Room Name,Status,Escalation Count,Trigger Level,Started At,Resolved At,Duration (Seconds)"));
  });

  it("exportCsv generates reports CSV in demo mode", async () => {
    const result = await QuietSpaceStore.exportCsv("reports");
    assert.equal(result.source, "demo");
    assert.ok(result.filename.includes("quietspace-reports-"));
    assert.ok(result.csv.includes("Report ID,Room Name,Noise Type,Severity,Comments,Report Status,Submitted At"));
  });

  it("exportCsv generates hourly trends CSV in demo mode", async () => {
    const result = await QuietSpaceStore.exportCsv("hourly", { date: "2026-11-15" });
    assert.equal(result.source, "demo");
    assert.ok(result.filename.includes("quietspace-hourly-2026-11-15.csv"));
    assert.ok(result.csv.includes("Hour,Hour Label,Average Noise Level (dB),Max Noise Level (dB),Min Noise Level (dB),Reading Count,Incident Spikes"));
  });
});
