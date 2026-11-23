const { validateThresholds } = require('../utils/helpers');

function installRooms(app, db, { publish, broadcastSSE, requireRoles, ROLES } = {}) {
  const staff = requireRoles && ROLES ? requireRoles(...ROLES) : (req, res, next) => next();

  // Get all rooms
  app.get('/api/rooms', staff, (req, res) => {
    const sql = `
      SELECT
        r.id,
        r.id AS room_id,
        r.room_name,
        r.location,
        COALESCE(r.is_active, 1) AS is_active,
        COALESCE(r.yellow_threshold, 60) AS yellow_threshold,
        COALESCE(r.red_threshold, 75) AS red_threshold,
        r.monitoring_enabled,
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
          ORDER BY recorded_at DESC, id DESC
          LIMIT 1
        )
      ORDER BY r.id
    `;

    db.query(sql, (err, results) => {
      if (err) {
        console.error('Error getting rooms:', err);
        return res.status(500).json({ message: 'Error getting rooms' });
      }

      const rows = Array.isArray(results) ? results : [];
      const formatted = rows.map((room) => ({
        ...room,
        is_active: room.is_active === 0 || room.is_active === false ? 0 : 1,
        yellow_threshold: Number(room.yellow_threshold != null ? room.yellow_threshold : 60),
        red_threshold: Number(room.red_threshold != null ? room.red_threshold : 75)
      }));

      res.json(formatted);
    });
  });

  // Get a specific room by ID
  app.get('/api/rooms/:id', staff, (req, res) => {
    const roomId = req.params.id;
    const sql = `
      SELECT
        r.id,
        r.id AS room_id,
        r.room_name,
        r.location,
        COALESCE(r.is_active, 1) AS is_active,
        COALESCE(r.yellow_threshold, 60) AS yellow_threshold,
        COALESCE(r.red_threshold, 75) AS red_threshold,
        r.monitoring_enabled,
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
          ORDER BY recorded_at DESC, id DESC
          LIMIT 1
        )
      WHERE r.id = ?
    `;

    db.query(sql, [roomId], (err, results) => {
      if (err) {
        console.error('Error getting room:', err);
        return res.status(500).json({ message: 'Error getting room' });
      }

      if (!results || results.length === 0) {
        return res.status(404).json({ message: 'Room not found' });
      }

      const room = {
        ...results[0],
        is_active: results[0].is_active === 0 || results[0].is_active === false ? 0 : 1,
        yellow_threshold: Number(results[0].yellow_threshold != null ? results[0].yellow_threshold : 60),
        red_threshold: Number(results[0].red_threshold != null ? results[0].red_threshold : 75)
      };

      res.json(room);
    });
  });

  // Add a new room
  app.post('/api/rooms', staff, (req, res) => {
    const { room_name, location, is_active, yellow_threshold, red_threshold } = req.body || {};

    if (!room_name || typeof room_name !== 'string' || !room_name.trim()) {
      return res.status(400).json({ message: 'room_name is required' });
    }

    const trimmedName = room_name.trim();
    const loc = location && typeof location === 'string' && location.trim() ? location.trim() : 'Bluford Library';
    const active = is_active === false || is_active === 0 ? 0 : 1;

    const hasThresholds = yellow_threshold !== undefined || red_threshold !== undefined;
    const yThresh = yellow_threshold !== undefined ? Number(yellow_threshold) : 60;
    const rThresh = red_threshold !== undefined ? Number(red_threshold) : 75;

    if (hasThresholds) {
      const validation = validateThresholds(yThresh, rThresh);
      if (!validation.valid) {
        return res.status(400).json({ message: validation.error });
      }
    }

    const sql = hasThresholds
      ? `INSERT INTO rooms (room_name, location, is_active, yellow_threshold, red_threshold) VALUES (?, ?, ?, ?, ?)`
      : `INSERT INTO rooms (room_name, location, is_active) VALUES (?, ?, ?)`;

    const params = hasThresholds
      ? [trimmedName, loc, active, yThresh, rThresh]
      : [trimmedName, loc, active];

    db.query(sql, params, (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ message: 'A room with this name already exists' });
        }
        console.error('Error creating room:', err);
        return res.status(500).json({ message: 'Error creating room' });
      }

      const newRoom = {
        id: result.insertId,
        room_id: result.insertId,
        room_name: trimmedName,
        location: loc,
        is_active: active,
        yellow_threshold: yThresh,
        red_threshold: rThresh
      };

      if (broadcastSSE) broadcastSSE('room_created', newRoom);
      if (publish) publish('room_created', newRoom);

      res.status(201).json({
        message: 'Room created successfully',
        room: newRoom
      });
    });
  });

  // Rename or update an existing room
  app.put('/api/rooms/:id', staff, (req, res) => {
    const roomId = req.params.id;
    const { room_name, location, is_active, yellow_threshold, red_threshold } = req.body || {};

    if (
      room_name === undefined &&
      location === undefined &&
      is_active === undefined &&
      yellow_threshold === undefined &&
      red_threshold === undefined
    ) {
      return res.status(400).json({
        message: 'At least one field (room_name, location, is_active, yellow_threshold, red_threshold) must be provided'
      });
    }

    if (room_name !== undefined && (typeof room_name !== 'string' || !room_name.trim())) {
      return res.status(400).json({ message: 'room_name cannot be empty' });
    }

    if (yellow_threshold !== undefined && red_threshold !== undefined) {
      const val = validateThresholds(yellow_threshold, red_threshold);
      if (!val.valid) return res.status(400).json({ message: val.error });
    }

    const fields = [];
    const values = [];

    if (room_name !== undefined) {
      fields.push('room_name = ?');
      values.push(room_name.trim());
    }
    if (location !== undefined) {
      fields.push('location = ?');
      values.push(location.trim());
    }
    if (is_active !== undefined) {
      fields.push('is_active = ?');
      values.push(is_active ? 1 : 0);
    }
    if (yellow_threshold !== undefined) {
      fields.push('yellow_threshold = ?');
      values.push(Number(yellow_threshold));
    }
    if (red_threshold !== undefined) {
      fields.push('red_threshold = ?');
      values.push(Number(red_threshold));
    }

    values.push(roomId);

    const sql = `UPDATE rooms SET ${fields.join(', ')} WHERE id = ?`;

    db.query(sql, values, (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ message: 'A room with this name already exists' });
        }
        console.error('Error updating room:', err);
        return res.status(500).json({ message: 'Error updating room' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Room not found' });
      }

      const updatedRoom = {
        id: Number(roomId),
        room_id: Number(roomId),
        ...(room_name !== undefined && { room_name: room_name.trim() }),
        ...(location !== undefined && { location: location.trim() }),
        ...(is_active !== undefined && { is_active: is_active ? 1 : 0 }),
        ...(yellow_threshold !== undefined && { yellow_threshold: Number(yellow_threshold) }),
        ...(red_threshold !== undefined && { red_threshold: Number(red_threshold) })
      };

      if (broadcastSSE) broadcastSSE('room_updated', updatedRoom);
      if (publish) publish('room_updated', updatedRoom);

      res.json({
        message: 'Room updated successfully',
        room: updatedRoom,
        changed: result.affectedRows
      });
    });
  });

  // Update noise thresholds for a room
  app.put('/api/rooms/:id/thresholds', staff, (req, res) => {
    const roomId = req.params.id;
    const { yellow_threshold, red_threshold } = req.body || {};

    const validation = validateThresholds(yellow_threshold, red_threshold);
    if (!validation.valid) {
      return res.status(400).json({ message: validation.error });
    }

    const yThresh = Number(yellow_threshold);
    const rThresh = Number(red_threshold);

    const sql = `UPDATE rooms SET yellow_threshold = ?, red_threshold = ? WHERE id = ?`;

    db.query(sql, [yThresh, rThresh, roomId], (err, result) => {
      if (err) {
        console.error('Error updating room thresholds:', err);
        return res.status(500).json({ message: 'Error updating room thresholds' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Room not found' });
      }

      const updatedPayload = {
        id: Number(roomId),
        room_id: Number(roomId),
        yellow_threshold: yThresh,
        red_threshold: rThresh
      };

      if (broadcastSSE) {
        broadcastSSE('thresholds_updated', updatedPayload);
        broadcastSSE('room_updated', updatedPayload);
      }
      if (publish) {
        publish('thresholds_updated', updatedPayload);
        publish('room_updated', updatedPayload);
      }

      res.json({
        message: 'Room thresholds updated successfully',
        room: updatedPayload
      });
    });
  });

  // Toggle room status
  const toggleRoomHandler = (req, res) => {
    const roomId = req.params.id;
    const updateSql = `UPDATE rooms SET is_active = IF(is_active = 1, 0, 1) WHERE id = ?`;

    db.query(updateSql, [roomId], (err, result) => {
      if (err) {
        console.error('Error toggling room status:', err);
        return res.status(500).json({ message: 'Error toggling room status' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Room not found' });
      }

      const selectSql = `SELECT id, room_name, location, is_active FROM rooms WHERE id = ?`;
      db.query(selectSql, [roomId], (selectErr, rows) => {
        const room = rows && rows[0] ? rows[0] : { id: Number(roomId), is_active: 1 };
        const isAct = room.is_active === 0 || room.is_active === false ? 0 : 1;

        const payload = {
          id: Number(roomId),
          room_id: Number(roomId),
          room_name: room.room_name,
          is_active: isAct
        };

        if (broadcastSSE) broadcastSSE('room_updated', payload);
        if (publish) publish('room_updated', payload);

        res.json({
          message: `Room status toggled to ${isAct ? 'active' : 'inactive'}`,
          room: {
            ...room,
            ...payload
          }
        });
      });
    });
  };

  app.patch('/api/rooms/:id/toggle', staff, toggleRoomHandler);
  app.put('/api/rooms/:id/toggle', staff, toggleRoomHandler);
}

module.exports = { installRooms };
