const fs = require('fs');
const path = require('path');
const url = require('url');

/**
 * In-memory Express request dispatcher.
 * Executes express application routes without opening external network sockets,
 * guaranteeing compatibility with isolated sandboxes on developer laptops and Raspberry Pi.
 */
function dispatch(app, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const rawUrl = options.url || '/';
  const parsedUrl = new URL(rawUrl, 'http://localhost');
  const headers = {};

  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      headers[k.toLowerCase()] = v;
    }
  }

  if (options.user && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers['x-quietspace-request']) {
    headers['x-quietspace-request'] = '1';
  }

  if (options.deviceKey) {
    headers['authorization'] = `Bearer ${options.deviceKey}`;
  }

  if (options.body && !headers['content-type'] && typeof options.body === 'object') {
    headers['content-type'] = 'application/json';
  }

  const cookies = options.cookies || {};
  if (options.cookie) {
    headers['cookie'] = options.cookie;
  }

  return new Promise((resolve) => {
    let resolved = false;
    const resHeaders = {};
    let responseBody = null;
    let responseText = '';

    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve({
        statusCode: res.statusCode,
        status: res.statusCode,
        headers: resHeaders,
        body: responseBody,
        text: responseText
      });
    };

    const res = {
      statusCode: 200,
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      locals: {},
      flushHeaders() {
        this.headersSent = true;
        return this;
      },
      setHeader(k, v) {
        resHeaders[k.toLowerCase()] = v;
        return this;
      },
      getHeader(k) {
        return resHeaders[k.toLowerCase()];
      },
      removeHeader(k) {
        delete resHeaders[k.toLowerCase()];
        return this;
      },
      set(k, v) {
        if (typeof k === 'object') {
          for (const [key, val] of Object.entries(k)) this.setHeader(key, val);
          return this;
        }
        return this.setHeader(k, v);
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      type(val) {
        if (val === 'html' || val === 'text/html') this.setHeader('content-type', 'text/html; charset=utf-8');
        else if (val === 'json' || val === 'application/json') this.setHeader('content-type', 'application/json; charset=utf-8');
        else this.setHeader('content-type', val);
        return this;
      },
      cookie(name, val, opts = {}) {
        const parts = [`${name}=${encodeURIComponent(val)}`];
        if (opts.path) parts.push(`Path=${opts.path}`);
        if (opts.httpOnly) parts.push('HttpOnly');
        if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
        this.setHeader('set-cookie', parts.join('; '));
        return this;
      },
      clearCookie(name) {
        this.setHeader('set-cookie', `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
        return this;
      },
      json(data) {
        this.setHeader('content-type', 'application/json; charset=utf-8');
        responseBody = data;
        responseText = JSON.stringify(data);
        this.headersSent = true;
        done();
        return this;
      },
      send(data) {
        if (typeof data === 'object' && !Buffer.isBuffer(data) && data !== null) {
          return this.json(data);
        }
        responseText = String(data ?? '');
        responseBody = data;
        this.headersSent = true;
        done();
        return this;
      },
      sendFile(filePath, opts = {}, cb = null) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          if (filePath.endsWith('.html')) {
            this.setHeader('content-type', 'text/html; charset=utf-8');
          } else if (filePath.endsWith('.js')) {
            this.setHeader('content-type', 'application/javascript; charset=utf-8');
          } else if (filePath.endsWith('.css')) {
            this.setHeader('content-type', 'text/css; charset=utf-8');
          }
          responseText = content;
          responseBody = content;
          this.headersSent = true;
          done();
          if (typeof cb === 'function') cb();
        } catch (err) {
          if (typeof cb === 'function') cb(err);
          else {
            this.statusCode = 404;
            done();
          }
        }
        return this;
      },
      redirect(statusOrUrl, targetUrl) {
        if (typeof statusOrUrl === 'number') {
          this.statusCode = statusOrUrl;
          this.setHeader('location', targetUrl);
        } else {
          this.statusCode = 302;
          this.setHeader('location', statusOrUrl);
        }
        this.headersSent = true;
        done();
        return this;
      },
      write(chunk) {
        if (chunk) {
          responseText += chunk.toString();
          if (responseBody === null) responseBody = responseText;
        }
        return true;
      },
      on(event, cb) {
        if (event === 'drain') setImmediate(cb);
        return this;
      },
      once(event, cb) {
        return this.on(event, cb);
      },
      emit() {
        return true;
      },
      end(data) {
        if (data !== undefined) {
          responseText += String(data);
          if (responseBody === null) responseBody = responseText;
        }
        this.headersSent = true;
        done();
        return this;
      }
    };

    const req = {
      method,
      url: rawUrl,
      originalUrl: rawUrl,
      baseUrl: '',
      destroyed: false,
      on(event, cb) {
        return this;
      },
      once(event, cb) {
        return this;
      },
      emit() {
        return true;
      },
      destroy() {
        this.destroyed = true;
      },
      get path() {
        return (this.url || '').split('?')[0];
      },
      query: Object.fromEntries(parsedUrl.searchParams.entries()),
      headers,
      get(k) {
        return this.headers[k.toLowerCase()];
      },
      header(k) {
        return this.get(k);
      },
      cookies,
      body: options.body || {},
      params: {},
      user: options.user || null,
      device: options.device || null,
      ip: '127.0.0.1',
      ips: [],
      protocol: 'http',
      secure: false,
      socket: {
        remoteAddress: '127.0.0.1',
        destroy() {}
      },
      connection: {
        remoteAddress: '127.0.0.1'
      }
    };

    // If requesting a public webpage or asset file directly, serve it via sendFile
    const cleanPath = (rawUrl || '').split('?')[0];
    const staffPages = ['dashboard.html', 'studentreportspage.html', 'quietscorepage.html', 'analytics.html', 'staff-accounts.html', 'reports.html', 'audit-logs.html', 'settings.html'];
    if (cleanPath.startsWith('/webpages/') && !cleanPath.includes('..')) {
      const filename = cleanPath.slice('/webpages/'.length).toLowerCase();
      if (!staffPages.includes(filename)) {
        const filePath = path.join(__dirname, '..', cleanPath);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          return res.sendFile(filePath);
        }
      }
    }

    try {
      app(req, res, (err) => {
        if (err) {
          res.statusCode = err.status || 500;
          responseBody = { message: err.message || 'Internal Server Error' };
          responseText = JSON.stringify(responseBody);
          done();
        } else {
          done();
        }
      });
    } catch (err) {
      res.statusCode = 500;
      responseBody = { message: err.message };
      responseText = JSON.stringify(responseBody);
      done();
    }
  });
}

/**
 * Universal Mock Database Helper for both callback and promise-based mysql2 queries.
 */
function installMockDb(db, handler) {
  const originalQuery = db.query;
  const mockConn = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: async (sql, params = []) => {
      const res = await handler(sql, params);
      if (Array.isArray(res) && res.length === 2 && Array.isArray(res[1])) {
        return res;
      }
      return [res, []];
    }
  };

  db.__promisePool = {
    getConnection: async () => mockConn,
    query: async (sql, params = []) => {
      const res = await handler(sql, params);
      if (Array.isArray(res) && res.length === 2 && Array.isArray(res[1])) {
        return res;
      }
      return [res, []];
    }
  };

  db.query = (sql, params, callback) => {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    Promise.resolve().then(async () => {
      try {
        const res = await handler(sql, params);
        const rows = Array.isArray(res) && res.length === 2 && Array.isArray(res[1]) ? res[0] : res;
        callback(null, rows);
      } catch (err) {
        callback(err, null);
      }
    });
  };

  return () => {
    delete db.__promisePool;
    db.query = originalQuery;
  };
}

module.exports = { dispatch, installMockDb };
