# QuietSpace

QuietSpace is a real-time study room noise monitoring and reporting system designed for use in library study spaces.

The system monitors room noise levels and displays a simple color-coded QuietScore:

- **Green** — Quiet
- **Yellow** — Warning
- **Red** — Too Loud

Students can also submit noise reports through a QR-code reporting page, while staff can view room activity, student reports, and QuietScore incidents through the staff dashboard.

## Live Frontend Demo

The QuietSpace frontend is deployed using GitHub Pages.

- [Room Noise Display](https://kanyliar.github.io/QuietSpace/webpages/index.html)
- [Student Noise Reporting](https://kanyliar.github.io/QuietSpace/webpages/reportingPage.html)
- [Staff Login](https://kanyliar.github.io/QuietSpace/webpages/login.html)
- [Staff Dashboard](https://kanyliar.github.io/QuietSpace/webpages/dashboard.html)
- [Settings Section](https://kanyliar.github.io/QuietSpace/webpages/settings.html)

> **Note:** This deployment demonstrates the QuietSpace frontend. Features requiring the Node.js/Express backend and MySQL database are not available through the GitHub Pages deployment.

## Project Structure

```text
QuietSpace/
├── database/
│   └── schema.sql
├── images/
├── webpages/
│   ├── dashboard.html
│   ├── index.html
│   ├── login.html
│   ├── QuietScorePage.html
│   └── reportingPage.html
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── server.js
└── sound.py
```

## Technology Stack

### Frontend
- HTML
- CSS
- JavaScript

### Backend
- Node.js
- Express
- MySQL2
- CORS
- dotenv

### Database
- MySQL

### Hardware / Sound Monitoring
- Raspberry Pi
- Microphone input
- Python prototype using `sounddevice` and `numpy`

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/KanyliaR/QuietSpace.git
cd QuietSpace
```

### 2. Install Node.js Dependencies

Make sure Node.js and npm are installed, then run:

```bash
npm install
```

This installs the dependencies listed in `package.json`.

### 3. Create the MySQL Database

Open MySQL Workbench or another MySQL client and run:

```text
database/schema.sql
```

The schema creates the `sound_monitoring` database and the tables required by QuietSpace.

The starter rooms are:

- Room 311
- Room 312
- Room 313

### 4. Configure Environment Variables

Create a `.env` file in the root of the project.

Use `.env.example` as the template:

```env
DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=
PORT=
```

Fill in the values for your local MySQL installation.

Example:

```env
DB_HOST=localhost
DB_USER=your_mysql_username
DB_PASSWORD=your_mysql_password
DB_NAME=sound_monitoring
PORT=3000
```

**Do not commit your `.env` file to GitHub.**

### 5. Start the Server

Run:

```bash
npm start
```

By default, QuietSpace runs on:

```text
http://localhost:3000
```

If a different `PORT` is specified in `.env`, use that port instead.

## Main Pages

### Room Noise Display

```text
http://localhost:3000/
```

Displays the current QuietScore for the study room and contains the microphone-based noise monitoring interface.

### Student Noise Reporting

```text
http://localhost:3000/webpages/reportingPage.html
```

Allows students to submit manual noise reports.

A room can be supplied through the URL query parameter, for example:

```text
http://localhost:3000/webpages/reportingPage.html?room=312
```

### Staff Login

```text
http://localhost:3000/webpages/login.html
```

Provides access to the prototype staff interface.

### Staff Dashboard

```text
http://localhost:3000/webpages/dashboard.html
```

Displays room monitoring information, QuietScore incidents, and student noise reports.

### QuietScore Report History

```text
http://localhost:3000/webpages/QuietScorePage.html
```

Displays historical QuietScore incidents.

## Database Tables

QuietSpace currently uses the following MySQL tables:

- `rooms` — study room information
- `sound_readings` — sound readings and QuietScore states
- `noise_reports` — student-submitted noise reports
- `incidents` — automatic QuietScore incidents
- `staff_users` — structure for staff account information

## API Endpoints

### Noise Reports

```text
POST /api/reports
GET  /api/reports
PUT  /api/reports/:id/status
```

### Sound Readings & Hardware Telemetry

```text
POST /api/readings
GET  /api/readings/latest
GET  /api/hardware/status
POST /api/hardware/heartbeat
POST /api/hardware/watchdog/check
```

### QuietScore Incidents

```text
GET  /api/incidents
POST /api/incidents/start
POST /api/incidents/resolve
POST /api/incidents/escalate
```

### Staff Authentication

```text
POST /api/auth/login
POST /api/auth/register
GET  /api/auth/me
```

### Multi-Room Management

```text
GET  /api/rooms
GET  /api/rooms/:id
POST /api/rooms
PUT  /api/rooms/:id
PUT  /api/rooms/:id/thresholds
PUT  /api/rooms/:id/toggle
```

### Analytics & Administrative Export

```text
GET  /api/analytics/hourly-trends
GET  /api/reports/export/csv
GET  /api/analytics/export/csv
```

### Real-Time Push Events (SSE)

```text
GET  /api/events
```

## Hardware Monitoring & Simulation

QuietSpace supports both physical Raspberry Pi microphone edge nodes and a dedicated multi-room hardware simulator.

### 1. Edge Node Client (`sound.py`)

The edge script samples room audio and transmits real-time decibel measurements to the backend API (`POST /api/readings`):

- **Dual-Mode Operation:** Uses physical USB/I2S microphone capture via `sounddevice` and `numpy` when available, and automatically falls back to simulated audio when audio devices are absent.
- **Acoustic Envelope Analysis:** Differentiates transient impact noise (door slam or dropped book $< 0.8$s) from sustained disturbances ($\ge 0.8$s) to eliminate false red alerts.
- **Fault Detection:** Automatically flags zero-dB stuck microphone states.
- **Fault-Tolerant Transmission:** Incorporates exponential backoff and retry handling if the backend is temporarily unreachable.

Run the edge client:

```bash
# Default mode (Room 1, backend http://localhost:3000)
python sound.py

# Specify room and backend URL
python sound.py --room-id 2 --server-url http://localhost:3000

# Force simulation mode with a specific scenario
python sound.py --simulate --scenario dynamic
```

### 2. Multi-Room Hardware Simulator (`hardware_simulator.py`)

A full-featured simulation CLI designed for testing, multi-room demonstrations, and QA without requiring physical sensor hardware:

- **Concurrent Multi-Room Support:** Simulates arbitrary rooms simultaneously (`--rooms 1,2,3`).
- **8 Acoustic Scenarios:**
  - `quiet`: Ambient study room baseline ($32 - 44$ dB, Green)
  - `murmur`: Whisper / conversational collaborative noise ($52 - 64$ dB, Yellow)
  - `loud`: High sustained noise triggering red incident cycles ($74 - 90$ dB, Red)
  - `transient`: Intermittent transient spikes ($> 80$ dB for $< 0.8$s) testing envelope filtering
  - `escalation`: Cyclic lifecycle demonstrating quiet $\rightarrow$ warning $\rightarrow$ red incident $\rightarrow$ auto-resolution
  - `fault_zero_db`: Stuck zero-dB sensor triggering backend fault detection
  - `fault_disconnect`: Simulates dropped connection testing the 30-second watchdog
  - `dynamic`: Realistic time-varying library room with sinusoidal drift and bursts

Run the simulator:

```bash
# Simulate all 3 library rooms dynamically
python hardware_simulator.py --rooms 1,2,3 --scenario dynamic

# Test incident escalation lifecycle
python hardware_simulator.py --rooms 1 --scenario escalation --interval 1.0

# Test zero-dB fault detection
python hardware_simulator.py --rooms 1 --scenario fault_zero_db

# Dry run locally without sending HTTP packets
python hardware_simulator.py --rooms 1,2,3 --no-transmit
```

### 3. Linux Systemd Service (`quietspace-sensor.service`)

For production deployment on Raspberry Pi OS:

```bash
# Copy unit file to systemd directory
sudo cp quietspace-sensor.service /etc/systemd/system/

# Reload systemd and enable service on boot
sudo systemctl daemon-reload
sudo systemctl enable quietspace-sensor.service
sudo systemctl start quietspace-sensor.service

# Check service status and logs
sudo systemctl status quietspace-sensor.service
journalctl -u quietspace-sensor.service -f
```

### 4. Running the Automated Test Suite

QuietSpace includes 165 automated tests across 11 Jest integration test suites and Python hardware simulation tests:

```bash
# Run all tests (Jest + Python)
npm run test:all

# Run Jest tests only
npm test

# Run Python hardware simulation tests only
npm run test:hardware
```

## Git Workflow

Before beginning work, pull the latest changes:

```bash
git pull
```

After making changes:

```bash
git status
git add .
git commit -m "Describe your changes"
git push
```

Team members should pull the latest version before starting new work to reduce merge conflicts.

## Security

Database credentials and other sensitive environment variables belong in `.env`.

The `.env` file is excluded from Git through `.gitignore` and should never be committed to the repository.

## Current Development Status

QuietSpace is currently under active development as a senior design project.

The current implementation includes:

- Real-time in-room display with physical dBA SPL logarithmic calibration and live SSE threshold sync
- Green, yellow, and red QuietScore states with asymmetric hysteresis and anti-jitter debouncing
- Student QR noise reporting with categorized feedback and severity levels
- Automatic QuietScore incidents with sub-50ms push updates (Server-Sent Events)
- Staff authentication with bcrypt salted password hashing and signed JWT bearer tokens
- Multi-room management REST API with dynamic room creation, threshold sensitivity, and routing
- Multi-room hardware edge node client (`sound.py`) and simulator (`hardware_simulator.py`) with 8 noise scenarios
- Hardware watchdog monitoring with 30-second disconnect detection and zero-dB stuck microphone diagnosis
- 24-hour hourly noise level and incident trend analytics with interactive HTML5 Canvas visualization
- Automated CSV report generation and administrative download for incidents, reports, and hourly trends
- Offline client-side demo fallback (`demo-store.js`) for static or staging presentations
- 179 automated tests across 12 Jest suites and Python unit tests with 100% pass rate