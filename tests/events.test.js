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

const http = require("http");
const request = require("supertest");
const { app, broadcastSSE, sseClients } = require("../server");

describe("Server-Sent Events (SSE) Stream (/api/events)", () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    sseClients.clear();
    server.close(done);
  });

  beforeEach(() => {
    mockQuery.mockReset();
    jest.clearAllMocks();
    sseClients.clear();
  });

  afterEach(() => {
    sseClients.clear();
  });

  test("GET /api/events sets correct headers and sends initial 'connected' event", (done) => {
    const req = http.get(`${baseUrl}/api/events`, (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/event-stream");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.headers["connection"]).toBe("keep-alive");

      let received = "";
      res.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("event: connected\ndata: {}\n\n")) {
          expect(sseClients.size).toBe(1);
          req.destroy();
        }
      });

      res.on("close", () => {
        // Allow req close callback to execute
        setTimeout(() => {
          expect(sseClients.size).toBe(0);
          done();
        }, 50);
      });
    });
  });

  test("broadcastSSE broadcasts payload to all connected clients", (done) => {
    let clientsConnected = 0;
    const clientReqs = [];
    let receivedCount = 0;

    function handleClient(res, req) {
      clientReqs.push(req);
      let dataBuffer = "";

      res.on("data", (chunk) => {
        dataBuffer += chunk.toString();

        if (dataBuffer.includes("event: test_broadcast")) {
          expect(dataBuffer).toContain('"room_id":101');
          expect(dataBuffer).toContain('"status":"alert"');
          receivedCount++;
          if (receivedCount === 2) {
            clientReqs.forEach((r) => r.destroy());
            done();
          }
        }
      });

      clientsConnected++;
      if (clientsConnected === 2) {
        // Wait for both to be fully added to sseClients
        setTimeout(() => {
          expect(sseClients.size).toBe(2);
          broadcastSSE("test_broadcast", { room_id: 101, status: "alert" });
        }, 50);
      }
    }

    const req1 = http.get(`${baseUrl}/api/events`, (res) => handleClient(res, req1));
    const req2 = http.get(`${baseUrl}/api/events`, (res) => handleClient(res, req2));
  });

  test("broadcastSSE removes broken clients when client.write throws an error", () => {
    const brokenClient = {
      write: jest.fn(() => {
        throw new Error("Client socket closed unexpectedly");
      })
    };
    const healthyClient = {
      write: jest.fn()
    };

    sseClients.add(brokenClient);
    sseClients.add(healthyClient);

    expect(sseClients.size).toBe(2);

    broadcastSSE("ping", { time: Date.now() });

    expect(healthyClient.write).toHaveBeenCalledTimes(1);
    expect(brokenClient.write).toHaveBeenCalledTimes(1);
    expect(sseClients.has(brokenClient)).toBe(false);
    expect(sseClients.has(healthyClient)).toBe(true);
    expect(sseClients.size).toBe(1);
  });

  test("broadcasts 'reading' event to SSE stream when new reading is posted", (done) => {
    mockQuery.mockImplementation((sql, params, callback) => {
      callback(null, { insertId: 88, affectedRows: 1 });
    });

    const req = http.get(`${baseUrl}/api/events`, (res) => {
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();

        if (buffer.includes("event: reading")) {
          expect(buffer).toContain('"room_id":2');
          expect(buffer).toContain('"level":18');
          expect(buffer).toContain('"status_color":"red"');
          expect(buffer).toContain('"quiet_score":"Too Loud"');
          req.destroy();
          done();
        }
      });

      // Post reading after connected
      setTimeout(async () => {
        await request(baseUrl)
          .post("/api/readings")
          .send({
            room_id: 2,
            level: 18,
            quiet_score: "Too Loud",
            status_color: "red"
          });
      }, 50);
    });
  });

  test("broadcasts 'report_created' event to SSE stream when report is submitted", (done) => {
    mockQuery.mockImplementation((sql, params, callback) => {
      callback(null, { insertId: 99, affectedRows: 1 });
    });

    const req = http.get(`${baseUrl}/api/events`, (res) => {
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();

        if (buffer.includes("event: report_created")) {
          expect(buffer).toContain('"report_id":99');
          expect(buffer).toContain('"room_id":1');
          expect(buffer).toContain('"noise_type":"screaming"');
          expect(buffer).toContain('"severity":"high"');
          req.destroy();
          done();
        }
      });

      setTimeout(async () => {
        await request(baseUrl)
          .post("/api/reports")
          .send({
            room_id: 1,
            noise_type: "screaming",
            severity: "high",
            comments: "Disturbing floor"
          });
      }, 50);
    });
  });

  test("broadcasts incident events (started, escalated, resolved) over SSE", (done) => {
    let step = 0;
    const req = http.get(`${baseUrl}/api/events`, (res) => {
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();

        if (step === 0 && buffer.includes("event: incident_started")) {
          expect(buffer).toContain('"incident_id":12');
          expect(buffer).toContain('"room_id":3');
          expect(buffer).toContain('"status":"open"');
          step = 1;
          buffer = "";

          // Escalate incident
          mockQuery.mockImplementationOnce((sql, params, callback) => {
            callback(null, { affectedRows: 1 });
          });

          request(baseUrl)
            .post("/api/incidents/escalate")
            .send({ room_id: 3 })
            .catch(done);
        } else if (step === 1 && buffer.includes("event: incident_escalated")) {
          expect(buffer).toContain('"room_id":3');
          step = 2;
          buffer = "";

          // Resolve incident
          mockQuery.mockImplementationOnce((sql, params, callback) => {
            callback(null, { affectedRows: 1 });
          });

          request(baseUrl)
            .post("/api/incidents/resolve")
            .send({ room_id: 3 })
            .catch(done);
        } else if (step === 2 && buffer.includes("event: incident_resolved")) {
          expect(buffer).toContain('"room_id":3');
          req.destroy();
          done();
        }
      });

      setTimeout(async () => {
        // Start incident
        mockQuery
          .mockImplementationOnce((sql, params, callback) => {
            callback(null, []); // No open incident
          })
          .mockImplementationOnce((sql, params, callback) => {
            callback(null, { insertId: 12, affectedRows: 1 });
          });

        await request(baseUrl)
          .post("/api/incidents/start")
          .send({ room_id: 3, trigger_level: "red" });
      }, 50);
    });
  });

  test("broadcasts 'room_created' and 'room_updated' events over SSE", (done) => {
    let step = 0;
    const req = http.get(`${baseUrl}/api/events`, (res) => {
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();

        if (step === 0 && buffer.includes("event: room_created")) {
          expect(buffer).toContain('"room_name":"Room 315"');
          step = 1;
          buffer = "";

          // Toggle room status
          mockQuery
            .mockImplementationOnce((sql, params, callback) => {
              callback(null, { affectedRows: 1 });
            })
            .mockImplementationOnce((sql, params, callback) => {
              callback(null, [{ id: 5, room_name: "Room 315", location: "3rd Floor", is_active: 0 }]);
            });

          request(baseUrl)
            .patch("/api/rooms/5/toggle")
            .catch(done);
        } else if (step === 1 && buffer.includes("event: room_updated")) {
          expect(buffer).toContain('"room_id":5');
          expect(buffer).toContain('"is_active":0');
          req.destroy();
          done();
        }
      });

      setTimeout(async () => {
        mockQuery.mockImplementationOnce((sql, params, callback) => {
          callback(null, { insertId: 5, affectedRows: 1 });
        });

        await request(baseUrl)
          .post("/api/rooms")
          .send({ room_name: "Room 315", location: "3rd Floor" });
      }, 50);
    });
  });
});
