const { asyncRoute } = require('./http');
const { hashPassword, verifyPassword } = require('./passwords');
function installAccount(app, { db, query, requireRoles, onPasswordChanged }) {
  const staff = requireRoles('admin','security','library_monitor');
  const attempts = new Map();
  app.get('/api/account', staff, asyncRoute(async (req, res) => {
    const rows = await query('SELECT id,username,name,email,role,created_at FROM staff_users WHERE id=?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ message: 'Account not found' });
    res.json(rows[0]);
  }));
  app.put('/api/account/password', staff, asyncRoute(async (req, res) => {
    const { current_password, new_password } = req.body;
    if (Object.keys(req.body).some(key => !['current_password','new_password'].includes(key)) ||
      typeof current_password !== 'string' || !current_password || current_password.length > 256 ||
      typeof new_password !== 'string' || new_password.trim().length < 12 || new_password.length > 256 || current_password === new_password) {
      return res.status(400).json({ message: 'Provide your current password and a different new password of 12–256 characters' });
    }
    const now = Date.now();
    for (const [id, value] of attempts) if (value.until <= now) attempts.delete(id);
    const counter = attempts.get(req.user.id) || { count: 0, until: now + 15 * 60000 };
    if (counter.count >= 5) return res.status(429).json({ message: 'Too many password verification attempts. Try again in 15 minutes.' });
    attempts.set(req.user.id, counter);
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query('SELECT password_hash FROM staff_users WHERE id=? FOR UPDATE', [req.user.id]);
      if (!rows.length || !await verifyPassword(current_password, rows[0].password_hash)) {
        counter.count++;
        await connection.rollback();
        return res.status(401).json({ message: 'Current password is incorrect' });
      }
      const passwordHash = await hashPassword(new_password);
      await connection.query('UPDATE staff_users SET password_hash=? WHERE id=?', [passwordHash, req.user.id]);
      await connection.query('DELETE FROM staff_sessions WHERE user_id=? AND token_hash<>?', [req.user.id, req.sessionHash]);
      await connection.commit();
      attempts.delete(req.user.id);
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    onPasswordChanged(req.user.id, req.sessionHash);
    res.json({ message: 'Password changed. Other sessions have been signed out.' });
  }));
}
module.exports = { installAccount };
