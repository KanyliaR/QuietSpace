const request = require("supertest");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

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

const { app, JWT_SECRET } = require("../server");

describe("Authentication API (/api/auth)", () => {
  let consoleErrorSpy;
  const samplePassword = "Password123!";
  const sampleHash = bcrypt.hashSync(samplePassword, 10);

  beforeEach(() => {
    mockQuery.mockReset();
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("POST /api/auth/login", () => {
    test("returns 400 when email or password is missing or empty", async () => {
      const res1 = await request(app).post("/api/auth/login").send({});
      expect(res1.status).toBe(400);
      expect(res1.body.message).toMatch(/email and password are required/i);

      const res2 = await request(app).post("/api/auth/login").send({
        email: "staff@quietspace.com"
      });
      expect(res2.status).toBe(400);

      const res3 = await request(app).post("/api/auth/login").send({
        email: "   ",
        password: "   "
      });
      expect(res3.status).toBe(400);
    });

    test("returns 500 when database error occurs", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(new Error("Database connection error"), null);
      });

      const res = await request(app).post("/api/auth/login").send({
        email: "staff@quietspace.com",
        password: "anyPassword"
      });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/internal server error/i);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    test("returns 401 when staff user is not found in database", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(null, []);
      });

      const res = await request(app).post("/api/auth/login").send({
        email: "nonexistent@quietspace.com",
        password: "anyPassword"
      });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/invalid email or password/i);
    });

    test("returns 401 when password does not match hashed password", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        callback(null, [
          {
            id: 1,
            name: "Library Staff",
            email: "staff@quietspace.com",
            password_hash: sampleHash
          }
        ]);
      });

      const res = await request(app).post("/api/auth/login").send({
        email: "staff@quietspace.com",
        password: "wrongPassword"
      });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/invalid email or password/i);
    });

    test("returns 200 with JWT token and user info on valid credentials", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        expect(params).toEqual(["staff@quietspace.com"]);
        callback(null, [
          {
            id: 1,
            name: "Library Staff",
            email: "staff@quietspace.com",
            password_hash: sampleHash
          }
        ]);
      });

      const res = await request(app).post("/api/auth/login").send({
        email: "staff@quietspace.com",
        password: samplePassword
      });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/login successful/i);
      expect(res.body.token).toBeDefined();
      expect(typeof res.body.token).toBe("string");
      expect(res.body.user).toEqual({
        id: 1,
        name: "Library Staff",
        email: "staff@quietspace.com"
      });

      // Verify JWT payload
      const decoded = jwt.verify(res.body.token, JWT_SECRET);
      expect(decoded.id).toBe(1);
      expect(decoded.email).toBe("staff@quietspace.com");
      expect(decoded.name).toBe("Library Staff");
    });
  });

  describe("POST /api/auth/register", () => {
    test("returns 400 when required fields are missing or password is too short", async () => {
      const res1 = await request(app).post("/api/auth/register").send({
        name: "Admin"
      });
      expect(res1.status).toBe(400);

      const res2 = await request(app).post("/api/auth/register").send({
        name: "Admin",
        email: "admin@quietspace.com",
        password: "123"
      });
      expect(res2.status).toBe(400);
      expect(res2.body.message).toMatch(/at least 6 characters/i);
    });

    test("returns 409 if staff account email already exists", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        const err = new Error("Duplicate entry");
        err.code = "ER_DUP_ENTRY";
        callback(err, null);
      });

      const res = await request(app).post("/api/auth/register").send({
        name: "Staff Duplicate",
        email: "staff@quietspace.com",
        password: "ValidPassword123"
      });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already exists/i);
    });

    test("returns 201 and creates new staff account", async () => {
      mockQuery.mockImplementation((sql, params, callback) => {
        expect(params[0]).toBe("New Librarian");
        expect(params[1]).toBe("librarian@quietspace.com");
        // Verify password was hashed with bcrypt
        expect(params[2]).toMatch(/^\$2[aby]\$/);
        callback(null, { insertId: 5, affectedRows: 1 });
      });

      const res = await request(app).post("/api/auth/register").send({
        name: "New Librarian",
        email: "librarian@quietspace.com",
        password: "SecurePassword123"
      });

      expect(res.status).toBe(201);
      expect(res.body.message).toMatch(/created successfully/i);
      expect(res.body.user.id).toBe(5);
      expect(res.body.user.name).toBe("New Librarian");
      expect(res.body.user.email).toBe("librarian@quietspace.com");
      expect(res.body.token).toBeDefined();
    });
  });

  describe("GET /api/auth/me", () => {
    test("returns 401 when Authorization header is missing", async () => {
      const res = await request(app).get("/api/auth/me");
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/token required/i);
    });

    test("returns 403 when token is invalid", async () => {
      const res = await request(app)
        .get("/api/auth/me")
        .set("Authorization", "Bearer invalid.token.payload");

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/invalid or expired token/i);
    });

    test("returns 200 with user profile when valid token provided", async () => {
      const token = jwt.sign(
        { id: 1, name: "Library Staff", email: "staff@quietspace.com" },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      const res = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(1);
      expect(res.body.user.email).toBe("staff@quietspace.com");
    });
  });
});
