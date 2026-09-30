CREATE DATABASE IF NOT EXISTS sound_monitoring;
USE sound_monitoring;

-- -----------------------------------------------------
-- Rooms
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS rooms (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    room_name VARCHAR(100) NOT NULL,
    location VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_rooms_name (room_name)
);


-- -----------------------------------------------------
-- Staff Users
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_staff_email (email)
);


-- -----------------------------------------------------
-- Sound Readings
-- Stores sound readings submitted by QuietSpace displays
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS sound_readings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    room_id INT UNSIGNED NOT NULL,
    level DECIMAL(6,2) NOT NULL COMMENT 'Sound level in dB',
    quiet_score VARCHAR(50) DEFAULT NULL,
    status_color ENUM('green', 'yellow', 'red') NOT NULL DEFAULT 'green',
    recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),

    KEY idx_sound_room_time (room_id, recorded_at),

    CONSTRAINT fk_sound_room
        FOREIGN KEY (room_id)
        REFERENCES rooms(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);


-- -----------------------------------------------------
-- Student Noise Reports
-- Stores reports submitted through the QR reporting page
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS noise_reports (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    room_id INT UNSIGNED NOT NULL,
    noise_type VARCHAR(100) NOT NULL,
    severity ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'medium',
    comments TEXT,
    report_status VARCHAR(50) NOT NULL DEFAULT 'open',
    submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),

    KEY idx_reports_room_time (room_id, submitted_at),

    CONSTRAINT fk_report_room
        FOREIGN KEY (room_id)
        REFERENCES rooms(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);


-- -----------------------------------------------------
-- QuietScore Incidents
-- Stores automatic incidents created when a room enters
-- the red noise state
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS incidents (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    room_id INT UNSIGNED NOT NULL,
    trigger_level VARCHAR(20) NOT NULL,
    status ENUM(
        'open',
        'resolved',
        'needs_staff_attention'
    ) NOT NULL DEFAULT 'open',
    escalation_count INT UNSIGNED NOT NULL DEFAULT 0,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME DEFAULT NULL,
    timer_started_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),

    KEY idx_incidents_room_status (room_id, status),

    CONSTRAINT fk_incident_room
        FOREIGN KEY (room_id)
        REFERENCES rooms(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);


-- -----------------------------------------------------
-- Starter Rooms
-- -----------------------------------------------------

INSERT IGNORE INTO rooms (id, room_name, location) VALUES
    (1, 'Room 311', 'Bluford Library 3rd Floor'),
    (2, 'Room 312', 'Bluford Library 3rd Floor'),
    (3, 'Room 313', 'Bluford Library 3rd Floor');