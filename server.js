require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------
// Middleware
// -----------------------------

app.use(cors());
app.use(express.json());

// Only expose frontend files publicly
app.use(
  "/webpages",
  express.static(path.join(__dirname, "webpages"))
);

app.use(
  "/images",
  express.static(path.join(__dirname, "images"))
);

// -----------------------------
// Database Connection
// -----------------------------

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

db.getConnection((err, connection) => {
  if (err) {
    console.error("Database connection failed:", err);
    return;
  }

  console.log("Connected to MySQL database.");
  connection.release(); // return connection to the pool
});

// -----------------------------
// Homepage
// -----------------------------

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "webpages", "index.html")
  );
});

// -----------------------------
// Server-Sent Events (SSE) Setup
// -----------------------------

const sseClients = new Set();

/**
 * Broadcast an event payload to all connected SSE clients.
 */
function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

// Keep-alive heartbeat every 20 seconds to prevent connection drops on proxies
const heartbeatInterval = setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(": ping\n\n");
    } catch (err) {
      sseClients.delete(client);
    }
  }
}, 20000);

if (heartbeatInterval.unref) {
  heartbeatInterval.unref();
}

// SSE connection endpoint for real-time dashboards
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  // Flush headers and confirm connection
  res.write("event: connected\ndata: {}\n\n");
  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

// -----------------------------
// Noise Reports
// -----------------------------

// Submit a new noise report
app.post("/api/reports", (req, res) => {
  const {
    room_id,
    noise_type,
    severity,
    comments
  } = req.body;

  if (!room_id || !noise_type || !severity) {
    return res.status(400).json({
      message: "room_id, noise_type, and severity are required"
    });
  }

  const allowedSeverities = [
    "low",
    "medium",
    "high"
  ];

  if (!allowedSeverities.includes(severity)) {
    return res.status(400).json({
      message: "Invalid severity"
    });
  }

  const sql = `
    INSERT INTO noise_reports (
      room_id,
      noise_type,
      severity,
      comments
    )
    VALUES (?, ?, ?, ?)
  `;

  db.query(
    sql,
    [
      room_id,
      noise_type,
      severity,
      comments || null
    ],
    (err, result) => {
      if (err) {
        console.error("Error saving report:", err);

        return res.status(500).json({
          message: "Error saving report"
        });
      }

      broadcastSSE("report_created", {
        report_id: result.insertId,
        room_id: Number(room_id),
        noise_type,
        severity,
        comments: comments || null,
        report_status: "open",
        submitted_at: new Date().toISOString()
      });

      res.status(201).json({
        message: "Report submitted successfully",
        report_id: result.insertId
      });
    }
  );
});

// Get all noise reports
app.get("/api/reports", (req, res) => {
  const sql = `
    SELECT
      noise_reports.id,
      rooms.room_name,
      noise_reports.noise_type,
      noise_reports.severity,
      noise_reports.comments,
      noise_reports.report_status,
      noise_reports.submitted_at
    FROM noise_reports
    JOIN rooms
      ON noise_reports.room_id = rooms.id
    ORDER BY noise_reports.submitted_at DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error getting reports:", err);

      return res.status(500).json({
        message: "Error getting reports"
      });
    }

    res.json(results);
  });
});

// Update report status
app.put("/api/reports/:id/status", (req, res) => {
  const reportId = req.params.id;
  const { report_status } = req.body;

  const allowedStatuses = [
    "open",
    "in_review",
    "resolved"
  ];

  if (!allowedStatuses.includes(report_status)) {
    return res.status(400).json({
      message: "Invalid report status"
    });
  }

  const sql = `
    UPDATE noise_reports
    SET report_status = ?
    WHERE id = ?
  `;

  db.query(
    sql,
    [report_status, reportId],
    (err, result) => {
      if (err) {
        console.error(
          "Error updating report status:",
          err
        );

        return res.status(500).json({
          message: "Error updating report status"
        });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({
          message: "Report not found"
        });
      }

      broadcastSSE("report_status_updated", {
        report_id: Number(reportId),
        report_status
      });

      res.json({
        message: "Report status updated",
        changed: result.affectedRows
      });
    }
  );
});

// -----------------------------
// Sound Readings
// -----------------------------

// Save a sound reading
app.post("/api/readings", (req, res) => {
  const {
    room_id,
    level,
    quiet_score,
    status_color
  } = req.body;

  if (
    room_id == null ||
    level == null ||
    quiet_score == null ||
    !status_color
  ) {
    return res.status(400).json({
      message:
        "room_id, level, quiet_score, and status_color are required"
    });
  }

  const allowedColors = [
    "green",
    "yellow",
    "red"
  ];

  if (!allowedColors.includes(status_color)) {
    return res.status(400).json({
      message: "Invalid status color"
    });
  }

  const sql = `
    INSERT INTO sound_readings (
      room_id,
      level,
      quiet_score,
      status_color
    )
    VALUES (?, ?, ?, ?)
  `;

  db.query(
    sql,
    [
      room_id,
      level,
      quiet_score,
      status_color
    ],
    (err, result) => {
      if (err) {
        console.error(
          "Error saving reading:",
          err
        );

        return res.status(500).json({
          message: "Error saving reading"
        });
      }

      broadcastSSE("reading", {
        room_id: Number(room_id),
        level: Number(level),
        quiet_score,
        status_color,
        recorded_at: new Date().toISOString()
      });

      res.status(201).json({
        message: "Reading saved successfully",
        reading_id: result.insertId
      });
    }
  );
});

// Get the latest reading for each room
app.get("/api/readings/latest", (req, res) => {
  const sql = `
    SELECT
      r.id AS room_id,
      r.room_name,
      r.location,
      COALESCE(r.is_active, 1) AS is_active,
      sr.level,
      sr.status_color,
      sr.quiet_score,
      sr.recorded_at
    FROM rooms r
    LEFT JOIN sound_readings sr
      ON sr.id = (
        SELECT id
        FROM sound_readings
        WHERE room_id = r.id
        ORDER BY recorded_at DESC
        LIMIT 1
      )
    ORDER BY r.id
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error(
        "Error getting latest readings:",
        err
      );

      return res.status(500).json({
        message: "Error getting latest readings"
      });
    }

    res.json(results);
  });
});

// -----------------------------
// Incidents
// -----------------------------

// Get incidents
app.get("/api/incidents", (req, res) => {
  const sql = `
    SELECT
      incidents.id,
      rooms.room_name,
      incidents.status,
      incidents.escalation_count,
      incidents.started_at,
      incidents.resolved_at,
      incidents.timer_started_at
    FROM incidents
    JOIN rooms
      ON incidents.room_id = rooms.id
    ORDER BY incidents.started_at DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error(
        "Error getting incidents:",
        err
      );

      return res.status(500).json({
        message: "Error getting incidents"
      });
    }

    const RED_TIME_MS = 2 * 60 * 1000;

    const formatted = results.map(
      (incident) => {
        let timer_remaining = "Completed";

        if (
          incident.status === "open" &&
          incident.timer_started_at
        ) {
          const timerStart = new Date(
            incident.timer_started_at
          ).getTime();

          const elapsed =
            Date.now() - timerStart;

          const remaining = Math.max(
            0,
            RED_TIME_MS - elapsed
          );

          const minutes = Math.floor(
            remaining / 60000
          );

          const seconds = Math.floor(
            (remaining % 60000) / 1000
          );

          timer_remaining =
            `${minutes}:` +
            `${String(seconds).padStart(2, "0")} remaining`;
        }

        return {
          ...incident,
          timer_remaining
        };
      }
    );

    res.json(formatted);
  });
});

// Start an incident
app.post(
  "/api/incidents/start",
  (req, res) => {
    const {
      room_id,
      trigger_level
    } = req.body;

    if (
      room_id == null ||
      trigger_level == null
    ) {
      return res.status(400).json({
        message:
          "room_id and trigger_level are required"
      });
    }

    const checkSql = `
      SELECT id
      FROM incidents
      WHERE room_id = ?
        AND status = 'open'
      ORDER BY started_at DESC
      LIMIT 1
    `;

    db.query(
      checkSql,
      [room_id],
      (checkErr, existing) => {
        if (checkErr) {
          console.error(
            "Error checking incident:",
            checkErr
          );

          return res.status(500).json({
            message:
              "Error checking incident"
          });
        }

        if (existing.length > 0) {
          return res.json({
            message:
              "Incident already open",
            incident_id: existing[0].id
          });
        }

        const insertSql = `
          INSERT INTO incidents (
            room_id,
            trigger_level,
            status,
            escalation_count,
            timer_started_at
          )
          VALUES (
            ?,
            ?,
            'open',
            1,
            CURRENT_TIMESTAMP
          )
        `;

        db.query(
          insertSql,
          [
            room_id,
            trigger_level
          ],
          (insertErr, result) => {
            if (insertErr) {
              console.error(
                "Error starting incident:",
                insertErr
              );

              return res
                .status(500)
                .json({
                  message:
                    "Error starting incident"
                });
            }

            broadcastSSE("incident_started", {
              incident_id: result.insertId,
              room_id: Number(room_id),
              trigger_level,
              status: "open",
              escalation_count: 1,
              timer_started_at: new Date().toISOString()
            });

            res.status(201).json({
              message: "Incident started",
              incident_id:
                result.insertId
            });
          }
        );
      }
    );
  }
);

// Resolve an incident
app.post(
  "/api/incidents/resolve",
  (req, res) => {
    const { room_id } = req.body;

    if (room_id == null) {
      return res.status(400).json({
        message: "room_id is required"
      });
    }

    const sql = `
      UPDATE incidents
      SET
        status = 'resolved',
        resolved_at = CURRENT_TIMESTAMP
      WHERE room_id = ?
        AND status = 'open'
      ORDER BY started_at DESC
      LIMIT 1
    `;

    db.query(
      sql,
      [room_id],
      (err, result) => {
        if (err) {
          console.error(
            "Error resolving incident:",
            err
          );

          return res.status(500).json({
            message:
              "Error resolving incident"
          });
        }

        broadcastSSE("incident_resolved", {
          room_id: Number(room_id),
          resolved_at: new Date().toISOString()
        });

        res.json({
          message: "Incident resolved",
          changed: result.affectedRows
        });
      }
    );
  }
);

// Escalate an incident
app.post(
  "/api/incidents/escalate",
  (req, res) => {
    const { room_id } = req.body;

    if (room_id == null) {
      return res.status(400).json({
        message: "room_id is required"
      });
    }

    const sql = `
      UPDATE incidents
      SET
        escalation_count =
          escalation_count + 1,
        timer_started_at =
          CURRENT_TIMESTAMP
      WHERE room_id = ?
        AND status = 'open'
      ORDER BY started_at DESC
      LIMIT 1
    `;

    db.query(
      sql,
      [room_id],
      (err, result) => {
        if (err) {
          console.error(
            "Error escalating incident:",
            err
          );

          return res.status(500).json({
            message:
              "Error escalating incident"
          });
        }

        broadcastSSE("incident_escalated", {
          room_id: Number(room_id),
          timer_started_at: new Date().toISOString()
        });

        res.json({
          message: "Incident escalated",
          changed: result.affectedRows
        });
      }
    );
  }
);

// -----------------------------
// Rooms API
// -----------------------------

// Get all rooms
app.get("/api/rooms", (req, res) => {
  const sql = `
    SELECT
      r.id,
      r.id AS room_id,
      r.room_name,
      r.location,
      COALESCE(r.is_active, 1) AS is_active,
      r.created_at,
      sr.level,
      sr.status_color,
      sr.quiet_score,
      sr.recorded_at
    FROM rooms r
    LEFT JOIN sound_readings sr
      ON sr.id = (
        SELECT id
        FROM sound_readings
        WHERE room_id = r.id
        ORDER BY recorded_at DESC
        LIMIT 1
      )
    ORDER BY r.id
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error getting rooms:", err);
      return res.status(500).json({
        message: "Error getting rooms"
      });
    }

    const formatted = results.map((room) => ({
      ...room,
      is_active: room.is_active === 0 || room.is_active === false ? 0 : 1
    }));

    res.json(formatted);
  });
});

// Get a specific room by ID
app.get("/api/rooms/:id", (req, res) => {
  const roomId = req.params.id;

  const sql = `
    SELECT
      r.id,
      r.id AS room_id,
      r.room_name,
      r.location,
      COALESCE(r.is_active, 1) AS is_active,
      r.created_at,
      sr.level,
      sr.status_color,
      sr.quiet_score,
      sr.recorded_at
    FROM rooms r
    LEFT JOIN sound_readings sr
      ON sr.id = (
        SELECT id
        FROM sound_readings
        WHERE room_id = r.id
        ORDER BY recorded_at DESC
        LIMIT 1
      )
    WHERE r.id = ?
  `;

  db.query(sql, [roomId], (err, results) => {
    if (err) {
      console.error("Error getting room:", err);
      return res.status(500).json({
        message: "Error getting room"
      });
    }

    if (results.length === 0) {
      return res.status(404).json({
        message: "Room not found"
      });
    }

    const room = {
      ...results[0],
      is_active: results[0].is_active === 0 || results[0].is_active === false ? 0 : 1
    };

    res.json(room);
  });
});

// Add a new room
app.post("/api/rooms", (req, res) => {
  const { room_name, location, is_active } = req.body;

  if (!room_name || typeof room_name !== "string" || !room_name.trim()) {
    return res.status(400).json({
      message: "room_name is required"
    });
  }

  const trimmedName = room_name.trim();
  const loc = location && typeof location === "string" && location.trim()
    ? location.trim()
    : "Bluford Library";
  const active = is_active === false || is_active === 0 ? 0 : 1;

  const sql = `
    INSERT INTO rooms (room_name, location, is_active)
    VALUES (?, ?, ?)
  `;

  db.query(sql, [trimmedName, loc, active], (err, result) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          message: "A room with this name already exists"
        });
      }

      console.error("Error creating room:", err);
      return res.status(500).json({
        message: "Error creating room"
      });
    }

    const newRoom = {
      id: result.insertId,
      room_id: result.insertId,
      room_name: trimmedName,
      location: loc,
      is_active: active
    };

    broadcastSSE("room_created", newRoom);

    res.status(201).json({
      message: "Room created successfully",
      room: newRoom
    });
  });
});

// Rename or update an existing room
app.put("/api/rooms/:id", (req, res) => {
  const roomId = req.params.id;
  const { room_name, location, is_active } = req.body;

  if (room_name === undefined && location === undefined && is_active === undefined) {
    return res.status(400).json({
      message: "At least one field (room_name, location, is_active) must be provided"
    });
  }

  if (room_name !== undefined && (typeof room_name !== "string" || !room_name.trim())) {
    return res.status(400).json({
      message: "room_name cannot be empty"
    });
  }

  const fields = [];
  const values = [];

  if (room_name !== undefined) {
    fields.push("room_name = ?");
    values.push(room_name.trim());
  }

  if (location !== undefined) {
    fields.push("location = ?");
    values.push(location.trim());
  }

  if (is_active !== undefined) {
    fields.push("is_active = ?");
    values.push(is_active ? 1 : 0);
  }

  values.push(roomId);

  const sql = `
    UPDATE rooms
    SET ${fields.join(", ")}
    WHERE id = ?
  `;

  db.query(sql, values, (err, result) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          message: "A room with this name already exists"
        });
      }

      console.error("Error updating room:", err);
      return res.status(500).json({
        message: "Error updating room"
      });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Room not found"
      });
    }

    const updatedRoom = {
      id: Number(roomId),
      room_id: Number(roomId),
      ...(room_name !== undefined && { room_name: room_name.trim() }),
      ...(location !== undefined && { location: location.trim() }),
      ...(is_active !== undefined && { is_active: is_active ? 1 : 0 })
    };

    broadcastSSE("room_updated", updatedRoom);

    res.json({
      message: "Room updated successfully",
      room: updatedRoom,
      changed: result.affectedRows
    });
  });
});

// Toggle room active status
const toggleRoomHandler = (req, res) => {
  const roomId = req.params.id;

  const updateSql = `
    UPDATE rooms
    SET is_active = IF(is_active = 1, 0, 1)
    WHERE id = ?
  `;

  db.query(updateSql, [roomId], (err, result) => {
    if (err) {
      console.error("Error toggling room status:", err);
      return res.status(500).json({
        message: "Error toggling room status"
      });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({
        message: "Room not found"
      });
    }

    const selectSql = `
      SELECT id, room_name, location, is_active
      FROM rooms
      WHERE id = ?
    `;

    db.query(selectSql, [roomId], (selectErr, rows) => {
      const room = rows && rows[0]
        ? rows[0]
        : { id: Number(roomId), is_active: 1 };

      const isAct = room.is_active === 0 || room.is_active === false ? 0 : 1;

      broadcastSSE("room_updated", {
        id: Number(roomId),
        room_id: Number(roomId),
        room_name: room.room_name,
        is_active: isAct
      });

      res.json({
        message: `Room status toggled to ${isAct ? "active" : "inactive"}`,
        room: {
          ...room,
          id: Number(roomId),
          room_id: Number(roomId),
          is_active: isAct
        }
      });
    });
  });
};

app.patch("/api/rooms/:id/toggle", toggleRoomHandler);
app.put("/api/rooms/:id/toggle", toggleRoomHandler);

// -----------------------------
// 404 Handler
// -----------------------------

app.use((req, res) => {
  res.status(404).json({
    message: "Route not found"
  });
});

// -----------------------------
// Start Server
// -----------------------------

let serverInstance = null;

if (require.main === module) {
  // Ensure rooms table has is_active column if missing
  db.query("SHOW COLUMNS FROM rooms LIKE 'is_active'", (err, cols) => {
    if (!err && cols && cols.length === 0) {
      db.query("ALTER TABLE rooms ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1", (aErr) => {
        if (aErr) console.warn("is_active column check:", aErr.message);
      });
    }
  });

  serverInstance = app.listen(PORT, () => {
    console.log(
      `QuietSpace server running on port ${PORT}`
    );
  });
}

module.exports = {
  app,
  db,
  server: serverInstance,
  broadcastSSE,
  sseClients
};