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

describe("General App Routing & Static Files", () => {
  test("GET / serves the home index.html page", async () => {
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("QuietSpace");
  });

  test("GET /webpages/dashboard.html serves dashboard page", async () => {
    const res = await request(app).get("/webpages/dashboard.html");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
  });

  test("GET /webpages/reportingPage.html serves reporting page", async () => {
    const res = await request(app).get("/webpages/reportingPage.html");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
  });

  test("GET /nonexistent-route returns 404 with JSON route not found message", async () => {
    const res = await request(app).get("/nonexistent-route");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      message: "Route not found"
    });
  });

  test("POST /unknown-api-endpoint returns 404", async () => {
    const res = await request(app).post("/unknown-api-endpoint").send({});

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Route not found");
  });
});
