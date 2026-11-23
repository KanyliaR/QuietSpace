const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("../server");
const { dispatch } = require("./test-helper");

describe("General App Routing & Static Files", () => {
  it("GET / serves the home index.html page", async () => {
    const res = await dispatch(app, { method: "GET", url: "/" });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] || "", /html/);
    assert.ok(res.text.includes("QuietSpace"));
  });

  it("GET /webpages/dashboard.html serves dashboard page when authorized", async () => {
    const res = await dispatch(app, {
      method: "GET",
      url: "/webpages/dashboard.html",
      user: { id: 1, username: "admin", role: "admin" }
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] || "", /html/);
    assert.ok(res.text.includes("QuietSpace"));
  });

  it("GET /webpages/reportingPage.html serves public reporting page", async () => {
    const res = await dispatch(app, { method: "GET", url: "/webpages/reportingPage.html" });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] || "", /html/);
  });

  it("GET /nonexistent-route returns 404 with JSON route not found message", async () => {
    const res = await dispatch(app, { method: "GET", url: "/nonexistent-route" });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { message: "Route not found" });
  });

  it("POST /unknown-api-endpoint returns 404", async () => {
    const res = await dispatch(app, { method: "POST", url: "/unknown-api-endpoint", body: {} });
    assert.equal(res.status, 404);
    assert.equal(res.body.message, "Route not found");
  });
});
