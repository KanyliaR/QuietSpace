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

describe("Rooms API (/api/rooms)", () => {
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

  describe("GET /api/rooms", () => {
    test("returns 500 when database query fails", async () => {
      mockQuery.mockImplementation((sql, callback) => {
        callback(new Error("Database connection lost"), null);
      });

      const res = await request(app).get("/api/rooms");

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error getting rooms/i);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    test("returns 200 with list of rooms including is_active status", async () => {
      const mockRooms = [
        {
          id: 1,
          room_id: 1,
          room_name: "Room 311",
          location: "Bluford Library 3rd Floor",
          is_active: 1,
          level: "9.50",
          status_color: "green",
          quiet_score: "Quiet",
          recorded_at: "2026-10-24T20:00:00.000Z"
        },
        {
          id: 2,
          room_id: 2,
          room_name: "Room 312",
          location: "Bluford Library 3rd Floor",
          is_active: 0,
          level: null,
          status_color: null,
          quiet_score: null,
          recorded_at: null
        }
      ];

      mockQuery.mockImplementation((sql, callback) => {
        callback(null, mockRooms);
      });

      const res = await request(app).get("/api/rooms");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].room_name).toBe("Room 311");
      expect(res.body[0].is_active).toBe(1);
      expect(res.body[1].room_name).toBe("Room 312");
      expect(res.body[1].is_active).toBe(0);
    });
  });

  describe("GET /api/rooms/:id", () => {
    test("returns 404 when room does not exist", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(null, []);
      });

      const res = await request(app).get("/api/rooms/999");

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/room not found/i);
    });

    test("returns 200 with room details when found", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        expect(params).toEqual(["1"]);
        callback(null, [{
          id: 1,
          room_name: "Room 311",
          location: "Bluford Library 3rd Floor",
          is_active: 1
        }]);
      });

      const res = await request(app).get("/api/rooms/1");

      expect(res.status).toBe(200);
      expect(res.body.room_name).toBe("Room 311");
      expect(res.body.is_active).toBe(1);
    });

    test("returns 500 when database query fails", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(new Error("DB failure"), null);
      });

      const res = await request(app).get("/api/rooms/1");

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error getting room/i);
    });
  });

  describe("POST /api/rooms", () => {
    test("returns 400 if room_name is missing or empty", async () => {
      const res1 = await request(app).post("/api/rooms").send({});
      expect(res1.status).toBe(400);
      expect(res1.body.message).toMatch(/room_name is required/i);

      const res2 = await request(app).post("/api/rooms").send({ room_name: "   " });
      expect(res2.status).toBe(400);
      expect(res2.body.message).toMatch(/room_name is required/i);
    });

    test("returns 409 if room with same name already exists", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        const err = new Error("Duplicate entry");
        err.code = "ER_DUP_ENTRY";
        callback(err, null);
      });

      const res = await request(app)
        .post("/api/rooms")
        .send({ room_name: "Room 311" });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already exists/i);
    });

    test("returns 500 on database insertion error", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(new Error("Insert error"), null);
      });

      const res = await request(app)
        .post("/api/rooms")
        .send({ room_name: "Room 314" });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error creating room/i);
    });

    test("returns 201, creates room, and broadcasts SSE event", async () => {
      const mockClient = { write: jest.fn() };
      sseClients.add(mockClient);

      mockQuery.mockImplementation((sql, params, callback) => {
        expect(params).toEqual(["Room 314", "Bluford Library 3rd Floor", 1]);
        callback(null, { insertId: 4, affectedRows: 1 });
      });

      const res = await request(app)
        .post("/api/rooms")
        .send({
          room_name: "Room 314",
          location: "Bluford Library 3rd Floor"
        });

      expect(res.status).toBe(201);
      expect(res.body.message).toMatch(/room created successfully/i);
      expect(res.body.room.id).toBe(4);
      expect(res.body.room.room_name).toBe("Room 314");
      expect(res.body.room.is_active).toBe(1);

      expect(mockClient.write).toHaveBeenCalledTimes(1);
      const ssePayload = mockClient.write.mock.calls[0][0];
      expect(ssePayload).toContain("event: room_created");
      expect(ssePayload).toContain('"room_name":"Room 314"');
    });
  });

  describe("PUT /api/rooms/:id", () => {
    test("returns 400 if no update fields are provided", async () => {
      const res = await request(app).put("/api/rooms/1").send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/at least one field/i);
    });

    test("returns 400 if room_name is provided as empty string", async () => {
      const res = await request(app).put("/api/rooms/1").send({ room_name: "  " });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/cannot be empty/i);
    });

    test("returns 404 when target room does not exist", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(null, { affectedRows: 0 });
      });

      const res = await request(app)
        .put("/api/rooms/999")
        .send({ room_name: "Room Renamed" });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/room not found/i);
    });

    test("returns 409 if renamed room creates duplicate name", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        const err = new Error("Duplicate entry");
        err.code = "ER_DUP_ENTRY";
        callback(err, null);
      });

      const res = await request(app)
        .put("/api/rooms/2")
        .send({ room_name: "Room 311" });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already exists/i);
    });

    test("returns 200, updates room, and broadcasts SSE event", async () => {
      const mockClient = { write: jest.fn() };
      sseClients.add(mockClient);

      mockQuery.mockImplementation((sql, values, callback) => {
        expect(sql).toContain("room_name = ?");
        expect(sql).toContain("location = ?");
        expect(values).toEqual(["Collaboration Room A", "2nd Floor", "1"]);
        callback(null, { affectedRows: 1 });
      });

      const res = await request(app)
        .put("/api/rooms/1")
        .send({
          room_name: "Collaboration Room A",
          location: "2nd Floor"
        });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/room updated successfully/i);
      expect(res.body.room.room_name).toBe("Collaboration Room A");

      expect(mockClient.write).toHaveBeenCalledTimes(1);
      const ssePayload = mockClient.write.mock.calls[0][0];
      expect(ssePayload).toContain("event: room_updated");
      expect(ssePayload).toContain('"room_name":"Collaboration Room A"');
    });
  });

  describe("PATCH & PUT /api/rooms/:id/toggle", () => {
    test("returns 404 when toggling non-existent room", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(null, { affectedRows: 0 });
      });

      const res = await request(app).patch("/api/rooms/999/toggle");

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/room not found/i);
    });

    test("returns 500 when toggle update fails", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(new Error("Update failure"), null);
      });

      const res = await request(app).patch("/api/rooms/1/toggle");

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/error toggling room status/i);
    });

    test("toggles active to inactive and broadcasts SSE", async () => {
      const mockClient = { write: jest.fn() };
      sseClients.add(mockClient);

      mockQuery
        .mockImplementationOnce((sql, params, callback) => {
          expect(sql).toContain("UPDATE rooms");
          expect(params).toEqual(["1"]);
          callback(null, { affectedRows: 1 });
        })
        .mockImplementationOnce((sql, params, callback) => {
          expect(sql).toContain("SELECT");
          expect(params).toEqual(["1"]);
          callback(null, [{ id: 1, room_name: "Room 311", location: "3rd Floor", is_active: 0 }]);
        });

      const res = await request(app).patch("/api/rooms/1/toggle");

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/room status toggled to inactive/i);
      expect(res.body.room.is_active).toBe(0);

      expect(mockClient.write).toHaveBeenCalledTimes(1);
      const ssePayload = mockClient.write.mock.calls[0][0];
      expect(ssePayload).toContain("event: room_updated");
      expect(ssePayload).toContain('"is_active":0');
    });

    test("PUT /api/rooms/:id/toggle also works identically", async () => {
      mockQuery
        .mockImplementationOnce((sql, params, callback) => {
          callback(null, { affectedRows: 1 });
        })
        .mockImplementationOnce((sql, params, callback) => {
          callback(null, [{ id: 2, room_name: "Room 312", location: "3rd Floor", is_active: 1 }]);
        });

      const res = await request(app).put("/api/rooms/2/toggle");

      expect(res.status).toBe(200);
      expect(res.body.room.is_active).toBe(1);
    });
  });
});
