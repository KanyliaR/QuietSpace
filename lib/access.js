const { randomBytes } = require('node:crypto');
const { verifyPassword, digest } = require('./passwords');
const ROLES = ['admin', 'security', 'library_monitor'];
const cookieName = 'quietspace_session';
const { asyncRoute } = require('./http');
const { installEscalations } = require('./escalations');
const { installAccount } = require('./account');
const {MAX_SESSION_HOURS,readPolicy,storedPolicy,validatePolicy,idleClause}=require('./auth-policy');
// Only the local reverse proxy may supply the external HTTPS scheme.
// Keep Host matching and any explicitly configured canonical origin authoritative.
function expectedOrigin(req, configuredOrigin = process.env.APP_ORIGIN) {
  if (configuredOrigin) return configuredOrigin;
  const peer = req.socket.remoteAddress || '';
  const localProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const protocol = localProxy && req.get('x-forwarded-proto') === 'https' ? 'https' : req.protocol;
  return `${protocol}://${req.get('host')}`;
}
function installAccess(app, dbPool, { broadcastSSE } = {}) {
  const db = dbPool.promise ? dbPool.promise() : dbPool;
  const production = process.env.NODE_ENV === 'production';
  if (production && !process.env.APP_ORIGIN?.startsWith('https://')) throw Error('Production requires an HTTPS APP_ORIGIN.');
  const clients = new Set();
  const query = async (sql, args = []) => (await db.query(sql, args))[0];
  const requireRoles = (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Staff sign-in required' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ message: 'Access denied for this role' });
    next();
  };
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: production, path: '/' };
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/') || req.path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin) {
      const expected = expectedOrigin(req);
      if (req.headers.origin !== expected) return res.status(403).json({ message: 'Cross-origin request denied' });
    }
    next();
  });
  app.use(asyncRoute(async (req, res, next) => {
    const token = /(?:^|;\s*)quietspace_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (token) {
      req.sessionHash = digest(token);
      req.authPolicy=await readPolicy(query);
      const users = await query(`SELECT u.id,u.username,u.name,u.role,s.expires_at,s.browser_close_cookie FROM staff_sessions s
        JOIN staff_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>NOW()
        ${idleClause(req.authPolicy)}
        AND u.account_status='active' AND u.setup_complete=TRUE AND u.deleted_at IS NULL
        AND (? = FALSE OR u.is_demo=FALSE)`, [req.sessionHash, production]);
      if (users.length && ROLES.includes(users[0].role)) {
        req.user = users[0];
        if(req.path.endsWith('.html')||req.path==='/calibration/')await query('UPDATE staff_sessions SET last_seen=NOW() WHERE token_hash=?',[req.sessionHash]);
        if(Boolean(req.user.browser_close_cookie)!==req.authPolicy.sessionsExpire)await updateSessionCookie(req,res,token,req.authPolicy);
      } else {
        await query('DELETE FROM staff_sessions WHERE token_hash=?',[req.sessionHash]);
        res.clearCookie(cookieName,cookieOptions);
      }
    }
    next();
  }));
  // Require a custom header for cookie-authenticated API mutations (CSRF defense).
  app.use('/api', asyncRoute(async (req, res, next) => {
    if (req.user && ['POST','PUT','PATCH','DELETE'].includes(req.method) &&
        req.path !== '/reports' && req.get('X-QuietSpace-Request') !== '1') {
      return res.status(403).json({ message: 'Missing request protection header' });
    }
    if(req.user&&['POST','PUT','PATCH','DELETE'].includes(req.method))await query('UPDATE staff_sessions SET last_seen=NOW() WHERE token_hash=?',[req.sessionHash]);
    next();
  }));
  async function updateSessionCookie(req,res,token,policy){
    const remaining=Math.max(0,new Date(req.user.expires_at)-Date.now());
    res.cookie(cookieName,token,{...cookieOptions,...(policy.sessionsExpire?{}:{maxAge:remaining})});
    await query('UPDATE staff_sessions SET browser_close_cookie=? WHERE token_hash=?',[policy.sessionsExpire,req.sessionHash]);
  }
  const attempts = new Map();
  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const username = req.body?.username || req.body?.email;
    const password = req.body?.password;
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password || username.length > 255 || password.length > 256) {
      return res.status(400).json({ message: 'Username and password are required' });
    }
    const ip = req.ip;
    const now = Date.now();
    if (attempts.size > 10000) for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    let counter = attempts.get(ip);
    if (!counter || counter.until < now) attempts.set(ip, counter = { count: 0, until: now + 15 * 60000 });
    if (++counter.count > 30) return res.status(429).json({ message: 'Too many attempts. Try again in 15 minutes.' });
    const users = await query('SELECT * FROM staff_users WHERE username=? OR (username IS NULL AND LOWER(email)=?) ORDER BY (username IS NOT NULL) DESC LIMIT 1', [username.trim(),username.trim().toLowerCase()]);
    const user = users[0];
    // Perform an expensive derivation even for unknown accounts.
    const valid = await verifyPassword(password, user?.password_hash || `scrypt:unknown:${'0'.repeat(128)}`);
    if(!user)return res.status(401).json({message:'Invalid credentials or account temporarily locked'});
    const token = randomBytes(32).toString('hex');
    const connection = await db.getConnection();let policy;
    try {
      await connection.beginTransaction();
      // Shared policy lock precedes account lock, matching the Settings writer's lock order.
      const [[configuration]]=await connection.query('SELECT security_policy FROM system_settings WHERE id=1 FOR SHARE');
      policy=storedPolicy(configuration.security_policy);
      const [[current]]=await connection.query('SELECT *, (locked_until>NOW()) currently_locked,(locked_until IS NOT NULL AND locked_until<=NOW()) lockout_expired FROM staff_users WHERE id=? FOR UPDATE',[user.id]);
      if(current?.lockout_expired&&await require('./lockout-audit').expireLockedAccount(connection,current)){current.locked_until=null;current.failed_attempts=0;current.currently_locked=0;}
      const allowed=current&&current.account_status==='active'&&!current.deleted_at&&current.setup_complete&&ROLES.includes(current.role)&&!(production&&current.is_demo);
      const locked=policy.lockoutTime&&Boolean(current?.currently_locked);
      if(!allowed||!valid||locked||current.password_hash!==user.password_hash||current.role!==user.role){
        if(allowed&&!valid&&policy.lockoutTime&&!locked){
          const count=(current.locked_until?0:Number(current.failed_attempts))+1;
          await connection.query('UPDATE staff_users SET failed_attempts=?,locked_until=IF(? >= ?,DATE_ADD(NOW(),INTERVAL ? MINUTE),NULL) WHERE id=?',[count,count,policy.maxLoginAttempts,policy.lockoutMinutes,user.id]);
          if(count>=policy.maxLoginAttempts)await require('./lockout-audit').lockoutEvent(connection,current,'account_locked');
        }
        await connection.commit();return res.status(401).json({message:'Invalid credentials or account temporarily locked'});
      }
      await connection.query('UPDATE staff_users SET failed_attempts=0,locked_until=NULL WHERE id=?',[user.id]);
      if(req.sessionHash)await connection.query('DELETE FROM staff_sessions WHERE token_hash=?',[req.sessionHash]);
      await connection.query(`INSERT INTO staff_sessions (token_hash,user_id,expires_at,browser_close_cookie) VALUES (?,?,DATE_ADD(NOW(),INTERVAL ${MAX_SESSION_HOURS} HOUR),?)`,[digest(token),user.id,policy.sessionsExpire]);
      await require('./audit').appendAudit(connection,{actor:user,category:'system',action:'signed_in',description:'Signed in',entity:'staff_account',id:user.id});
      await connection.commit();
    }catch(error){await connection.rollback();throw error;}finally{connection.release();}
    res.cookie(cookieName,token,{...cookieOptions,...(policy.sessionsExpire?{}:{maxAge:MAX_SESSION_HOURS*3600000})});
    res.json({ id: user.id, username: user.username, role: user.role });
  }));
  app.get('/api/auth/me', requireRoles(...ROLES), (req, res) => res.json(req.user));
  app.post('/api/auth/activity',requireRoles(...ROLES),(req,res)=>res.json({active:true}));
  app.post('/api/auth/logout', asyncRoute(async (req, res) => {
    if (req.sessionHash) {
      const c=await db.getConnection();
      try {
        await c.beginTransaction();
        const [removed]=await c.query('DELETE FROM staff_sessions WHERE token_hash=?',[req.sessionHash]);
        if(removed.affectedRows&&req.user)await require('./audit').appendAudit(c,{actor:req.user,category:'system',action:'signed_out',description:'Signed out',entity:'staff_account',id:req.user.id});
        await c.commit();
      }catch(e){await c.rollback();throw e;}finally{c.release();}
      for (const client of clients) if (client.hash === req.sessionHash) client.res.end();
    }
    res.clearCookie(cookieName, cookieOptions);
    res.json({ message: 'Signed out' });
  }));
  const stream = securityOnly => asyncRoute(async (req, res) => {
    if(req.destroyed||res.destroyed)return;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.flushHeaders();
    const client = { res, user: req.user, hash: req.sessionHash };
    // A room stream never receives Security events.
    client.securityOnly = securityOnly;
    clients.add(client);
    res.write(': connected\n\n');
    let checking = false;
    const timer = setInterval(async () => {
      if(res.destroyed||res.writableEnded||req.socket.destroyed){cleanup();return;}
      if (checking) return;
      checking = true;
      try {
        const policy=await readPolicy(query);
        const sessions = await query(`SELECT u.role FROM staff_sessions s JOIN staff_users u ON u.id=s.user_id
          WHERE s.token_hash=? AND s.expires_at>NOW() ${idleClause(policy)}
          AND u.account_status='active' AND u.setup_complete=TRUE AND u.deleted_at IS NULL
        AND (? = FALSE OR u.is_demo=FALSE)`, [client.hash, production]);
        if (!sessions.length || sessions[0].role !== client.user.role) {await query('DELETE FROM staff_sessions WHERE token_hash=?',[client.hash]);cleanup();return res.end();}
        if(res.destroyed||res.writableEnded){cleanup();return;}
        res.write(': heartbeat\n\n');
      } catch { cleanup();res.end(); } finally { checking = false; }
    }, 15000);
    timer.unref();
    const cleanup=()=>{clearInterval(timer);clients.delete(client);};
    req.once('close',cleanup);res.once('close',cleanup);
    if(req.destroyed||res.destroyed)cleanup();
  });
  // Filter stream type as well as role; no Security payload can reach the room stream.
  const publish = (type, data, securityOnly = false, ownerId = null) => {
    if (broadcastSSE) broadcastSSE(type, data);
    for (const client of clients) if (!client.res.destroyed && !client.res.writableEnded && client.securityOnly === securityOnly && (!securityOnly || client.user.role === 'security') && (!ownerId || client.user.id === ownerId)) {
      client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  app.get('/api/events', requireRoles(...ROLES), stream(false));
  app.get('/api/security/events', requireRoles('security'), stream(true));
  const { installRooms } = require('./rooms');
  installRooms(app, dbPool, { publish, broadcastSSE, requireRoles, ROLES });
  require('./audit').installAdministration(app, { db, query, requireRoles, publish });
  app.get('/api/settings', requireRoles('admin'), asyncRoute(async (req, res) => {
    const rows = await query('SELECT * FROM system_settings WHERE id=1');
    res.json({...rows[0],security_policy:storedPolicy(rows[0].security_policy)});
  }));
  app.put('/api/settings', requireRoles('admin'), asyncRoute(async (req, res) => {
    const settings = req.body;
    if (!settings || Array.isArray(settings) || !Number.isFinite(settings.yellowThreshold) || !Number.isFinite(settings.redThreshold) ||
        settings.yellowThreshold < 0 || settings.redThreshold <= settings.yellowThreshold || settings.redThreshold > 200) {
      return res.status(400).json({ message: 'Invalid noise thresholds' });
    }
    const nextPolicy=settings.securityPolicy===undefined?null:validatePolicy(settings.securityPolicy);
    const staffSettings={...settings};delete staffSettings.securityPolicy;
    // Legacy flat fields remain non-authoritative; only the validated policy controls authentication.
    const c=await db.getConnection();
    try {await c.beginTransaction();
      const [[row]]=await c.query('SELECT staff_settings,security_policy FROM system_settings WHERE id=1 FOR UPDATE');
      const before=typeof row.staff_settings==='string'?JSON.parse(row.staff_settings):row.staff_settings||{};
      const meaningful=value=>JSON.stringify(Object.keys(value).filter(k=>k!=='lastSaved').sort().map(k=>[k,value[k]]));
      if(meaningful(before)!==meaningful(staffSettings)) {
        await c.query('UPDATE system_settings SET staff_settings=? WHERE id=1',[JSON.stringify(staffSettings)]);
        const thresholds=(before.yellowThreshold??10)!==settings.yellowThreshold||(before.redThreshold??17)!==settings.redThreshold;
        await require('./audit').appendAudit(c,{actor:req.user,category:thresholds?'thresholds':'system',action:thresholds?'thresholds_changed':'settings_changed',description:thresholds?'Noise thresholds changed':'System settings saved',entity:'system',id:1,previous:{...before,yellowThreshold:before.yellowThreshold??10,redThreshold:before.redThreshold??17},next:settings});
      }
      if(nextPolicy){
        const previous=storedPolicy(row.security_policy);
        if(JSON.stringify(previous)!==JSON.stringify(nextPolicy)){
          await c.query('UPDATE system_settings SET security_policy=? WHERE id=1',[JSON.stringify(nextPolicy)]);
          if(previous.lockoutTime!==nextPolicy.lockoutTime){
            const [affected]=await c.query('SELECT id,name,(locked_until<=NOW()) expired FROM staff_users WHERE locked_until IS NOT NULL ORDER BY id FOR UPDATE');
            for(const account of affected){if(account.expired)await require('./lockout-audit').expireLockedAccount(c,account);else await require('./lockout-audit').lockoutEvent(c,account,'account_lockout_cleared',req.user);}
            await c.query('UPDATE staff_users SET failed_attempts=0,locked_until=NULL WHERE failed_attempts<>0 OR locked_until IS NOT NULL');
          }
          await require('./audit').appendAudit(c,{actor:req.user,category:'system',action:'security_policy_changed',description:'Security and login policies changed',entity:'system',id:1,previous,next:nextPolicy});
        }
      }
      await c.commit();
    }catch(e){await c.rollback();throw e;}finally{c.release();}
    if(nextPolicy){const token=/(?:^|;\s*)quietspace_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];if(token)await updateSessionCookie(req,res,token,nextPolicy);}
    publish('settings', { changed: true });
    res.json({ message: 'Settings saved' });
  }));
  installAccount(app, { db, query, requireRoles, onPasswordChanged: (userId, currentHash) => {
    for (const client of clients) if (client.user.id === userId && client.hash !== currentHash) client.res.end();
  } });
  require('./staff-management').installStaffManagement(app, { db, query, requireRoles, onAccessChanged: userId => {
    for (const client of clients) if (client.user.id === userId) client.res.end();
  } });
  installEscalations(app, { db, query, requireRoles, publish });
  require('./analytics').installAnalytics(app, { query, requireRoles });
  require('./report-notifications').installReportNotifications(app, { db, requireRoles, publish });
  const deviceAuth = require('./devices').installDevices(app, { query, production, publish });

  const { calculateHourlyTrends, formatHourlyTrends } = require('./analytics');
  const { generateCsvReport } = require('./report-data');

  app.get('/api/analytics/hourly-trends', requireRoles('admin', 'security'), asyncRoute(async (req, res) => {
    try {
      const trends = await calculateHourlyTrends(query, req.query);
      if (req.query.format === 'object') {
        return res.json(formatHourlyTrends(trends, req.query));
      }
      res.json(trends);
    } catch (err) {
      console.error('Error fetching hourly analytics trends:', err);
      res.status(500).json({ message: 'Error fetching hourly analytics trends' });
    }
  }));

  app.get(['/api/reports/export/csv', '/api/analytics/export/csv'], requireRoles('admin', 'security'), asyncRoute(async (req, res) => {
    try {
      const { csv, filename } = await generateCsvReport(query, req.query);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.status(200).send(csv);
    } catch (err) {
      console.error('Error exporting CSV report:', err);
      res.status(500).json({ message: 'Error exporting CSV report' });
    }
  }));

  app.use('/api', (req, res, next) => {
    // The public QR report POST and device-controlled mutations are the only unauthenticated exceptions.
    const route = req.path;
    if (/^\/rooms(\/.*)?$/.test(route)) return next();
    if (req.method === 'POST' && route === '/reports') return next();
    if (req.method === 'POST' && ['/readings','/incidents/state','/incidents/start','/incidents/resolve','/incidents/escalate'].includes(route)) {
      return deviceAuth(req, res, asyncRoute(async () => {
        if (req.body.room_id != null && Number(req.body.room_id) !== req.device.room_id) return res.status(403).json({ message: 'Device is bound to another room' });
        if (!req.device.monitoring_enabled) return res.status(409).json({ message: 'Monitoring Disabled' });
        next();
      }));
    }
    if (req.method === 'GET' && /^\/(reports|incidents)\/\d+\/activity$/.test(route)) return requireRoles('admin','security')(req, res, next);
    if (req.method === 'POST' && /^\/incidents\/\d+\/alert-displayed$/.test(route)) return requireRoles(...ROLES)(req, res, next);
    if (req.method === 'GET' && route === '/readings/latest') return requireRoles(...ROLES)(req, res, next);
    if (req.method === 'GET' && route === '/reports') return requireRoles(...ROLES)(req, res, next);
    if (req.method === 'GET' && route === '/incidents') return requireRoles(...ROLES)(req, res, next);
    if (req.method === 'PUT' && /^\/reports\/\d+\/status$/.test(route)) return requireRoles(...ROLES)(req, res, next);
    return res.status(404).json({ message: 'Route not found' });
  });
  return { requireRoles, publish, query };
}
module.exports = { installAccess, asyncRoute, expectedOrigin };
