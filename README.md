# QuietSpace

QuietSpace is a real-time study room noise monitoring and reporting system designed for use in library study spaces.

The system monitors room noise levels and displays a simple color-coded QuietScore:

- **Green** — Quiet
- **Yellow** — Warning
- **Red** — Too Loud

Students can also submit noise reports through a QR-code reporting page, while staff can view room activity, student reports, and QuietScore incidents through the staff dashboard.

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

### Sound Readings

```text
POST /api/readings
GET  /api/readings/latest
```

### QuietScore Incidents

```text
GET  /api/incidents
POST /api/incidents/start
POST /api/incidents/resolve
POST /api/incidents/escalate
```

## Python Sound Prototype

`sound.py` is a standalone microphone testing script used during development of the sound-monitoring functionality.

It requires:

```bash
pip install sounddevice numpy
```

The main QuietSpace web server does **not** require this script to run.

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

- Real-time browser microphone monitoring
- Green, yellow, and red QuietScore states
- Student QR noise reporting
- Automatic QuietScore incidents
- Incident escalation and resolution
- Staff dashboard
- Student report management
- QuietScore incident history
- MySQL data storage

Additional multi-room functionality, hardware integration, analytics, and deployment work are ongoing.