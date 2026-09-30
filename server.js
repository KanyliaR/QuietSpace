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

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

db.connect((err) => {
  if (err) {
    console.error("Database connection failed:", err);
    return;
  }

  console.log("Connected to MySQL database.");
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

        res.json({
          message: "Incident escalated",
          changed: result.affectedRows
        });
      }
    );
  }
);

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

app.listen(PORT, () => {
  console.log(
    `QuietSpace server running on port ${PORT}`
  );
});