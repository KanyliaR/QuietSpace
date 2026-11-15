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

const {
  app,
  sseClients,
  sensorRegistry,
  updateSensorReading,
  checkHardwareWatchdog,
  resetSensorRegistry
} = require("../server");

describe("Hardware Sensor Telemetry & Watchdog API (/api/hardware)", () => {
  let consoleErrorSpy;

  beforeEach(() => {
    mockQuery.mockReset();
    jest.clearAllMocks();
    resetSensorRegistry();
    if (sseClients) sseClients.clear();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("GET /api/hardware/status", () => {
    test("returns empty sensor list when no sensors are active", async () => {
      const res = await request(app).get("/api/hardware/status");

      expect(res.status).toBe(200);
      expect(res.body.sensors).toEqual([]);
      expect(res.body.total_sensors).toBe(0);
      expect(res.body.online_count).toBe(0);
      expect(res.body.offline_count).toBe(0);
      expect(res.body.fault_count).toBe(0);
      expect(res.body.timestamp).toBeDefined();
    });

    test("returns active sensors with accurate counts", async () => {
      updateSensorReading(1, 45.0);
      updateSensorReading(2, 52.0);

      const res = await request(app).get("/api/hardware/status");

      expect(res.status).toBe(200);
      expect(res.body.total_sensors).toBe(2);
      expect(res.body.online_count).toBe(2);
      expect(res.body.offline_count).toBe(0);
      expect(res.body.sensors).toHaveLength(2);
      expect(res.body.sensors.find((s) => s.room_id === 1).last_level).toBe(45.0);
    });
  });

  describe("POST /api/hardware/heartbeat", () => {
    test("returns 400 when room_id is missing", async () => {
      const res = await request(app)
        .post("/api/hardware/heartbeat")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/room_id is required/i);
    });

    test("registers sensor and marks online on valid heartbeat", async () => {
      const res = await request(app)
        .post("/api/hardware/heartbeat")
        .send({ room_id: 311, status: "ok" });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/heartbeat acknowledged/i);
      expect(res.body.sensor.room_id).toBe(311);
      expect(res.body.sensor.status).toBe("online");
    });

    test("handles explicit disconnected status heartbeat", async () => {
      const res = await request(app)
        .post("/api/hardware/heartbeat")
        .send({ room_id: 312, status: "disconnected" });

      expect(res.status).toBe(200);
      expect(res.body.sensor.status).toBe("offline");
      expect(res.body.sensor.fault_reason).toMatch(/sensor reported disconnected/i);
    });
  });

  describe("Reading Ingestion Integration", () => {
    test("POST /api/readings updates sensor registry to online", async () => {
      mockQuery.mockImplementation((sql, values, callback) => {
        callback(null, { insertId: 88 });
      });

      const res = await request(app)
        .post("/api/readings")
        .send({
          room_id: 1,
          level: 42.5,
          quiet_score: "Quiet",
          status_color: "green"
        });

      expect(res.status).toBe(201);
      const sensor = sensorRegistry.get(1);
      expect(sensor).toBeDefined();
      expect(sensor.status).toBe("online");
      expect(sensor.last_level).toBe(42.5);
      expect(sensor.total_readings).toBe(1);
    });
  });

  describe("Watchdog Liveness Check", () => {
    test("flags sensor as offline when last_recorded_at exceeds 30 seconds", async () => {
      const mockClient = { write: jest.fn() };
      sseClients.add(mockClient);

      // Seed sensor reading from 45 seconds ago
      const pastTime = new Date(Date.now() - 45000);
      updateSensorReading(1, 40.0, pastTime);

      const events = checkHardwareWatchdog(Date.now(), 30000);

      expect(events).toHaveLength(1);
      expect(events[0].room_id).toBe(1);
      expect(events[0].status).toBe("offline");
      expect(events[0].reason).toMatch(/sensor disconnected/i);

      const sensor = sensorRegistry.get(1);
      expect(sensor.status).toBe("offline");

      // Verify SSE broadcast occurred
      expect(mockClient.write).toHaveBeenCalledWith(
        expect.stringContaining("event: room_sensor_offline")
      );
      expect(mockClient.write).toHaveBeenCalledWith(
        expect.stringContaining("event: sensor_status_changed")
      );
    });

    test("POST /api/hardware/watchdog/check evaluates timeouts manually", async () => {
      const pastTime = new Date(Date.now() - 35000);
      updateSensorReading(2, 50.0, pastTime);

      const res = await request(app)
        .post("/api/hardware/watchdog/check")
        .send({ timeout_ms: 30000 });

      expect(res.status).toBe(200);
      expect(res.body.offline_count).toBe(1);
      expect(res.body.events[0].room_id).toBe(2);
    });

    test("sensor recovers to online when receiving reading after offline timeout", async () => {
      const mockClient = { write: jest.fn() };
      sseClients.add(mockClient);

      // Timeout sensor
      const pastTime = new Date(Date.now() - 45000);
      updateSensorReading(1, 40.0, pastTime);
      checkHardwareWatchdog(Date.now(), 30000);
      expect(sensorRegistry.get(1).status).toBe("offline");

      mockClient.write.mockClear();

      // Transmit new reading
      updateSensorReading(1, 44.0, new Date());
      expect(sensorRegistry.get(1).status).toBe("online");

      // Verify recovery broadcast
      expect(mockClient.write).toHaveBeenCalledWith(
        expect.stringContaining("event: sensor_status_changed")
      );
      expect(mockClient.write).toHaveBeenCalledWith(
        expect.stringContaining('"status":"online"')
      );
    });
  });

  describe("Zero-dB Stuck Sensor Fault Detection", () => {
    test("flags microphone fault after 3 consecutive zero-dB readings", async () => {
      const mockClient = { write: jest.fn() };
      sseClients.add(mockClient);

      // Cycle 1: 0 dB
      updateSensorReading(1, 0.0);
      expect(sensorRegistry.get(1).status).toBe("online");
      expect(sensorRegistry.get(1).zero_db_streak).toBe(1);

      // Cycle 2: 0 dB
      updateSensorReading(1, 0.0);
      expect(sensorRegistry.get(1).status).toBe("online");
      expect(sensorRegistry.get(1).zero_db_streak).toBe(2);

      // Cycle 3: 0 dB -> triggers fault
      updateSensorReading(1, 0.0);
      const sensor = sensorRegistry.get(1);
      expect(sensor.status).toBe("fault");
      expect(sensor.zero_db_streak).toBe(3);
      expect(sensor.fault_reason).toMatch(/microphone fault \/ obstructed/i);

      // Verify fault SSE event broadcast
      expect(mockClient.write).toHaveBeenCalledWith(
        expect.stringContaining("event: sensor_fault")
      );
    });

    test("recovers from fault state when positive reading arrives", async () => {
      const mockClient = { write: jest.fn() };
      sseClients.add(mockClient);

      // Put into fault state
      updateSensorReading(1, 0.0);
      updateSensorReading(1, 0.0);
      updateSensorReading(1, 0.0);
      expect(sensorRegistry.get(1).status).toBe("fault");

      mockClient.write.mockClear();

      // New normal reading
      updateSensorReading(1, 38.5);
      const sensor = sensorRegistry.get(1);
      expect(sensor.status).toBe("online");
      expect(sensor.zero_db_streak).toBe(0);
      expect(sensor.fault_reason).toBeNull();

      expect(mockClient.write).toHaveBeenCalledWith(
        expect.stringContaining('"status":"online"')
      );
    });
  });
});
