const request = require("supertest");

// Mock mysql2 before requiring server
const mockQuery = jest.fn();
const mockConnect = jest.fn((cb) => {
  if (cb) cb(null);
});

jest.mock("mysql2", () => ({
  createConnection: jest.fn(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: jest.fn()
  }))
}));

const { app } = require("../server");

describe("Sound Readings API (/api/readings)", () => {
  let consoleErrorSpy;

  beforeEach(() => {
    mockQuery.mockReset();
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("POST /api/readings", () => {
    test("returns 400 if room_id is missing", async () => {
      const res = await request(app)
        .post("/api/readings")
        .send({
          level: 12.5,
          quiet_score: "Warning",
          status_color: "yellow"
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id, level, quiet_score, and status_color are required/i);
    });

    test("returns 400 if level is missing", async () => {
      const res = await request(app)
        .post("/api/readings")
        .send({
          room_id: 1,
          quiet_score: "Warning",
          status_color: "yellow"
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id, level, quiet_score, and status_color are required/i);
    });

    test("returns 400 if quiet_score is missing", async () => {
      const res = await request(app)
        .post("/api/readings")
        .send({
          room_id: 1,
          level: 12.5,
          status_color: "yellow"
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id, level, quiet_score, and status_color are required/i);
    });

    test("returns 400 if status_color is missing", async () => {
      const res = await request(app)
        .post("/api/readings")
        .send({
          room_id: 1,
          level: 12.5,
          quiet_score: "Warning"
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id, level, quiet_score, and status_color are required/i);
    });

    test("returns 400 if status_color is invalid", async () => {
      const res = await request(app)
        .post("/api/readings")
        .send({
          room_id: 1,
          level: 12.5,
          quiet_score: "Warning",
          status_color: "purple"
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid status color/i);
    });

    test("returns 500 when database insertion fails", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(new Error("Disk full"), null);
      });

      const res = await request(app)
        .post("/api/readings")
        .send({
          room_id: 1,
          level: 8.2,
          quiet_score: "Quiet",
          status_color: "green"
        });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error saving reading/i);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    test("returns 201 with reading_id on success", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        expect(params).toEqual([1, 8.2, "Quiet", "green"]);
        callback(null, { insertId: 101, affectedRows: 1 });
      });

      const res = await request(app)
        .post("/api/readings")
        .send({
          room_id: 1,
          level: 8.2,
          quiet_score: "Quiet",
          status_color: "green"
        });

      expect(res.status).toBe(201);
      expect(res.body.message).toMatch(/reading saved successfully/i);
      expect(res.body.reading_id).toBe(101);
    });
  });

  describe("GET /api/readings/latest", () => {
    test("returns 500 when database query fails", async () => {
      mockQuery.mockImplementation((sql, callback) => {
        callback(new Error("Connection timeout"), null);
      });

      const res = await request(app).get("/api/readings/latest");

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error getting latest readings/i);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    test("returns 200 with room readings on success", async () => {
      const mockReadings = [
        {
          room_id: 1,
          room_name: "Room 311",
          level: "9.50",
          status_color: "green",
          quiet_score: "Quiet",
          recorded_at: "2026-10-22T01:15:00.000Z"
        },
        {
          room_id: 2,
          room_name: "Room 312",
          level: null,
          status_color: null,
          quiet_score: null,
          recorded_at: null
        }
      ];

      mockQuery.mockImplementation((sql, callback) => {
        callback(null, mockReadings);
      });

      const res = await request(app).get("/api/readings/latest");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].room_id).toBe(1);
      expect(res.body[0].level).toBe("9.50");
    });
  });
});
