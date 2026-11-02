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

describe("Analytics API (/api/analytics/hourly-trends)", () => {
  let consoleErrorSpy;

  beforeEach(() => {
    mockQuery.mockReset();
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test("returns 500 when readings query fails", async () => {
    mockQuery.mockImplementationOnce((sql, params, callback) => {
      callback(new Error("Readings DB error"), null);
    });

    const res = await request(app).get("/api/analytics/hourly-trends");
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/error fetching hourly analytics trends/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test("returns 500 when incidents query fails", async () => {
    mockQuery
      .mockImplementationOnce((sql, params, callback) => {
        callback(null, []);
      })
      .mockImplementationOnce((sql, params, callback) => {
        callback(new Error("Incidents DB error"), null);
      });

    const res = await request(app).get("/api/analytics/hourly-trends");
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/error fetching hourly analytics trends/i);
  });

  test("returns 24 hourly buckets with zeros when database has no records", async () => {
    mockQuery
      .mockImplementationOnce((sql, params, callback) => {
        callback(null, []);
      })
      .mockImplementationOnce((sql, params, callback) => {
        callback(null, []);
      });

    const res = await request(app).get("/api/analytics/hourly-trends");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(24);

    expect(res.body[0]).toMatchObject({
      hour: 0,
      hour_label: "12 AM",
      avg_noise_level: 0,
      avg_level: 0,
      incident_spikes: 0,
      reading_count: 0
    });

    expect(res.body[14]).toMatchObject({
      hour: 14,
      hour_label: "2 PM",
      avg_noise_level: 0,
      avg_level: 0,
      incident_spikes: 0,
      reading_count: 0
    });
  });

  test("correctly maps sound readings and incident spikes by hour", async () => {
    const mockReadings = [
      {
        hour: 9,
        avg_noise_level: "42.50",
        max_noise_level: "55.00",
        min_noise_level: "35.00",
        reading_count: 60
      },
      {
        hour: 14,
        avg_noise_level: "68.75",
        max_noise_level: "82.10",
        min_noise_level: "48.20",
        reading_count: 120
      }
    ];

    const mockIncidents = [
      {
        hour: 14,
        incident_spikes: 5
      },
      {
        hour: 16,
        incident_spikes: 2
      }
    ];

    mockQuery
      .mockImplementationOnce((sql, params, callback) => {
        expect(sql).toContain("FROM sound_readings");
        callback(null, mockReadings);
      })
      .mockImplementationOnce((sql, params, callback) => {
        expect(sql).toContain("FROM incidents");
        callback(null, mockIncidents);
      });

    const res = await request(app).get("/api/analytics/hourly-trends");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(24);

    // Hour 9 (9 AM)
    const hour9 = res.body[9];
    expect(hour9.hour).toBe(9);
    expect(hour9.hour_label).toBe("9 AM");
    expect(hour9.avg_noise_level).toBe(42.5);
    expect(hour9.reading_count).toBe(60);
    expect(hour9.incident_spikes).toBe(0);

    // Hour 14 (2 PM)
    const hour14 = res.body[14];
    expect(hour14.hour).toBe(14);
    expect(hour14.hour_label).toBe("2 PM");
    expect(hour14.avg_noise_level).toBe(68.75);
    expect(hour14.reading_count).toBe(120);
    expect(hour14.incident_spikes).toBe(5);

    // Hour 16 (4 PM)
    const hour16 = res.body[16];
    expect(hour16.hour).toBe(16);
    expect(hour16.hour_label).toBe("4 PM");
    expect(hour16.avg_noise_level).toBe(0);
    expect(hour16.incident_spikes).toBe(2);
  });

  test("filters by room_id when query parameter is supplied", async () => {
    mockQuery
      .mockImplementationOnce((sql, params, callback) => {
        expect(sql).toContain("AND room_id = ?");
        expect(params).toContain("2");
        callback(null, [{ hour: 10, avg_noise_level: "50.00", reading_count: 30 }]);
      })
      .mockImplementationOnce((sql, params, callback) => {
        expect(sql).toContain("AND room_id = ?");
        expect(params).toContain("2");
        callback(null, [{ hour: 10, incident_spikes: 1 }]);
      });

    const res = await request(app).get("/api/analytics/hourly-trends?room_id=2");
    expect(res.status).toBe(200);
    expect(res.body[10].avg_noise_level).toBe(50.0);
    expect(res.body[10].incident_spikes).toBe(1);
  });

  test("supports format=object returning summary metrics", async () => {
    mockQuery
      .mockImplementationOnce((sql, params, callback) => {
        callback(null, [{ hour: 12, avg_noise_level: "60.00", reading_count: 50 }]);
      })
      .mockImplementationOnce((sql, params, callback) => {
        callback(null, [{ hour: 12, incident_spikes: 3 }]);
      });

    const res = await request(app).get("/api/analytics/hourly-trends?format=object");
    expect(res.status).toBe(200);
    expect(res.body.hourly).toBeDefined();
    expect(res.body.hourly).toHaveLength(24);
    expect(res.body.total_readings).toBe(50);
    expect(res.body.total_incidents).toBe(3);
  });
});
