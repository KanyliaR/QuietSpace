require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const fs = require("fs");
const { installAccess, asyncRoute } = require("./lib/access");
const { createActivity } = require("./lib/activity");
const { incidentAlerts } = require("./lib/incident-alerts");
const path = require("path");
const { STUDENT_REPORTS_SQL, QUIETSCORE_REPORTS_SQL, visibleReports } = require("./lib/report-data");

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------
// Middleware
// -----------------------------

app.use(express.json({ limit: "16kb" }));

// -----------------------------
// Database Connection
// -----------------------------

const defaultPool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const originalPromise = defaultPool.promise.bind(defaultPool);
const promisePoolProxy = {
  getConnection: (...args) => (defaultPool.__promisePool || originalPromise()).getConnection(...args),
  query: (...args) => (defaultPool.__promisePool || originalPromise()).query(...args)
};
defaultPool.promise = () => promisePoolProxy;
const db = defaultPool;

const sseClients = new Set();
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

const access = installAccess(app, db, { broadcastSSE });
const activity = createActivity(db, access.publish);

// Token-bearing pages never cache or send their URL as a referrer.
app.get(['/setup-account','/webpages/setup-account.html'],(req,res)=>{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
  res.sendFile(path.join(__dirname,'webpages/setup-account.html'));
});

// Staff HTML is authorized before being served. Public room/QR/login pages stay public.
const staffPages = {
  "dashboard.html": ["admin", "security", "library_monitor"],
  "StudentReportsPage.html": ["admin", "security"],
  "QuietScorePage.html": ["admin", "security"],
  "analytics.html": ["admin", "security"],
  "staff-accounts.html": ["admin"],
  "reports.html": ["admin"],
  "audit-logs.html": ["admin"],
  "settings.html": ["admin", "security", "library_monitor"]
};
app.use("/webpages", (req, res, next) => {
  let requested;
  try { requested = path.posix.normalize(decodeURIComponent(req.path)).slice(1).toLowerCase(); }
  catch { return res.status(400).send("Invalid path"); }
  // Monitors use only Overview and personal Settings. Keep public login, QR,
  // and room-display routes public; reject legacy/unknown staff HTML as well.
  if (req.user?.role === 'library_monitor' && requested.endsWith('.html') &&
      !['dashboard.html','settings.html','login.html','reportingpage.html','index.html'].includes(requested)) {
    return res.status(403).send('Access denied for this role.');
  }
  const file = Object.keys(staffPages).find(name => name.toLowerCase() === requested);
  if (!file) return next();
  if (!req.user) return res.redirect("/webpages/login.html?restricted=1");
  if (!staffPages[file].includes(req.user.role)) return res.status(403).send("Access denied for this role.");
  const user = { id: req.user.id, role: req.user.role, username: req.user.username };
  const bootstrap = JSON.stringify(user).replace(/</g, "\\u003c");
  let html = fs.readFileSync(path.join(__dirname, "webpages", file), "utf8");
  if (file === "settings.html" && req.user.role === "admin") {
    // Notification preferences remain available in Monitor and Security Settings.
    html = html.replace(/<section class="section" id="generalPreferencesSection">[\s\S]*?<\/section>/, '');
  }
  if (file === "settings.html" && req.user.role !== "admin") {
    // Serve the same Settings shell and shared preferences component, without admin markup.
    const personalSections = req.user.role === 'library_monitor'
      ? ['personalAccountSection','themeSection','generalPreferencesSection']
      : ['personalAccountSection','generalPreferencesSection','themeSection'];
    const general = personalSections.map(id => {
      let section = html.match(new RegExp(`<section class="section" id="${id}">[\\s\\S]*?<\\/section>`))[0];
      if (id === 'themeSection') section = section.replace('<section class="section" id="themeSection">','<section class="section" id="themeSection" data-personal-appearance>')
        .replace('Display Theme & Appearance','Display & Appearance')
        .replace('</section>','<div class="button-row"><button class="btn btn-primary" type="button" id="savePersonalAppearance">Save Appearance</button><span id="personalAppearanceMessage" role="status"></span></div></section>');
      return section;
    }).join('');
    html = html.replace(/<main class="main">[\s\S]*?<\/main>/,
      `<main class="main"><div class="top-header"><h2>General Settings</h2><p>Your personal notifications and account settings.</p></div><div class="content-container">${general}</div></main>`);
  }
  // Every staff page receives the current overview navigation shell and shared sidebar styles.
  const overview = fs.readFileSync(path.join(__dirname, "webpages", "dashboard.html"), "utf8");
  let sidebar = overview.match(/<aside class="sidebar">[\s\S]*?<\/aside>/)[0]
    .replace('class="nav-item active"', 'class="nav-item"');
  if (req.user.role === 'admin') {
    sidebar=sidebar.replace(/<a\b[^>]*href="QuietScorePage.html"[^>]*>[\s\S]*?<\/a>/,'<a class="nav-item" href="reports.html">Historical Reports</a>')
      .replace(/<a\b[^>]*href="StudentReportsPage.html"[^>]*>[\s\S]*?<\/a>/,'')
      .replace(/(<a\b[^>]*href="analytics.html"[^>]*>[\s\S]*?<\/a>)/,'$1<a class="nav-item" href="staff-accounts.html">Account Requests &amp; Staff</a><a class="nav-item" href="audit-logs.html">Audit Logs</a>');
    if(file==='dashboard.html') {
      html=html.replace("Today's Monitoring Overview",'Administrative Overview');
      for(const id of ['securityEscalationsSection','quietscoreReportsSection','studentReportsSection'])
        html=html.replace(new RegExp(`<section\\b[^>]*id="${id}"[^>]*>[\\s\\S]*?<\\/section>`),'');
      html=html.replace(/<div\b[^>]*id="dailyOverviewReportTabs"[^>]*>[\s\S]*?<\/div>/,'');
    }
    html=html.replace('</head>','<link rel="stylesheet" href="/webpages/administration.css"><script defer src="/webpages/administration.js"></script></head>');
  }
  if (req.user.role === "library_monitor") sidebar = sidebar.replace(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi,
    (link, href) => ['dashboard.html','settings.html'].includes(href) ? link : '');
  sidebar = sidebar.replace(new RegExp(`class="nav-item" href="${file.replace('.', '\\.') }"`), `class="nav-item active" aria-current="page" href="${file}"`);
  if(req.user.role==='admin' && ['QuietScorePage.html','StudentReportsPage.html'].includes(file)) sidebar=sidebar.replace('class="nav-item" href="reports.html"','class="nav-item active" aria-current="page" href="reports.html"');
  if (file === "settings.html") sidebar = sidebar.replace('href="settings.html"', 'href="settings.html" aria-current="page"');
  html = html.replace(/<aside class="sidebar">[\s\S]*?<\/aside>/, sidebar);
  // Reuse the complete existing report pages in same-origin admin tab panels.
  // Only these authorized embedded responses can be framed; all other pages retain DENY.
  if(req.user.role==='admin' && req.query.embedded==='1' && ['QuietScorePage.html','StudentReportsPage.html'].includes(file)) {
    res.set('X-Frame-Options','SAMEORIGIN');res.set('Content-Security-Policy',"frame-ancestors 'self'");
    html=html.replace('<body','<body data-admin-report-embed');
    html=html.replace('</head>','<style>html body[data-admin-report-embed] .sidebar,html body[data-admin-report-embed] .sidebar-toggle,html body[data-admin-report-embed] .sidebar-backdrop,html body[data-admin-report-embed] .top-header{display:none!important}html body[data-admin-report-embed] .main{margin:0!important;width:100%!important;padding:0!important;min-width:0!important}html body[data-admin-report-embed]{display:block!important;padding:0!important}</style></head>');
  }

  if(file==='dashboard.html')html=html.replace('</head>','<link rel="stylesheet" href="/webpages/room-cards.css"><script src="/webpages/room-cards.js"></script></head>');
  html = html.replace('content="width=950, user-scalable=yes"', 'content="width=device-width, initial-scale=1.0"');
  html = html.replace('</head>', '<link rel="stylesheet" href="/webpages/sidebar.css"><link rel="stylesheet" href="/webpages/staff-header.css"></head>');
  res.type("html").send(html.replace("<head>", `<head><script>window.quietspaceUser=${bootstrap};</script><link rel="stylesheet" href="/webpages/staff-controls.css"><script src="/webpages/escalation-ui.js"></script><script src="/webpages/report-overview.js"></script><script src="/webpages/staff.js"></script><script defer src="/webpages/session-activity.js"></script>`));
});
app.use("/webpages", express.static(path.join(__dirname, "webpages")));
// Serve only the standalone utility's existing web assets, behind the app's admin session.
app.use('/calibration', (req,res,next)=>{
  if(!req.user)return res.redirect('/webpages/login.html?restricted=1');
  if(req.user.role!=='admin')return res.status(403).send('Access denied for this role.');
  let file;try{file=decodeURIComponent(req.path).replace(/^\//,'');}catch{return res.status(400).end();}
  if(!file) {if(!req.originalUrl.split('?')[0].endsWith('/'))return res.redirect('/calibration/');file='index.html';}
  if(!['index.html','calibration.css','calibration.js','analysis.js','audio/laptop.js'].includes(file))return res.status(404).end();
  res.set('Cache-Control','no-store');
  if(file==='index.html')return res.type('html').send(fs.readFileSync(path.join(__dirname,'calibration',file),'utf8').replace('</head>','<script defer src="/webpages/session-activity.js"></script></head>'));
  res.sendFile(path.join(__dirname,'calibration',file));
});
app.use("/images", express.static(path.join(__dirname, "images")));

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
app.post("/api/reports", asyncRoute(async (req, res) => {
  const result = await activity.createReport(req.body);
  access.publish('report-created', { changed: true });
  access.publish('reports-updated', { changed: true });
  res.status(201).json(result);
}));

// Get all noise reports
app.get("/api/reports", (req, res) => {
  const sql = STUDENT_REPORTS_SQL;
  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error getting reports:", err);

      return res.status(500).json({
        message: "Error getting reports"
      });
    }

    res.json(req.user.role === "library_monitor" ? visibleReports(results, "submitted_at") : results);
  });
});

// Update report status

 // Update report status
app.put("/api/reports/:id/status", asyncRoute(async (req, res) => {
  const result = await activity.reportStatus(req.params.id, req.body.report_status, req.user);
  if (result.changed) access.publish('reports-updated', { changed: true });
  res.json(result);
}));

app.get('/api/reports/:id/activity', asyncRoute(async (req, res) => res.json(await activity.reportHistory(req.params.id, req.user))));
app.get('/api/incidents/:id/activity', asyncRoute(async (req, res) => res.json(await activity.incidentHistory(req.params.id, req.user))));
app.post('/api/incidents/:id/alert-displayed', asyncRoute(async (req, res) => res.json(await activity.alertDisplayed(req.params.id, req.user))));

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

      db.query("UPDATE room_devices SET last_reading_at=NOW(3), last_seen=NOW(), microphone_seen_at=NOW(3), microphone_state='active' WHERE id=?", [req.device.id], updateError => {
        if (updateError) return res.status(500).json({message:"Device acknowledgement failed"});
        const { updateSensorReading } = require("./lib/devices");
        updateSensorReading(room_id, level, new Date(), status_color);
        res.status(201).json({
        message: "Reading saved successfully",
        reading_id: result.insertId
        });
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
      r.monitoring_enabled,
      COALESCE((SELECT system_enabled FROM system_settings WHERE id=1),FALSE) AS system_enabled,
      (SELECT COUNT(*) FROM room_devices d WHERE d.room_id=r.id) AS registered_devices,
      (SELECT COUNT(*) FROM room_devices d WHERE d.room_id=r.id AND d.enabled=TRUE AND d.last_seen>=DATE_SUB(NOW(),INTERVAL 15 SECOND)) AS connected_devices,
      (SELECT COUNT(*) FROM room_devices d WHERE d.room_id=r.id AND d.enabled=TRUE AND d.last_seen>=DATE_SUB(NOW(),INTERVAL 15 SECOND) AND d.microphone_state IN ('error','blocked')) AS error_devices,
      (SELECT COUNT(*) FROM room_devices d WHERE d.room_id=r.id AND d.enabled=TRUE AND d.microphone_state='active' AND d.microphone_seen_at>=DATE_SUB(NOW(),INTERVAL 15 SECOND) AND d.last_reading_at>=DATE_SUB(NOW(),INTERVAL 15 SECOND)) AS active_devices,
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
        ORDER BY recorded_at DESC, id DESC
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

    res.json(results.map(room=>({...room,device_state:require('./lib/devices').deviceStatus(room)})));
  });
});

// -----------------------------
// Incidents
// -----------------------------

// Get incidents
app.get("/api/incidents", (req, res) => {
  const sql = QUIETSCORE_REPORTS_SQL;
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

    const visible = req.user.role === "library_monitor" ? visibleReports(results, "started_at") : results;
    const formatted = visible.map(
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
          ...incidentAlerts(incident),
          timer_remaining
        };
      }
    );

    res.json(formatted);
  });
});

// Device-originated actions use the existing state machine and transactional activity records.
for (const action of ['state', 'start', 'escalate', 'resolve']) {
  app.post(`/api/incidents/${action}`, asyncRoute(async (req, res) => {
    const result = await activity.monitoring(req, action);
    res.status(result.created ? 201 : 200).json(result);
  }));
}


 // -----------------------------
 // Automatic Student Report Resolution
 // -----------------------------

async function autoResolveStudentReports() {
  try {
    const count = await activity.autoResolve();
    if (count) {
      console.log(`Automatically resolved ${count} student report(s).`);
      access.publish('reports-updated', { changed: true });
    }
    return count;
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      console.error('Error automatically resolving student reports: Database tables are missing (ER_NO_SUCH_TABLE). Run "npm run migrate" to initialize required tables.');
    } else {
      console.error('Error automatically resolving student reports:', error.code || error.message);
    }
    throw error;
  }
}

// Run once when the server starts.
if (require.main === module) autoResolveStudentReports().catch(() => {});

// Check for eligible reports every 60 seconds.
if (require.main === module) setInterval(() => autoResolveStudentReports().catch(() => {}), 60 * 1000);


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

app.use((err, req, res, next) => {
  console.error("Request failed:", err.code || err.message);
  if (res.headersSent) return res.end();
  const status = [400, 401, 403, 404, 409, 413, 429].includes(err.status) ? err.status : 500;
  res.status(status).json({ message: status === 500 ? "Request could not be completed" : err.publicMessage || "Invalid request body" });
});

if (require.main === module) {
  const server = app.listen(PORT);
  server.on("listening", () => {
    console.log(`QuietSpace server running on port ${PORT}`);
  });
  server.on("error", err => {
    console.error(err.code === "EADDRINUSE"
      ? `QuietSpace could not start: port ${PORT} is already in use. Stop the existing server before restarting.`
      : `QuietSpace could not start: ${err.message}`);
    process.exit(1);
  });
}
const { escapeCsvField, buildCsvString } = require("./lib/report-data");
const { sensorRegistry, updateSensorReading, checkHardwareWatchdog, resetSensorRegistry } = require("./lib/devices");
module.exports = {
  app,
  db,
  autoResolveStudentReports,
  escapeCsvField,
  buildCsvString,
  sensorRegistry,
  updateSensorReading,
  checkHardwareWatchdog,
  resetSensorRegistry,
  broadcastSSE,
  sseClients
};
