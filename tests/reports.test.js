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

const { app } = require("../server");

describe("Noise Reports API (/api/reports)", () => {
  let consoleErrorSpy;

  beforeEach(() => {
    mockQuery.mockReset();
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("POST /api/reports", () => {
    test("returns 400 if room_id is missing", async () => {
      const res = await request(app)
        .post("/api/reports")
        .send({ noise_type: "talking", severity: "medium" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id, noise_type, and severity are required/i);
    });

    test("returns 400 if noise_type is missing", async () => {
      const res = await request(app)
        .post("/api/reports")
        .send({ room_id: 1, severity: "medium" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id, noise_type, and severity are required/i);
    });

    test("returns 400 if severity is missing", async () => {
      const res = await request(app)
        .post("/api/reports")
        .send({ room_id: 1, noise_type: "talking" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id, noise_type, and severity are required/i);
    });

    test("returns 400 if severity is invalid", async () => {
      const res = await request(app)
        .post("/api/reports")
        .send({ room_id: 1, noise_type: "talking", severity: "extreme" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid severity/i);
    });

    test("returns 500 when database insertion fails", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(new Error("Database write error"), null);
      });

      const res = await request(app)
        .post("/api/reports")
        .send({ room_id: 1, noise_type: "screaming", severity: "high", comments: "Very loud" });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error saving report/i);
    });

    test("returns 201 and report_id on successful submission", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        // Assert SQL parameters
        expect(params).toEqual([1, "loud_music", "high", "Bass shaking walls"]);
        callback(null, { insertId: 42, affectedRows: 1 });
      });

      const res = await request(app)
        .post("/api/reports")
        .send({
          room_id: 1,
          noise_type: "loud_music",
          severity: "high",
          comments: "Bass shaking walls"
        });

      expect(res.status).toBe(201);
      expect(res.body.message).toMatch(/report submitted successfully/i);
      expect(res.body.report_id).toBe(42);
    });

    test("defaults comments to null if omitted", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        expect(params[3]).toBeNull();
        callback(null, { insertId: 43, affectedRows: 1 });
      });

      const res = await request(app)
        .post("/api/reports")
        .send({
          room_id: 2,
          noise_type: "whispering",
          severity: "low"
        });

      expect(res.status).toBe(201);
      expect(res.body.report_id).toBe(43);
    });
  });

  describe("GET /api/reports", () => {
    test("returns 500 when database query fails", async () => {
      mockQuery.mockImplementation((sql, callback) => {
        callback(new Error("Database connection lost"), null);
      });

      const res = await request(app).get("/api/reports");

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error getting reports/i);
    });

    test("returns 200 with list of reports on success", async () => {
      const mockReports = [
        {
          id: 1,
          room_name: "Room 311",
          noise_type: "talking",
          severity: "medium",
          comments: "Group study",
          report_status: "open",
          submitted_at: "2026-10-22T01:00:00.000Z"
        }
      ];

      mockQuery.mockImplementation((sql, callback) => {
        callback(null, mockReports);
      });

      const res = await request(app).get("/api/reports");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].room_name).toBe("Room 311");
    });
  });

  describe("PUT /api/reports/:id/status", () => {
    test("returns 400 for invalid report status", async () => {
      const res = await request(app)
        .put("/api/reports/1/status")
        .send({ report_status: "invalid_status" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid report status/i);
    });

    test("returns 404 when target report ID does not exist", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(null, { affectedRows: 0 });
      });

      const res = await request(app)
        .put("/api/reports/999/status")
        .send({ report_status: "resolved" });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/report not found/i);
    });

    test("returns 500 when database update fails", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(new Error("DB error"), null);
      });

      const res = await request(app)
        .put("/api/reports/1/status")
        .send({ report_status: "in_review" });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error updating report status/i);
    });

    test("returns 200 and confirms update on success", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        expect(params).toEqual(["resolved", "1"]);
        callback(null, { affectedRows: 1 });
      });

      const res = await request(app)
        .put("/api/reports/1/status")
        .send({ report_status: "resolved" });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/report status updated/i);
      expect(res.body.changed).toBe(1);
    });
  });
});
