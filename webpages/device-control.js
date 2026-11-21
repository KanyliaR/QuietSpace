/* The same fail-closed control is exercised by the simulated microphone tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuietSpaceDeviceControl = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  return class DeviceControl {
    constructor({ roomId, getConfig, stop, resume, onState, now = Date.now }) {
      Object.assign(this, { roomId, getConfig, stop, resume, onState, now });
      this.enabled = false; this.confirmedAt = 0; this.busy = false; this.disabledConfig = null;
    }
    allowed() { return this.enabled && this.now() - this.confirmedAt < 5000; }
    deny(config = this.disabledConfig) {
      this.enabled = false;
      this.stop();
      this.onState(false, config);
    }
    async check() {
      if (this.busy) return this.allowed();
      this.busy = true;
      try {
        const config = await this.getConfig();
        if (Number(config.room_id) !== this.roomId) {
          this.disabledConfig=null;this.deny(null);return false;
        }
        if (![true, 1].includes(config.monitoring_enabled)) {
          this.disabledConfig=config;this.deny(config);return false;
        }
        this.disabledConfig=null;
        const wasEnabled = this.enabled;
        this.enabled = true; this.confirmedAt = this.now(); this.onState(true, config);
        if (!wasEnabled) await this.resume();
        return true;
      } catch {
        this.disabledConfig=null;this.deny(null);return false;
      } finally { this.busy = false; }
    }
  };
});
