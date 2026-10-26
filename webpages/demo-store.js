/**
 * QuietSpace Unified Data & Storage Layer (demo-store.js)
 * 
 * Provides robust, resilient data synchronization across QuietSpace:
 * 1. Live Node.js + MySQL Mode: Communicates with backend REST API and SSE stream
 *    when running locally (localhost:3000) or when a custom cloud API URL is configured.
 * 2. Client-Side Demo Mode: Automatically activates on GitHub Pages (https://*.github.io)
 *    or when the backend is unreachable. Uses localStorage with realistic starter data
 *    for rooms, sound readings, student noise reports, and QuietScore incidents.
 * 3. Cross-Tab Synchronization: Broadcasts updates across open tabs (Settings, Dashboard,
 *    In-Room Display, Student Reporting) via window storage events.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QuietSpaceStore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_ROOMS = 'quietspace_demo_rooms';
  const STORAGE_REPORTS = 'quietspace_demo_reports';
  const STORAGE_INCIDENTS = 'quietspace_demo_incidents';
  const STORAGE_CUSTOM_API = 'quietspace_custom_api_url';
  const STORAGE_SYNC_EVENT = 'quietspace_sync_ping';

  const DEFAULT_ROOMS = [
    {
      id: 1,
      room_name: 'Room 311',
      location: 'Bluford Library 3rd Floor',
      is_active: 1,
      level: 46,
      status_color: 'green',
      quiet_score: 95,
      recorded_at: new Date().toISOString()
    },
    {
      id: 2,
      room_name: 'Room 312',
      location: 'Bluford Library 3rd Floor',
      is_active: 1,
      level: 42,
      status_color: 'green',
      quiet_score: 98,
      recorded_at: new Date().toISOString()
    },
    {
      id: 3,
      room_name: 'Room 313',
      location: 'Bluford Library 3rd Floor',
      is_active: 1,
      level: 53,
      status_color: 'yellow',
      quiet_score: 81,
      recorded_at: new Date().toISOString()
    }
  ];

  function getSeedReports() {
    const now = Date.now();
    return [
      {
        id: 1,
        room_id: 1,
        room_name: 'Room 311',
        noise_type: 'talking',
        severity: 'medium',
        comments: 'Group conversation getting loud near the study pods',
        report_status: 'open',
        submitted_at: new Date(now - 12 * 60 * 1000).toISOString()
      },
      {
        id: 2,
        room_id: 3,
        room_name: 'Room 313',
        noise_type: 'music',
        severity: 'low',
        comments: 'Headphone sound leakage audible across the room',
        report_status: 'in_review',
        submitted_at: new Date(now - 46 * 60 * 1000).toISOString()
      },
      {
        id: 3,
        room_id: 2,
        room_name: 'Room 312',
        noise_type: 'phone_call',
        severity: 'high',
        comments: 'Speakerphone call ongoing in quiet study area',
        report_status: 'resolved',
        submitted_at: new Date(now - 2 * 60 * 60 * 1000).toISOString()
      }
    ];
  }

  function getSeedIncidents() {
    const now = Date.now();
    const d = new Date();
    const curYear = d.getFullYear();
    const curMonth = d.getMonth();
    return [
      {
        id: 1,
        room_id: 3,
        room_name: 'Room 313',
        status: 'open',
        escalation_count: 2,
        timer_started_at: new Date(now - 45 * 1000).toISOString(),
        started_at: new Date(now - 45 * 1000).toISOString()
      },
      {
        id: 2,
        room_id: 1,
        room_name: 'Room 311',
        status: 'resolved',
        escalation_count: 1,
        timer_started_at: new Date(now - 35 * 60 * 1000).toISOString(),
        started_at: new Date(now - 35 * 60 * 1000).toISOString()
      },
      {
        id: 3,
        room_id: 2,
        room_name: 'Room 312',
        status: 'resolved',
        escalation_count: 3,
        timer_started_at: new Date(curYear, curMonth, Math.max(1, d.getDate() - 2), 14, 20).toISOString(),
        started_at: new Date(curYear, curMonth, Math.max(1, d.getDate() - 2), 14, 20).toISOString()
      },
      {
        id: 4,
        room_id: 3,
        room_name: 'Room 313',
        status: 'resolved',
        escalation_count: 1,
        timer_started_at: new Date(curYear, curMonth, Math.max(1, d.getDate() - 5), 10, 15).toISOString(),
        started_at: new Date(curYear, curMonth, Math.max(1, d.getDate() - 5), 10, 15).toISOString()
      }
    ];
  }

  // Determine if running on GitHub Pages or static host
  function isGitHubPages() {
    if (typeof window === 'undefined') return false;
    const host = window.location.hostname.toLowerCase();
    const isHttps = window.location.protocol === 'https:';
    return host.endsWith('github.io') || (isHttps && host !== 'localhost' && host !== '127.0.0.1');
  }

  // Get effective API base URL
  function getApiBase() {
    if (typeof window === 'undefined') return '';
    try {
      const custom = localStorage.getItem(STORAGE_CUSTOM_API);
      if (custom && custom.trim()) {
        return custom.trim().replace(/\/+$/, '');
      }
    } catch (e) {}

    // When running locally on port 3000
    if ((window.location.protocol === 'http:' || window.location.protocol === 'https:') && window.location.port === '3000') {
      return '';
    }

    // When running locally on another port (e.g. VS Code Live Server on 5500)
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return 'http://localhost:3000';
    }

    // When on GitHub Pages without a custom HTTPS backend URL:
    // Return null to avoid mixed-content blocking (HTTPS -> HTTP:localhost)
    return null;
  }

  function setCustomApiUrl(url) {
    if (!url || !url.trim()) {
      localStorage.removeItem(STORAGE_CUSTOM_API);
    } else {
      localStorage.setItem(STORAGE_CUSTOM_API, url.trim().replace(/\/+$/, ''));
    }
    broadcastSync('api_url_changed');
  }

  function getCustomApiUrl() {
    try {
      return localStorage.getItem(STORAGE_CUSTOM_API) || '';
    } catch (e) {
      return '';
    }
  }

  // Broadcast sync event to other open tabs
  function broadcastSync(type, payload) {
    if (typeof window === 'undefined') return;
    try {
      const message = { type, payload, timestamp: Date.now() };
      localStorage.setItem(STORAGE_SYNC_EVENT, JSON.stringify(message));
      window.dispatchEvent(new CustomEvent('quietspace:sync', { detail: message }));
    } catch (e) {}
  }

  // ----------------------------------------------------
  // LocalStorage Helpers
  // ----------------------------------------------------
  function readLocal(key, defaultData) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        localStorage.setItem(key, JSON.stringify(defaultData));
        return defaultData;
      }
      return JSON.parse(raw);
    } catch (e) {
      console.warn(`Error reading ${key} from localStorage:`, e);
      return defaultData;
    }
  }

  function writeLocal(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      console.error(`Error saving ${key} to localStorage:`, e);
    }
  }

  // Ensure default seeds are present
  function ensureSeeds() {
    if (typeof window === 'undefined') return;
    try {
      if (!localStorage.getItem(STORAGE_ROOMS)) {
        writeLocal(STORAGE_ROOMS, DEFAULT_ROOMS);
      }
      if (!localStorage.getItem(STORAGE_REPORTS)) {
        writeLocal(STORAGE_REPORTS, getSeedReports());
      }
      if (!localStorage.getItem(STORAGE_INCIDENTS)) {
        writeLocal(STORAGE_INCIDENTS, getSeedIncidents());
      }
    } catch (e) {}
  }

  ensureSeeds();

  // ----------------------------------------------------
  // Room Management API & Demo Fallback
  // ----------------------------------------------------
  async function getRooms() {
    ensureSeeds();
    const api = getApiBase();
    if (api !== null) {
      try {
        const res = await fetch(`${api}/api/rooms?t=${Date.now()}`);
        if (res.ok) {
          const rooms = await res.json();
          writeLocal(STORAGE_ROOMS, rooms);
          return { rooms, source: 'database' };
        }
      } catch (err) {
        console.warn('Backend /api/rooms unreachable, falling back to local storage:', err.message);
      }
    }
    const local = readLocal(STORAGE_ROOMS, DEFAULT_ROOMS);
    return { rooms: local, source: 'demo' };
  }

  async function addRoom(roomName, location) {
    ensureSeeds();
    const api = getApiBase();
    if (api !== null) {
      try {
        const res = await fetch(`${api}/api/rooms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room_name: roomName, location: location || 'Bluford Library 3rd Floor' })
        });
        const data = await res.json();
        if (res.ok) {
          broadcastSync('room_added', data.room);
          return { success: true, room: data.room, source: 'database' };
        }
        throw new Error(data.message || 'Failed to add room');
      } catch (err) {
        if (err.message && !err.message.includes('fetch') && !err.message.includes('NetworkError')) {
          throw err;
        }
        console.warn('Backend unreachable for room creation, adding to local storage.');
      }
    }

    // Local storage fallback
    const rooms = readLocal(STORAGE_ROOMS, DEFAULT_ROOMS);
    const maxId = rooms.reduce((max, r) => Math.max(max, Number(r.id || r.room_id || 0)), 0);
    const newRoom = {
      id: maxId + 1,
      room_name: roomName.trim(),
      location: (location || 'Bluford Library 3rd Floor').trim(),
      is_active: 1,
      level: 45,
      status_color: 'green',
      quiet_score: 95,
      recorded_at: new Date().toISOString()
    };
    rooms.push(newRoom);
    writeLocal(STORAGE_ROOMS, rooms);
    broadcastSync('room_added', newRoom);
    return { success: true, room: newRoom, source: 'demo' };
  }

  async function updateRoom(roomId, updates) {
    ensureSeeds();
    const api = getApiBase();
    const id = Number(roomId);
    if (api !== null) {
      try {
        const res = await fetch(`${api}/api/rooms/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
        });
        const data = await res.json();
        if (res.ok) {
          broadcastSync('room_updated', data.room);
          return { success: true, room: data.room, source: 'database' };
        }
        throw new Error(data.message || 'Failed to update room');
      } catch (err) {
        if (err.message && !err.message.includes('fetch') && !err.message.includes('NetworkError')) {
          throw err;
        }
        console.warn('Backend unreachable for room update, updating local storage.');
      }
    }

    // Local storage fallback
    const rooms = readLocal(STORAGE_ROOMS, DEFAULT_ROOMS);
    const room = rooms.find(r => (r.id || r.room_id) === id);
    if (!room) throw new Error('Room not found');

    if (updates.room_name !== undefined) room.room_name = updates.room_name.trim();
    if (updates.location !== undefined) room.location = updates.location.trim();
    if (updates.is_active !== undefined) room.is_active = updates.is_active ? 1 : 0;

    writeLocal(STORAGE_ROOMS, rooms);
    broadcastSync('room_updated', room);
    return { success: true, room, source: 'demo' };
  }

  async function toggleRoomStatus(roomId) {
    ensureSeeds();
    const api = getApiBase();
    const id = Number(roomId);
    if (api !== null) {
      try {
        const res = await fetch(`${api}/api/rooms/${id}/toggle`, { method: 'PATCH' });
        const data = await res.json();
        if (res.ok) {
          broadcastSync('room_toggled', data.room);
          return { success: true, room: data.room, source: 'database' };
        }
        throw new Error(data.message || 'Failed to toggle room status');
      } catch (err) {
        if (err.message && !err.message.includes('fetch') && !err.message.includes('NetworkError')) {
          throw err;
        }
        console.warn('Backend unreachable for room toggle, updating local storage.');
      }
    }

    // Local storage fallback
    const rooms = readLocal(STORAGE_ROOMS, DEFAULT_ROOMS);
    const room = rooms.find(r => (r.id || r.room_id) === id);
    if (!room) throw new Error('Room not found');

    const currentlyActive = room.is_active !== 0 && room.is_active !== false;
    room.is_active = currentlyActive ? 0 : 1;

    writeLocal(STORAGE_ROOMS, rooms);
    broadcastSync('room_toggled', room);
    return { success: true, room, source: 'demo' };
  }

  // ----------------------------------------------------
  // Reports API & Demo Fallback
  // ----------------------------------------------------
  async function getReports() {
    ensureSeeds();
    const api = getApiBase();
    if (api !== null) {
      try {
        const res = await fetch(`${api}/api/reports?t=${Date.now()}`);
        if (res.ok) {
          const reports = await res.json();
          writeLocal(STORAGE_REPORTS, reports);
          return { reports, source: 'database' };
        }
      } catch (err) {
        console.warn('Backend /api/reports unreachable, falling back to local storage.');
      }
    }
    const local = readLocal(STORAGE_REPORTS, getSeedReports());
    return { reports: local, source: 'demo' };
  }

  async function addReport(reportData) {
    ensureSeeds();
    const api = getApiBase();
    if (api !== null) {
      try {
        const res = await fetch(`${api}/api/reports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reportData)
        });
        if (res.ok) {
          const data = await res.json();
          broadcastSync('report_created', data);
          return { success: true, report: data, source: 'database' };
        }
      } catch (err) {
        console.warn('Backend unreachable for report submission, saving to local storage.');
      }
    }

    // Local storage fallback
    const reports = readLocal(STORAGE_REPORTS, getSeedReports());
    const rooms = readLocal(STORAGE_ROOMS, DEFAULT_ROOMS);
    const matchedRoom = rooms.find(r => (r.id || r.room_id) === Number(reportData.room_id));
    const roomName = matchedRoom ? matchedRoom.room_name : `Room ${reportData.room_id}`;

    const newReport = {
      id: Date.now(),
      room_id: Number(reportData.room_id),
      room_name: roomName,
      noise_type: reportData.noise_type || 'unspecified',
      severity: reportData.severity || 'low',
      comments: reportData.comments || '',
      report_status: 'open',
      submitted_at: new Date().toISOString()
    };
    reports.unshift(newReport);
    writeLocal(STORAGE_REPORTS, reports);
    broadcastSync('report_created', newReport);
    return { success: true, report: newReport, source: 'demo' };
  }

  async function updateReportStatus(reportId, newStatus) {
    ensureSeeds();
    const api = getApiBase();
    const id = Number(reportId);
    if (api !== null) {
      try {
        const res = await fetch(`${api}/api/reports/${id}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ report_status: newStatus })
        });
        if (res.ok) {
          broadcastSync('report_status_updated', { id, report_status: newStatus });
          return { success: true, source: 'database' };
        }
      } catch (err) {
        console.warn('Backend unreachable for report status update, updating local storage.');
      }
    }

    // Local storage fallback
    const reports = readLocal(STORAGE_REPORTS, getSeedReports());
    const target = reports.find(r => r.id === id);
    if (target) {
      target.report_status = newStatus;
      writeLocal(STORAGE_REPORTS, reports);
      broadcastSync('report_status_updated', { id, report_status: newStatus });
    }
    return { success: true, source: 'demo' };
  }

  // ----------------------------------------------------
  // Incidents API & Demo Fallback
  // ----------------------------------------------------
  async function getIncidents() {
    ensureSeeds();
    const api = getApiBase();
    if (api !== null) {
      try {
        const res = await fetch(`${api}/api/incidents?t=${Date.now()}`);
        if (res.ok) {
          const incidents = await res.json();
          writeLocal(STORAGE_INCIDENTS, incidents);
          return { incidents, source: 'database' };
        }
      } catch (err) {
        console.warn('Backend /api/incidents unreachable, falling back to local storage.');
      }
    }
    const local = readLocal(STORAGE_INCIDENTS, getSeedIncidents());
    return { incidents: local, source: 'demo' };
  }

  // Check if current page is in demo mode
  function getMode() {
    const api = getApiBase();
    if (api === null || isGitHubPages()) {
      return 'demo';
    }
    return 'live';
  }

  return {
    isGitHubPages,
    getApiBase,
    setCustomApiUrl,
    getCustomApiUrl,
    getMode,
    getRooms,
    addRoom,
    updateRoom,
    toggleRoomStatus,
    getReports,
    addReport,
    updateReportStatus,
    getIncidents,
    broadcastSync
  };
});
