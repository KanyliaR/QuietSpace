const request = require("supertest");

// Mock mysql2 before requiring server
const mockQuery = jest.fn();
const mockConnect = jest.fn((cb) => {
  if (cb) cb(null);
});
const mockGetConnection = jest.fn((cb) => {
  if (cb) cb(null, { release: jest.fn() });
});

jest.mock("mysql2", () => ({
  createPool: jest.fn(() => ({
    getConnection: mockGetConnection,
    query: mockQuery,
    end: jest.fn()
  })),
  createConnection: jest.fn(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: jest.fn()
  }))
}));

const { app, escapeCsvField, buildCsvString } = require("../server");

describe("CSV Export Helpers & API (/api/reports/export/csv & /api/analytics/export/csv)", () => {
  let consoleErrorSpy;

  beforeEach(() => {
    mockQuery.mockReset();
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("CSV Formatting Helpers", () => {
    test("escapeCsvField handles null, undefined, and plain values", () => {
      expect(escapeCsvField(null)).toBe("");
      expect(escapeCsvField(undefined)).toBe("");
      expect(escapeCsvField(42)).toBe("42");
      expect(escapeCsvField("Room 311")).toBe("Room 311");
    });

    test("escapeCsvField quotes and escapes strings with commas, quotes, and newlines", () => {
      expect(escapeCsvField('Hello, "Quiet" World')).toBe('"Hello, ""Quiet"" World"');
      expect(escapeCsvField("Line 1\nLine 2")).toBe('"Line 1\nLine 2"');
      expect(escapeCsvField("Item A, Item B")).toBe('"Item A, Item B"');
    });

    test("buildCsvString joins headers and rows with CRLF", () => {
      const headers = ["ID", "Name", "Comments"];
      const rows = [
        [1, "Room 311", 'Loud "talking", and music'],
        [2, "Room 312", "Quiet study"]
      ];
      const csv = buildCsvString(headers, rows);
      expect(csv).toContain("ID,Name,Comments");
      expect(csv).toContain('1,Room 311,"Loud ""talking"", and music"');
      expect(csv).toContain("2,Room 312,Quiet study");
    });
  });

  describe("GET /api/reports/export/csv (Incidents Export)", () => {
    test("exports incidents CSV with default type and proper headers", async () => {
      const mockIncidents = [
        {
          id: 101,
          room_name: "Room 311",
          status: "resolved",
          escalation_count: 2,
          trigger_level: "red",
          started_at: "2026-11-15T14:00:00.000Z",
          resolved_at: "2026-11-15T14:05:00.000Z",
          duration_seconds: 300
        }
      ];

      mockQuery.mockImplementationOnce((sql, params, callback) => {
        expect(sql).toContain("FROM incidents");
        callback(null, mockIncidents);
      });

      const res = await request(app).get("/api/reports/export/csv");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.headers["content-disposition"]).toMatch(/attachment; filename="quietspace-incidents/);
      expect(res.text).toContain("Incident ID,Room Name,Status,Escalation Count,Trigger Level,Started At,Resolved At,Duration (Seconds)");
      expect(res.text).toContain("101,Room 311,resolved,2,red,2026-11-15T14:00:00.000Z,2026-11-15T14:05:00.000Z,300");
    });

    test("applies month and room_id filters for incidents", async () => {
      mockQuery.mockImplementationOnce((sql, params, callback) => {
        expect(sql).toContain("AND DATE_FORMAT(incidents.started_at, '%Y-%m') = ?");
        expect(sql).toContain("AND incidents.room_id = ?");
        expect(params).toEqual(["2", "2026-11"]);
        callback(null, []);
      });

      const res = await request(app).get("/api/reports/export/csv?month=2026-11&room_id=2");
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain("quietspace-incidents-2026-11.csv");
    });

    test("returns 500 when database query fails for incidents", async () => {
      mockQuery.mockImplementationOnce((sql, params, callback) => {
        callback(new Error("Database connection lost"), null);
      });

      const res = await request(app).get("/api/reports/export/csv");
      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error exporting csv report/i);
    });
  });

  describe("GET /api/reports/export/csv?type=reports (Noise Reports Export)", () => {
    test("exports student noise reports CSV with proper escaping", async () => {
      const mockReports = [
        {
          id: 50,
          room_name: "Room 312",
          noise_type: "Loud Talking",
          severity: "high",
          comments: 'Group discussion with "speakerphone", very noisy',
          report_status: "in_review",
          submitted_at: "2026-11-15T15:30:00.000Z"
        }
      ];

      mockQuery.mockImplementationOnce((sql, params, callback) => {
        expect(sql).toContain("FROM noise_reports");
        callback(null, mockReports);
      });

      const res = await request(app).get("/api/reports/export/csv?type=reports&month=2026-11");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.headers["content-disposition"]).toContain("quietspace-reports-2026-11.csv");
      expect(res.text).toContain("Report ID,Room Name,Noise Type,Severity,Comments,Report Status,Submitted At");
      expect(res.text).toContain('50,Room 312,Loud Talking,high,"Group discussion with ""speakerphone"", very noisy",in_review,2026-11-15T15:30:00.000Z');
    });

    test("returns 500 if database query fails for noise reports", async () => {
      mockQuery.mockImplementationOnce((sql, params, callback) => {
        callback(new Error("Failed query"), null);
      });

      const res = await request(app).get("/api/reports/export/csv?type=reports");
      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error exporting csv report/i);
    });
  });

  describe("GET /api/reports/export/csv?type=hourly (Hourly Trends Export)", () => {
    test("exports 24 hourly buckets with noise levels and incident spikes", async () => {
      const mockReadings = [
        { hour: 14, avg_noise_level: "68.50", max_noise_level: "78.20", min_noise_level: "52.00", reading_count: 100 }
      ];
      const mockIncidents = [
        { hour: 14, incident_spikes: 3 }
      ];

      mockQuery
        .mockImplementationOnce((sql, params, callback) => {
          callback(null, mockReadings);
        })
        .mockImplementationOnce((sql, params, callback) => {
          callback(null, mockIncidents);
        });

      const res = await request(app).get("/api/reports/export/csv?type=hourly&date=2026-11-15");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.headers["content-disposition"]).toContain("quietspace-hourly-trends-2026-11-15.csv");
      expect(res.text).toContain("Hour,Hour Label,Average Noise Level (dB),Max Noise Level (dB),Min Noise Level (dB),Reading Count,Incident Spikes");
      expect(res.text).toContain("14,2 PM,68.5,78.2,52,100,3");
      expect(res.text).toContain("0,12 AM,0,0,0,0,0");
    });
  });

  describe("GET /api/analytics/export/csv (Alias Endpoint)", () => {
    test("works identically under /api/analytics/export/csv", async () => {
      mockQuery.mockImplementationOnce((sql, params, callback) => {
        callback(null, []);
      });

      const res = await request(app).get("/api/analytics/export/csv?type=incidents");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
    });
  });
});
