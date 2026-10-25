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

const { app, sseClients } = require("../server");

describe("Incidents API (/api/incidents)", () => {
  let consoleErrorSpy;

  beforeEach(() => {
    mockQuery.mockReset();
    jest.clearAllMocks();
    if (sseClients) sseClients.clear();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("GET /api/incidents", () => {
    test("returns 500 when database query fails", async () => {
      mockQuery.mockImplementation((sql, callback) => {
        callback(new Error("Database error"), null);
      });

      const res = await request(app).get("/api/incidents");

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error getting incidents/i);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    test("formats timer_remaining correctly for active and resolved incidents", async () => {
      const now = Date.now();
      const mockIncidents = [
        {
          id: 1,
          room_name: "Room 311",
          status: "open",
          escalation_count: 1,
          started_at: new Date(now - 30000).toISOString(),
          resolved_at: null,
          timer_started_at: new Date(now - 30000).toISOString() // 30 sec elapsed -> ~1:30 remaining
        },
        {
          id: 2,
          room_name: "Room 312",
          status: "resolved",
          escalation_count: 2,
          started_at: new Date(now - 120000).toISOString(),
          resolved_at: new Date(now - 60000).toISOString(),
          timer_started_at: new Date(now - 120000).toISOString()
        },
        {
          id: 3,
          room_name: "Room 313",
          status: "open",
          escalation_count: 3,
          started_at: new Date(now - 150000).toISOString(),
          resolved_at: null,
          timer_started_at: new Date(now - 150000).toISOString() // > 2 min elapsed -> 0:00 remaining
        }
      ];

      mockQuery.mockImplementation((sql, callback) => {
        callback(null, mockIncidents);
      });

      const res = await request(app).get("/api/incidents");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(3);

      // Incident 1: open with ~90 seconds left
      expect(res.body[0].timer_remaining).toMatch(/1:\d{2} remaining/);

      // Incident 2: resolved -> "Completed"
      expect(res.body[1].timer_remaining).toBe("Completed");

      // Incident 3: expired open -> "0:00 remaining"
      expect(res.body[2].timer_remaining).toBe("0:00 remaining");
    });
  });

  describe("POST /api/incidents/start", () => {
    test("returns 400 if room_id is missing", async () => {
      const res = await request(app)
        .post("/api/incidents/start")
        .send({ trigger_level: "red" });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id and trigger_level are required/i);
    });

    test("returns 400 if trigger_level is missing", async () => {
      const res = await request(app)
        .post("/api/incidents/start")
        .send({ room_id: 1 });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id and trigger_level are required/i);
    });

    test("returns 500 when check existing query fails", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(new Error("Check error"), null);
      });

      const res = await request(app)
        .post("/api/incidents/start")
        .send({ room_id: 1, trigger_level: "red" });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error checking incident/i);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    test("returns 200 with existing incident_id if incident is already open", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        // Return existing open incident
        callback(null, [{ id: 55 }]);
      });

      const res = await request(app)
        .post("/api/incidents/start")
        .send({ room_id: 1, trigger_level: "red" });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/incident already open/i);
      expect(res.body.incident_id).toBe(55);
    });

    test("returns 500 when incident insert query fails", async () => {
      mockQuery
        .mockImplementationOnce((sql, params, callback) => {
          // No existing incident
          callback(null, []);
        })
        .mockImplementationOnce((sql, params, callback) => {
          callback(new Error("Insert error"), null);
        });

      const res = await request(app)
        .post("/api/incidents/start")
        .send({ room_id: 1, trigger_level: "red" });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error starting incident/i);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    test("returns 201 with new incident_id on successful creation and broadcasts SSE", async () => {
      const mockClient = { write: jest.fn() };
      sseClients.add(mockClient);

      mockQuery
        .mockImplementationOnce((sql, params, callback) => {
          callback(null, []);
        })
        .mockImplementationOnce((sql, params, callback) => {
          expect(params).toEqual([1, "red"]);
          callback(null, { insertId: 77, affectedRows: 1 });
        });

      const res = await request(app)
        .post("/api/incidents/start")
        .send({ room_id: 1, trigger_level: "red" });

      expect(res.status).toBe(201);
      expect(res.body.message).toMatch(/incident started/i);
      expect(res.body.incident_id).toBe(77);

      expect(mockClient.write).toHaveBeenCalledTimes(1);
      const payload = mockClient.write.mock.calls[0][0];
      expect(payload).toContain("event: incident_started");
      expect(payload).toContain('"incident_id":77');
      expect(payload).toContain('"room_id":1');
      expect(payload).toContain('"status":"open"');
      expect(payload).toContain('"escalation_count":1');
    });

    test("does not broadcast new incident_started when incident is already open", async () => {
      const mockClient = { write: jest.fn() };
      sseClients.add(mockClient);

      mockQuery.mockImplementation((sql, params, callback) => {
        callback(null, [{ id: 55 }]);
      });

      const res = await request(app)
        .post("/api/incidents/start")
        .send({ room_id: 1, trigger_level: "red" });

      expect(res.status).toBe(200);
      expect(res.body.incident_id).toBe(55);
      expect(mockClient.write).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/incidents/resolve", () => {
    test("returns 400 if room_id is missing", async () => {
      const res = await request(app).post("/api/incidents/resolve").send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id is required/i);
    });

    test("returns 500 if database error occurs", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(new Error("Update failed"), null);
      });

      const res = await request(app)
        .post("/api/incidents/resolve")
        .send({ room_id: 1 });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error resolving incident/i);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    test("returns 200 with changed rows count on success and broadcasts SSE", async () => {
      const mockClient = { write: jest.fn() };
      sseClients.add(mockClient);

      mockQuery.mockImplementation((sql, params, callback) => {
        expect(params).toEqual([1]);
        callback(null, { affectedRows: 1 });
      });

      const res = await request(app)
        .post("/api/incidents/resolve")
        .send({ room_id: 1 });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/incident resolved/i);
      expect(res.body.changed).toBe(1);

      expect(mockClient.write).toHaveBeenCalledTimes(1);
      const payload = mockClient.write.mock.calls[0][0];
      expect(payload).toContain("event: incident_resolved");
      expect(payload).toContain('"room_id":1');
    });
  });

  describe("POST /api/incidents/escalate", () => {
    test("returns 400 if room_id is missing", async () => {
      const res = await request(app).post("/api/incidents/escalate").send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id is required/i);
    });

    test("returns 500 if database error occurs", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(new Error("Escalation failed"), null);
      });

      const res = await request(app)
        .post("/api/incidents/escalate")
        .send({ room_id: 1 });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error escalating incident/i);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    test("returns 200 with changed rows count and broadcasts SSE on success", async () => {
      const mockClient = { write: jest.fn() };
      sseClients.add(mockClient);

      mockQuery.mockImplementation((sql, params, callback) => {
        expect(sql).toContain("escalation_count =");
        expect(sql).toContain("timer_started_at =");
        expect(params).toEqual([1]);
        callback(null, { affectedRows: 1 });
      });

      const res = await request(app)
        .post("/api/incidents/escalate")
        .send({ room_id: 1 });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/incident escalated/i);
      expect(res.body.changed).toBe(1);

      expect(mockClient.write).toHaveBeenCalledTimes(1);
      const payload = mockClient.write.mock.calls[0][0];
      expect(payload).toContain("event: incident_escalated");
      expect(payload).toContain('"room_id":1');
    });

    test("returns 200 with changed: 0 when no open incident exists for the room", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(null, { affectedRows: 0 });
      });

      const res = await request(app)
        .post("/api/incidents/escalate")
        .send({ room_id: 999 });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/incident escalated/i);
      expect(res.body.changed).toBe(0);
    });

    test("handles multiple sequential escalations", async () => {
      let callCount = 0;
      mockQuery.mockImplementation((sql, params, callback) => {
        callCount++;
        callback(null, { affectedRows: 1 });
      });

      const res1 = await request(app).post("/api/incidents/escalate").send({ room_id: 1 });
      expect(res1.status).toBe(200);

      const res2 = await request(app).post("/api/incidents/escalate").send({ room_id: 1 });
      expect(res2.status).toBe(200);

      expect(callCount).toBe(2);
    });
  });
});
