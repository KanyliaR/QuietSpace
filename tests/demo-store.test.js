const QuietSpaceStore = require('../webpages/demo-store.js');

describe('QuietSpaceStore Client-Side Demo Layer', () => {
  beforeEach(() => {
    // Mock localStorage
    const store = {};
    global.localStorage = {
      getItem: jest.fn((key) => store[key] || null),
      setItem: jest.fn((key, value) => {
        store[key] = String(value);
      }),
      removeItem: jest.fn((key) => {
        delete store[key];
      }),
      clear: jest.fn(() => {
        Object.keys(store).forEach(k => delete store[k]);
      })
    };
    global.window = {
      location: {
        hostname: 'kanyliar.github.io',
        protocol: 'https:',
        port: ''
      },
      dispatchEvent: jest.fn(),
      CustomEvent: class CustomEvent {
        constructor(name, detail) {
          this.name = name;
          this.detail = detail;
        }
      }
    };
  });

  afterEach(() => {
    delete global.localStorage;
    delete global.window;
  });

  test('isGitHubPages returns true for kanyliar.github.io', () => {
    expect(QuietSpaceStore.isGitHubPages()).toBe(true);
  });

  test('isGitHubPages returns false for localhost', () => {
    global.window.location.hostname = 'localhost';
    global.window.location.protocol = 'http:';
    expect(QuietSpaceStore.isGitHubPages()).toBe(false);
  });

  test('getApiBase returns null on GitHub Pages when no custom API is configured', () => {
    expect(QuietSpaceStore.getApiBase()).toBeNull();
  });

  test('getApiBase returns custom API URL when configured', () => {
    QuietSpaceStore.setCustomApiUrl('https://my-backend.onrender.com/');
    expect(QuietSpaceStore.getApiBase()).toBe('https://my-backend.onrender.com');
  });

  test('getRooms returns seeded demo rooms on GitHub Pages', async () => {
    const result = await QuietSpaceStore.getRooms();
    expect(result.source).toBe('demo');
    expect(result.rooms.length).toBeGreaterThanOrEqual(3);
    expect(result.rooms.some(r => r.room_name === 'Room 311')).toBe(true);
  });

  test('addRoom creates a new room in demo storage', async () => {
    const result = await QuietSpaceStore.addRoom('Room 314', 'Bluford Library 3rd Floor');
    expect(result.success).toBe(true);
    expect(result.room.room_name).toBe('Room 314');
    expect(result.source).toBe('demo');

    const roomsRes = await QuietSpaceStore.getRooms();
    expect(roomsRes.rooms.some(r => r.room_name === 'Room 314')).toBe(true);
  });

  test('updateRoom updates room name and location in demo storage', async () => {
    const updateRes = await QuietSpaceStore.updateRoom(1, {
      room_name: 'Quiet Pod 311',
      location: 'West Wing'
    });
    expect(updateRes.success).toBe(true);
    expect(updateRes.room.room_name).toBe('Quiet Pod 311');
    expect(updateRes.room.location).toBe('West Wing');

    const roomsRes = await QuietSpaceStore.getRooms();
    const updated = roomsRes.rooms.find(r => r.id === 1);
    expect(updated.room_name).toBe('Quiet Pod 311');
  });

  test('toggleRoomStatus toggles is_active state in demo storage', async () => {
    const toggleRes = await QuietSpaceStore.toggleRoomStatus(1);
    expect(toggleRes.success).toBe(true);
    expect(toggleRes.room.is_active).toBe(0);

    const toggleBack = await QuietSpaceStore.toggleRoomStatus(1);
    expect(toggleBack.room.is_active).toBe(1);
  });

  test('getReports returns seed reports and addReport prepends new report', async () => {
    const initial = await QuietSpaceStore.getReports();
    expect(initial.reports.length).toBe(3);

    const added = await QuietSpaceStore.addReport({
      room_id: 1,
      noise_type: 'loud_music',
      severity: 'high',
      comments: 'Speaker placed on desk'
    });
    expect(added.success).toBe(true);
    expect(added.report.noise_type).toBe('loud_music');

    const updated = await QuietSpaceStore.getReports();
    expect(updated.reports.length).toBe(4);
    expect(updated.reports[0].noise_type).toBe('loud_music');
  });

  test('updateReportStatus updates student report status in demo storage', async () => {
    const updateRes = await QuietSpaceStore.updateReportStatus(1, 'resolved');
    expect(updateRes.success).toBe(true);

    const reportsRes = await QuietSpaceStore.getReports();
    const target = reportsRes.reports.find(r => r.id === 1);
    expect(target.report_status).toBe('resolved');
  });

  test('getIncidents returns demo incidents with timers and escalation counts', async () => {
    const res = await QuietSpaceStore.getIncidents();
    expect(res.incidents.length).toBeGreaterThanOrEqual(2);
    expect(res.incidents.some(i => i.room_name === 'Room 313')).toBe(true);
  });
});
