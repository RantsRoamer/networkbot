// utils/monitoring.js
// Monitoring integrations for various systems (UniFi, Prometheus, etc.)
//
// UniFi Network API: https://developer.ui.com/network/v10.1.84/gettingstarted
// UniFi Site Manager API: https://developer.ui.com/site-manager/v1.0.0/gettingstarted
// - Official APIs support X-API-Key header. Site Manager is cloud-only (api.ui.com).

const axios = require('axios');
const { getConfig } = require('./config');
const {
  runPing,
  runTraceroute,
  testPort,
  detectPingRequest,
  detectPingIntentWithoutHost,
  detectTracerouteRequest,
  detectTracerouteIntentWithoutHost,
  detectPortTestRequest,
  detectPortTestIntentWithoutHost,
  extractPortFromMessage,
  resolveHostFromConversation,
} = require('./diagnostics');

const https = require('https');

/**
 * Get monitoring configuration
 */
function getMonitoringConfig() {
  const config = getConfig();
  return config.monitoring || {};
}

/**
 * UniFi Network API Integration
 * Aligned with official UniFi Network API: https://developer.ui.com/network/v10.1.84/gettingstarted
 * - Prefer X-API-Key header (official); fallback to session login for local controllers.
 * - Supports /proxy/network (UDM Pro) and /unifi-api/network base paths.
 */
class UniFiMonitor {
  constructor(config) {
    this.baseUrl = (config.baseUrl || '').replace(/\/$/, '');
    this.apiKey = config.apiKey || '';
    this.site = config.site || 'default';
    this.verifySSL = config.verifySSL !== false;
    this.cookie = null;
    this.csrfToken = null;
    this.apiPrefix = null; // '/unifi-api/network' or '/proxy/network' for local
    this.useSessionAuth = null; // true = cookie+CSRF, false = X-API-Key only
  }

  /** Clean base URL (no path) for login and prefix detection */
  getCleanBaseUrl() {
    return this.baseUrl
      .replace(/\/unifi-api\/network.*$/i, '')
      .replace(/\/proxy\/network.*$/i, '')
      .replace(/\/$/, '');
  }

  /**
   * Detect API prefix from URL or by probing (local controllers only)
   */
  detectApiPrefix() {
    if (this.baseUrl.includes('/unifi-api/network')) {
      this.apiPrefix = '/unifi-api/network';
      return;
    }
    if (this.baseUrl.includes('/proxy/network')) {
      this.apiPrefix = '/proxy/network';
      return;
    }
    this.apiPrefix = this.baseUrl.includes('unifi-api') ? '/unifi-api/network' : '/proxy/network';
  }

  /**
   * Get the full API base URL (local controller: base + prefix; see developer.ui.com/network)
   */
  getApiBaseUrl() {
    const base = this.getCleanBaseUrl();
    if (!this.apiPrefix) this.detectApiPrefix();
    return `${base}${this.apiPrefix}`;
  }

  getRequestOptions(extraHeaders = {}) {
    const opts = {
      timeout: 15000,
      validateStatus: (status) => status < 500,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    };
    if (!this.verifySSL) {
      opts.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }
    return opts;
  }

  /**
   * Session-based login for local UniFi controllers (UDM Pro, etc.)
   */
  async authenticate() {
    if (!this.baseUrl || !this.apiKey) {
      throw new Error('UniFi API key not configured');
    }
    const base = this.getCleanBaseUrl();
    try {
      const response = await axios.post(
        `${base}/api/auth/login`,
        { username: 'api', password: this.apiKey },
        this.getRequestOptions()
      );
      if (response.status !== 200) throw new Error('UniFi API key authentication failed');
      const setCookie = response.headers['set-cookie'];
      if (setCookie) {
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        this.cookie = cookies.map((c) => c.split(';')[0]).join('; ');
      }
      this.csrfToken = response.headers['x-csrf-token'] || null;
      try {
        await this.detectApiPrefixByProbing();
      } catch {
        this.detectApiPrefix();
      }
      this.useSessionAuth = true;
      return true;
    } catch (err) {
      if (err.code === 'ECONNREFUSED') {
        throw new Error(`Cannot connect to UniFi controller at ${base}`);
      }
      if (err.response?.status === 401 || err.response?.status === 403) {
        throw new Error('UniFi API key is invalid or expired. Check Network > Control Plane > Integrations (or Controller Settings → API Access).');
      }
      throw new Error(`UniFi authentication error: ${err.message}`);
    }
  }

  /**
   * Probe /unifi-api/network and /proxy/network to set apiPrefix (after session login)
   */
  async detectApiPrefixByProbing() {
    const base = this.getCleanBaseUrl();
    const headers = { Cookie: this.cookie, 'X-CSRF-Token': this.csrfToken };
    for (const prefix of ['/unifi-api/network', '/proxy/network']) {
      try {
        const res = await axios.get(`${base}${prefix}/api/self`, this.getRequestOptions(headers));
        if (res.status === 200 && (res.data?.meta?.rc === 'ok' || res.data?.data != null)) {
          this.apiPrefix = prefix;
          return;
        }
      } catch {
        // continue
      }
    }
    this.detectApiPrefix();
  }

  /**
   * Make authenticated API request.
   * Tries X-API-Key first (official API); on 401/403 falls back to session login for local controllers.
   */
  async apiRequest(endpoint) {
    if (!endpoint.startsWith('/api/')) {
      endpoint = endpoint.startsWith('/') ? `/api${endpoint}` : `/api/${endpoint}`;
    }

    const doRequest = (useSession) => {
      const base = this.getApiBaseUrl();
      const url = `${base}${endpoint}`;
      const headers = {};
      if (this.apiKey) headers['X-API-Key'] = this.apiKey;
      if (useSession && this.cookie) {
        headers['Cookie'] = this.cookie;
        if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
      }
      return axios.get(url, this.getRequestOptions(headers));
    };

    try {
      // Prefer official X-API-Key (no session) if we haven't already chosen session auth
      let response = null;
      if (this.useSessionAuth !== true) {
        response = await doRequest(false);
        if (response.status === 401 || response.status === 403) {
          this.useSessionAuth = true;
          await this.authenticate();
          response = await doRequest(true);
        }
      } else {
        if (!this.cookie) await this.authenticate();
        response = await doRequest(true);
      }

      if (response.status === 401 || response.status === 403) {
        this.cookie = null;
        this.csrfToken = null;
        this.apiPrefix = null;
        this.useSessionAuth = null;
        await this.authenticate();
        return this.apiRequest(endpoint);
      }

      const data = response.data;
      if (data?.data !== undefined) return data.data;
      if (Array.isArray(data)) return data;
      if (data && typeof data === 'object') return [data];
      return [];
    } catch (err) {
      if (err.code === 'ECONNREFUSED') {
        throw new Error(`Cannot connect to UniFi controller at ${this.baseUrl}`);
      }
      if (err.response?.status === 401 || err.response?.status === 403) {
        throw new Error('UniFi API key authentication failed. Check your API key.');
      }
      if (err.response?.status === 404 && this.apiPrefix) {
        const other = this.apiPrefix === '/proxy/network' ? '/unifi-api/network' : '/proxy/network';
        this.apiPrefix = other;
        return this.apiRequest(endpoint);
      }
      throw err;
    }
  }

  /**
   * Get system information
   */
  async getSystemInfo() {
    try {
      // UniFi OS uses /api/self and /api/sites
      const [system, sites] = await Promise.all([
        this.apiRequest('/api/self').catch(() => ({})),
        this.apiRequest('/api/sites').catch(() => []),
      ]);

      return {
        system: Array.isArray(system) ? (system[0] || {}) : (system || {}),
        sites: Array.isArray(sites) ? sites : (sites || []),
      };
    } catch (error) {
      throw new Error(`Failed to get UniFi system info: ${error.message}`);
    }
  }

  /**
   * Get device statistics
   */
  async getDevices() {
    try {
      // UniFi OS endpoint: /api/s/{site}/stat/device
      const devices = await this.apiRequest(`/api/s/${this.site}/stat/device`);
      return Array.isArray(devices) ? devices : [];
    } catch (error) {
      throw new Error(`Failed to get UniFi devices: ${error.message}`);
    }
  }

  /**
   * Get client statistics
   */
  async getClients() {
    try {
      // UniFi OS endpoint: /api/s/{site}/stat/sta
      const clients = await this.apiRequest(`/api/s/${this.site}/stat/sta`);
      return Array.isArray(clients) ? clients : [];
    } catch (error) {
      throw new Error(`Failed to get UniFi clients: ${error.message}`);
    }
  }

  /**
   * Get networks (VLANs) - rest/networkconf
   */
  async getNetworks() {
    try {
      const raw = await this.apiRequest(`/api/s/${this.site}/rest/networkconf`);
      return Array.isArray(raw) ? raw : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Get WLANs (SSIDs) - rest/wlanconf
   */
  async getWlans() {
    try {
      const raw = await this.apiRequest(`/api/s/${this.site}/rest/wlanconf`);
      return Array.isArray(raw) ? raw : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Get recent alarms - stat/alarm (most recent first)
   */
  async getAlarms(limit = 30) {
    try {
      const raw = await this.apiRequest(`/api/s/${this.site}/stat/alarm`);
      const list = Array.isArray(raw) ? raw : [];
      return list.slice(0, limit);
    } catch (error) {
      return [];
    }
  }

  /**
   * Get port profiles (switch port configs) - rest/portconf
   */
  async getPortProfiles() {
    try {
      const raw = await this.apiRequest(`/api/s/${this.site}/rest/portconf`);
      return Array.isArray(raw) ? raw : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Get site health - stat/health
   */
  async getSiteHealth() {
    try {
      const raw = await this.apiRequest(`/api/s/${this.site}/stat/health`);
      const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      return arr[0] || {};
    } catch (error) {
      return {};
    }
  }

  /**
   * Get port forwarding rules - rest/portforward
   */
  async getPortForwards() {
    try {
      const raw = await this.apiRequest(`/api/s/${this.site}/rest/portforward`);
      return Array.isArray(raw) ? raw : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Get active routes - stat/routing
   */
  async getRouting() {
    try {
      const raw = await this.apiRequest(`/api/s/${this.site}/stat/routing`);
      return Array.isArray(raw) ? raw : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Get intrusion detection / IPS / threat events if available (UDM/UniFi OS).
   * Tries stat/ips, rest/ips, stat/threat, rest/threat; normalizes various response shapes.
   */
  async getIntrusionEvents(limit = 50) {
    const normalize = (raw) => {
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw !== 'object') return [];
      if (Array.isArray(raw.data)) return raw.data;
      if (Array.isArray(raw.events)) return raw.events;
      if (Array.isArray(raw.by_source)) return raw.by_source;
      return [];
    };
    const endpoints = [
      `/api/s/${this.site}/stat/ips`,
      `/api/s/${this.site}/rest/ips`,
      `/api/s/${this.site}/stat/threat`,
      `/api/s/${this.site}/rest/threat`,
    ];
    for (const endpoint of endpoints) {
      try {
        const raw = await this.apiRequest(endpoint);
        const list = normalize(raw);
        if (list.length > 0) return list.slice(0, limit);
      } catch (_) {
        continue;
      }
    }
    return [];
  }

  /**
   * Fetch site events once and return both full event log (for AI) and filtered connection events.
   * UniFi endpoint: GET /api/s/{site}/stat/event (most recent first, 3000 limit).
   */
  async getSiteEvents(eventLogLimit = 80, connectionWithinMinutes = 5) {
    try {
      const raw = await this.apiRequest(`/api/s/${this.site}/stat/event`);
      const events = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
      const nowSec = Date.now() / 1000;
      const cutoffSec = nowSec - connectionWithinMinutes * 60;
      const connectionKeys = /EVT_(WU|WG|LU)_(Connected|Connect)|(wu|wg|lu)\.(connected|connect)/i;
      const eventKey = (e) => e.key || e.event_type || e.msg || e.event || '';
      const toSec = (t) => {
        if (t == null) return 0;
        const n = Number(t);
        return n > 1e12 ? n / 1000 : n;
      };
      const connectionEvents = events
        .filter((e) => e && eventKey(e).match(connectionKeys) && toSec(e.time || e.timestamp || e.datetime) >= cutoffSec)
        .slice(0, 100)
        .map((e) => ({
          time: e.time || e.timestamp || e.datetime,
          key: eventKey(e),
          hostname: e.hostname || e.name || e.msg || e.host_name || '—',
          mac: e.mac || e.user || e.mac_address || e.client_mac || '—',
        }));
      const eventLog = events.slice(0, eventLogLimit);
      return { eventLog, connectionEvents };
    } catch (error) {
      return { eventLog: [], connectionEvents: [] };
    }
  }

  /** @deprecated Use getSiteEvents().connectionEvents instead. Kept for compatibility. */
  async getRecentConnectionEvents(withinMinutes = 5) {
    const { connectionEvents } = await this.getSiteEvents(80, withinMinutes);
    return connectionEvents;
  }

  /**
   * Get network health metrics
   */
  async getHealthMetrics() {
    try {
      const [devices, clients, systemInfo] = await Promise.all([
        this.getDevices().catch(() => []),
        this.getClients().catch(() => []),
        this.getSystemInfo().catch(() => ({})),
      ]);

      // Calculate metrics
      const onlineDevices = devices.filter(d => d.state === 1).length;
      const totalDevices = devices.length;
      const activeClients = clients.filter(c => c.is_wired === false).length;
      const wiredClients = clients.filter(c => c.is_wired === true).length;

      // Get device types
      const deviceTypes = {};
      devices.forEach(device => {
        const type = device.type || 'unknown';
        deviceTypes[type] = (deviceTypes[type] || 0) + 1;
      });

      const MAX_LIST = 250;
      const isValidClient = (c) => c && typeof c === 'object' && (String(c.mac ?? c.mac_address ?? '').trim() || String(c.ip ?? c.fixed_ip ?? c.network?.ip ?? '').trim() || String(c.hostname ?? c.name ?? '').trim());
      const clientsList = (Array.isArray(clients) ? clients.filter(isValidClient) : []).slice(0, MAX_LIST);
      const isValidDevice = (d) => d && typeof d === 'object' && String(d.mac ?? d.mac_address ?? '').trim();
      const devicesList = (Array.isArray(devices) ? devices.filter(isValidDevice) : []).slice(0, MAX_LIST);
      return {
        devices: {
          total: totalDevices,
          online: onlineDevices,
          offline: totalDevices - onlineDevices,
          types: deviceTypes,
        },
        devicesList,
        clients: {
          total: clients.length,
          wireless: activeClients,
          wired: wiredClients,
        },
        clientsList,
        system: systemInfo.system || {},
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(`Failed to get UniFi health metrics: ${error.message}`);
    }
  }

  /**
   * Test connection
   */
  async testConnection() {
    try {
      const systemInfo = await this.getSystemInfo();
      return {
        success: true,
        message: `Connected to UniFi controller. Found ${systemInfo.sites?.length || 0} site(s).`,
        system: systemInfo.system?.name || 'Unknown',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
      };
    }
  }
}

/**
 * Prometheus API Integration (placeholder for future)
 */
class PrometheusMonitor {
  constructor(config) {
    this.baseUrl = config.baseUrl || '';
    this.basicAuth = config.basicAuth || null;
  }

  async query(query) {
    // Placeholder for Prometheus integration
    throw new Error('Prometheus integration not yet implemented');
  }
}

/**
 * UniFi Site Manager API Integration (cloud)
 * https://developer.ui.com/site-manager/v1.0.0/gettingstarted
 * - X-API-Key header; base URL typically https://api.ui.com
 * - Read-only: sites, devices, health metrics across managed deployments
 */
class UniFiSiteManagerMonitor {
  constructor(config) {
    this.baseUrl = (config.baseUrl || 'https://api.ui.com').replace(/\/$/, '');
    this.apiKey = config.apiKey || '';
    this.verifySSL = config.verifySSL !== false;
  }

  getOptions(extraHeaders = {}) {
    const opts = {
      timeout: 15000,
      validateStatus: (s) => s < 500,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-API-Key': this.apiKey,
        ...extraHeaders,
      },
    };
    if (!this.verifySSL) opts.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    return opts;
  }

  async request(path) {
    if (!this.apiKey) throw new Error('UniFi Site Manager API key not configured');
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const res = await axios.get(url, this.getOptions());
    if (res.status === 401 || res.status === 403) {
      throw new Error('UniFi Site Manager API key invalid or expired. Check Settings → API Keys (EA) or API section (GA).');
    }
    if (res.status === 429) {
      throw new Error('UniFi Site Manager rate limit exceeded. Retry later.');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`UniFi Site Manager API returned ${res.status}`);
    }
    return res.data;
  }

  /**
   * Try multiple paths; return first successful response (raw). For "try all cloud endpoints".
   */
  async _tryPaths(paths) {
    for (const p of paths) {
      try {
        const data = await this.request(p);
        return data != null ? data : undefined;
      } catch (_) {
        continue;
      }
    }
    return undefined;
  }

  /**
   * Extract array from API response. Handles various shapes: array, { data: [] }, { sites: [] },
   * { data: { sites: [] } }, { items: [] }, { hosts: [] }, etc.
   */
  _extractArray(data, ...keys) {
    if (data == null) return [];
    if (Array.isArray(data)) return data;
    const check = (val) => {
      if (Array.isArray(val)) return val;
      if (val != null && typeof val === 'object') {
        const arr = val.data ?? val.sites ?? val.devices ?? val.hosts ?? val.items ?? val.results ?? val.entries ?? val.result;
        if (Array.isArray(arr)) return arr;
        if (arr && typeof arr === 'object' && Array.isArray(arr.devices)) return arr.devices;
      }
      return null;
    };
    for (const key of keys) {
      const val = data[key];
      const arr = check(val);
      if (arr) return arr;
    }
    return [];
  }

  /** Extract object or array from response for generic cloud resources. */
  _extractPayload(data, arrayKeys, objectKeys) {
    if (data == null) return undefined;
    if (Array.isArray(data)) return data;
    const keys = objectKeys || ['data', 'result', 'metrics', 'health', 'payload', 'response'];
    for (const k of arrayKeys || ['data', 'items', 'results', 'entries', 'sites', 'devices', 'hosts', 'clients', 'alerts', 'events', 'networks', 'wlans', 'gateways']) {
      const v = data[k];
      if (Array.isArray(v)) return v;
      if (v != null && typeof v === 'object' && Array.isArray(v.data)) return v.data;
    }
    for (const k of keys) {
      const v = data[k];
      if (v != null && typeof v === 'object') return v;
    }
    return data;
  }

  async getSites() {
    // Site Manager API: try both /api/list-sites and /list-sites style (doc: developer.ui.com/site-manager-api)
    const paths = ['/api/list-sites', '/list-sites', '/api/sites', '/api/v1/sites', '/api/sites/list', '/sites', '/v1/sites', '/api/v1/account/sites'];
    for (const p of paths) {
      try {
        const data = await this.request(p);
        const list = this._extractArray(data, 'data', 'sites', 'items', 'results', 'entries');
        if (list.length === 0 && data != null && typeof data === 'object' && getConfig().server?.logLevel === 'DEBUG') {
          console.log('[Site Manager] getSites: 200 but 0 items from', p, '| response keys:', Object.keys(data));
        }
        return list;
      } catch (_) {
        continue;
      }
    }
    return [];
  }

  async getDevices() {
    // Documented: list-devices (infrastructure devices, not clients)
    const paths = ['/api/list-devices', '/list-devices', '/api/devices', '/api/v1/devices', '/api/devices/list', '/devices', '/v1/devices', '/api/v1/account/devices'];
    for (const p of paths) {
      try {
        const data = await this.request(p);
        const list = this._extractArray(data, 'data', 'devices', 'items', 'results', 'entries', 'result');
        if (list.length > 0) return list;
        if (list.length === 0 && data != null && typeof data === 'object' && getConfig().server?.logLevel === 'DEBUG') {
          console.log('[Site Manager] getDevices: 200 but 0 items from', p, '| response keys:', Object.keys(data));
        }
      } catch (_) {
        continue;
      }
    }
    // Fallback: fetch devices per site and aggregate (some APIs only expose devices per site)
    try {
      const sites = await this.getSites();
      const siteList = Array.isArray(sites) ? sites : [];
      const allDevices = [];
      const seen = new Set();
      for (const site of siteList.slice(0, 50)) {
        const siteId = site.id ?? site.site_id ?? site._id ?? site.key;
        if (!siteId) continue;
        const sitePaths = [
          `/api/v1/sites/${siteId}/devices`,
          `/v1/sites/${siteId}/devices`,
          `/api/sites/${siteId}/devices`,
          `/api/sites/${siteId}/list-devices`,
        ];
        for (const path of sitePaths) {
          try {
            const data = await this.request(path);
            const list = this._extractArray(data, 'data', 'devices', 'items', 'results', 'entries', 'result');
            for (const dev of list || []) {
              const key = dev.mac ?? dev.mac_address ?? dev.serial ?? dev.id ?? dev.device_id ?? dev._id ?? JSON.stringify(dev);
              if (key && !seen.has(key)) {
                seen.add(key);
                allDevices.push(dev);
              }
            }
            if ((list || []).length > 0) break;
          } catch (_) {
            continue;
          }
        }
      }
      if (allDevices.length > 0) return allDevices;
    } catch (_) {
      // ignore
    }
    return [];
  }

  /**
   * Get clients/hosts (end-user devices) from Site Manager.
   * Tries list-hosts, list-clients, and per-site clients if we have site ids.
   */
  async getClients() {
    const paths = [
      '/api/list-hosts',
      '/list-hosts',
      '/api/list-clients',
      '/list-clients',
      '/api/v1/hosts',
      '/api/v1/clients',
      '/api/hosts',
      '/api/clients',
      '/v1/hosts',
      '/v1/clients',
    ];
    for (const p of paths) {
      try {
        const data = await this.request(p);
        const list = this._extractArray(data, 'data', 'hosts', 'clients', 'items', 'results', 'entries');
        if (list.length > 0 || (data != null && typeof data === 'object')) {
          return list;
        }
      } catch (_) {
        continue;
      }
    }
    // Per-site clients if API uses /sites/{id}/clients
    try {
      const sites = await this.getSites();
      const siteList = Array.isArray(sites) ? sites : [];
      const allClients = [];
      for (const site of siteList.slice(0, 20)) {
        const siteId = site.id ?? site.site_id ?? site._id ?? site.key;
        if (!siteId) continue;
        const sitePaths = [
          `/api/v1/sites/${siteId}/clients`,
          `/v1/sites/${siteId}/clients`,
          `/api/sites/${siteId}/clients`,
          `/api/sites/${siteId}/hosts`,
        ];
        for (const path of sitePaths) {
          try {
            const data = await this.request(path);
            const list = this._extractArray(data, 'data', 'clients', 'hosts', 'items', 'results', 'entries');
            if (list.length > 0) allClients.push(...list);
            break;
          } catch (_) {
            continue;
          }
        }
      }
      if (allClients.length > 0) return allClients;
    } catch (_) {
      // ignore
    }
    return [];
  }

  /** Fetch a generic cloud resource: try paths, return extracted array or object (or raw). */
  async _fetchCloudResource(paths, arrayKeys, objectKeys) {
    const raw = await this._tryPaths(paths);
    if (raw === undefined) return undefined;
    const payload = this._extractPayload(raw, arrayKeys, objectKeys);
    return payload !== undefined ? payload : raw;
  }

  async getAlerts() {
    const paths = ['/api/list-alerts', '/list-alerts', '/api/alerts', '/api/v1/alerts', '/alerts', '/api/v1/account/alerts'];
    return this._fetchCloudResource(paths, ['data', 'alerts', 'items', 'results', 'entries']) ?? [];
  }

  async getInternetHealth() {
    const paths = ['/api/internet-health', '/internet-health', '/api/health', '/api/metrics', '/api/v1/health', '/api/v1/internet-health', '/api/insights', '/api/performance'];
    const out = await this._fetchCloudResource(paths, ['data', 'items'], ['data', 'result', 'metrics', 'health']);
    return out != null ? (Array.isArray(out) ? out : [out]) : [];
  }

  async getEvents(limit = 100) {
    const paths = ['/api/list-events', '/list-events', '/api/events', '/api/v1/events', '/events', '/api/activity'];
    const raw = await this._fetchCloudResource(paths, ['data', 'events', 'items', 'results', 'entries']);
    const list = Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
    return list.slice(0, limit);
  }

  async getNetworks() {
    const paths = ['/api/list-networks', '/list-networks', '/api/networks', '/api/v1/networks', '/networks', '/api/v1/account/networks'];
    return this._fetchCloudResource(paths, ['data', 'networks', 'items', 'results', 'entries']) ?? [];
  }

  async getWlans() {
    const paths = ['/api/list-wlans', '/list-wlans', '/api/wlans', '/api/v1/wlans', '/wlans', '/api/v1/account/wlans'];
    return this._fetchCloudResource(paths, ['data', 'wlans', 'items', 'results', 'entries']) ?? [];
  }

  async getGateways() {
    const paths = ['/api/list-gateways', '/list-gateways', '/api/gateways', '/api/v1/gateways', '/gateways'];
    return this._fetchCloudResource(paths, ['data', 'gateways', 'items', 'results', 'entries']) ?? [];
  }

  async getTrafficOrInsights() {
    const paths = ['/api/traffic', '/api/insights', '/api/metrics', '/api/v1/traffic', '/api/v1/insights', '/api/performance'];
    return this._fetchCloudResource(paths, ['data', 'items'], ['data', 'result', 'metrics']);
  }

  async getAccountOrSelf() {
    const paths = ['/api/self', '/api/account', '/api/v1/account', '/api/v1/self', '/account', '/self'];
    return this._fetchCloudResource(paths, null, ['data', 'result', 'account', 'user', 'self']);
  }

  /**
   * Fetch everything the cloud API may expose so the AI can answer any request.
   */
  async getAllCloudData() {
    const [metrics, alerts, internetHealth, events, networks, wlans, gateways, trafficOrInsights, accountOrSelf] = await Promise.all([
      this.getHealthMetrics(),
      this.getAlerts().catch(() => []),
      this.getInternetHealth().catch(() => []),
      this.getEvents(150).catch(() => []),
      this.getNetworks().catch(() => []),
      this.getWlans().catch(() => []),
      this.getGateways().catch(() => []),
      this.getTrafficOrInsights().catch(() => undefined),
      this.getAccountOrSelf().catch(() => undefined),
    ]);
    return {
      ...metrics,
      cloudAlerts: Array.isArray(alerts) ? alerts : [],
      internetHealth: Array.isArray(internetHealth) ? internetHealth : (internetHealth != null ? [internetHealth] : []),
      cloudEvents: Array.isArray(events) ? events : [],
      cloudNetworks: Array.isArray(networks) ? networks : [],
      cloudWlans: Array.isArray(wlans) ? wlans : [],
      cloudGateways: Array.isArray(gateways) ? gateways : [],
      trafficOrInsights: trafficOrInsights != null ? (Array.isArray(trafficOrInsights) ? trafficOrInsights : [trafficOrInsights]) : [],
      accountOrSelf: accountOrSelf != null ? accountOrSelf : undefined,
    };
  }

  /**
   * Treat device as online if any common status field indicates connected/online.
   * Site Manager and various APIs use: state (0/1 or string), status, connectionState, connected, isOnline, etc.
   */
  _deviceIsOnline(d) {
    if (d == null || typeof d !== 'object') return false;
    const s = (d.state ?? d.connectionState ?? d.status ?? d.connection_status ?? '').toString().toLowerCase();
    if (s === 'connected' || s === 'online' || s === '1') return true;
    if (d.connected === true || d.isOnline === true) return true;
    const n = Number(d.state ?? d.status);
    if (n === 1) return true;
    return false;
  }

  async getHealthMetrics() {
    const [sites, devices, clients] = await Promise.all([
      this.getSites(),
      this.getDevices(),
      this.getClients().catch(() => []),
    ]);
    const deviceList = Array.isArray(devices) ? devices : [];
    const siteList = Array.isArray(sites) ? sites : [];
    const clientList = Array.isArray(clients) ? clients : [];
    let online = deviceList.filter((d) => this._deviceIsOnline(d)).length;
    // If no device in list appears "online" but we have devices, treat all as online (API may not expose status)
    if (deviceList.length > 0 && online === 0) {
      const anyWithStatus = deviceList.some((d) => {
        const v = d.state ?? d.status ?? d.connectionState ?? d.connected ?? d.isOnline;
        return v !== undefined && v !== null && v !== '';
      });
      if (!anyWithStatus) {
        online = deviceList.length;
      }
    }
    const wirelessClients = clientList.filter((c) => c && (c.is_wired === false || c.wired === false || (c.type && String(c.type).toLowerCase().includes('wireless')))).length;
    const wiredClients = clientList.length - wirelessClients;
    const isValidClient = (c) => c && typeof c === 'object' && (String(c.mac ?? c.mac_address ?? '').trim() || String(c.ip ?? c.fixed_ip ?? c.network?.ip ?? c.ip_address ?? '').trim() || String(c.hostname ?? c.name ?? '').trim());
    // Site Manager API may use mac, serial, id, device_id, or name; accept any identifier
    const isValidDevice = (d) => d && typeof d === 'object' && (
      String(d.mac ?? d.mac_address ?? '').trim() ||
      String(d.serial ?? d.serial_number ?? '').trim() ||
      String(d.id ?? d.device_id ?? d._id ?? '').trim() ||
      String(d.name ?? d.hostname ?? d.display_name ?? d.device_name ?? d.label ?? '').trim()
    );
    const MAX_LIST = 250;
    const clientsList = clientList.filter(isValidClient).slice(0, MAX_LIST);
    const devicesList = deviceList.filter(isValidDevice).slice(0, MAX_LIST);
    return {
      sites: { total: siteList.length },
      sitesList: siteList.slice(0, 100),
      devices: { total: deviceList.length, online, offline: deviceList.length - online },
      devicesList,
      rawDeviceList: deviceList.slice(0, MAX_LIST),
      clients: {
        total: clientList.length,
        wireless: wirelessClients,
        wired: wiredClients,
      },
      clientsList,
      timestamp: new Date().toISOString(),
    };
  }

  async testConnection() {
    try {
      const [sites, devices, clients] = await Promise.all([
        this.getSites(),
        this.getDevices(),
        this.getClients().catch(() => []),
      ]);
      return {
        success: true,
        message: `UniFi Site Manager: ${sites.length} site(s), ${devices.length} device(s), ${clients.length} client(s).`,
        system: 'UniFi Site Manager',
      };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }
}

/**
 * Get monitoring data from all configured sources
 */
async function getMonitoringData() {
  const monitoringConfig = getMonitoringConfig();
  const data = {
    unifi: { controllers: [], summary: null },
    siteManager: null,
    prometheus: null,
    timestamp: new Date().toISOString(),
  };

  // UniFi Network - multiple controllers
  const unifiControllers = monitoringConfig.unifi?.controllers || [];
  const enabledUnifi = unifiControllers.filter((c) => c.enabled);
  if (enabledUnifi.length > 0) {
    const results = await Promise.all(
      enabledUnifi.map(async (cfg) => {
        try {
          const mon = new UniFiMonitor(cfg);
          const [metrics, siteEvents, networks, wlans, alarms, portProfiles, siteHealth, portForwards, routes, intrusionEvents] = await Promise.all([
            mon.getHealthMetrics(),
            mon.getSiteEvents(80, 5).catch(() => ({ eventLog: [], connectionEvents: [] })),
            mon.getNetworks().catch(() => []),
            mon.getWlans().catch(() => []),
            mon.getAlarms(30).catch(() => []),
            mon.getPortProfiles().catch(() => []),
            mon.getSiteHealth().catch(() => ({})),
            mon.getPortForwards().catch(() => []),
            mon.getRouting().catch(() => []),
            mon.getIntrusionEvents(50).catch(() => []),
          ]);
          return {
            id: cfg.id,
            name: cfg.name || cfg.baseUrl,
            success: true,
            metrics,
            recentConnectionEvents: Array.isArray(siteEvents?.connectionEvents) ? siteEvents.connectionEvents : [],
            eventLog: Array.isArray(siteEvents?.eventLog) ? siteEvents.eventLog : [],
            networks: Array.isArray(networks) ? networks : [],
            wlans: Array.isArray(wlans) ? wlans : [],
            alarms: Array.isArray(alarms) ? alarms : [],
            portProfiles: Array.isArray(portProfiles) ? portProfiles : [],
            siteHealth: siteHealth && typeof siteHealth === 'object' ? siteHealth : {},
            portForwards: Array.isArray(portForwards) ? portForwards : [],
            routes: Array.isArray(routes) ? routes : [],
            intrusionEvents: Array.isArray(intrusionEvents) ? intrusionEvents : [],
          };
        } catch (err) {
          return {
            id: cfg.id,
            name: cfg.name || cfg.baseUrl,
            success: false,
            error: err.message,
            recentConnectionEvents: [],
            eventLog: [],
            networks: [],
            wlans: [],
            alarms: [],
            portProfiles: [],
            siteHealth: {},
            portForwards: [],
            routes: [],
            intrusionEvents: [],
          };
        }
      })
    );
    data.unifi.controllers = results;
    const ok = results.filter((c) => c.success);
    if (ok.length > 0) {
      data.unifi.summary = {
        controllers: { total: enabledUnifi.length, online: ok.length, offline: enabledUnifi.length - ok.length },
        devices: {
          total: ok.reduce((s, c) => s + (c.metrics?.devices?.total || 0), 0),
          online: ok.reduce((s, c) => s + (c.metrics?.devices?.online || 0), 0),
        },
        clients: {
          total: ok.reduce((s, c) => s + (c.metrics?.clients?.total || 0), 0),
          wireless: ok.reduce((s, c) => s + (c.metrics?.clients?.wireless || 0), 0),
          wired: ok.reduce((s, c) => s + (c.metrics?.clients?.wired || 0), 0),
        },
      };
      data.unifi.summary.devices.offline = data.unifi.summary.devices.total - data.unifi.summary.devices.online;
    }
  }

  // UniFi Site Manager (cloud) – fetch all accessible cloud API data
  const sm = monitoringConfig.siteManager;
  if (sm?.enabled && sm?.apiKey) {
    try {
      const mon = new UniFiSiteManagerMonitor({
        apiKey: sm.apiKey,
        baseUrl: sm.baseUrl || 'https://api.ui.com',
        verifySSL: sm.verifySSL !== false,
      });
      const metrics = await mon.getAllCloudData();
      data.siteManager = { success: true, metrics };
    } catch (err) {
      data.siteManager = { success: false, error: err.message };
    }
  }

  if (monitoringConfig.prometheus?.enabled) {
    // Placeholder
  }

  return data;
}

const IPV4_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

/** True if value looks like a MongoDB ObjectId (24 hex chars). */
function looksLikeObjectId(v) {
  return typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v.trim());
}

/** Pick first string that looks like a human name (not ObjectId, 2–60 chars). */
function pickHumanName(obj, extraKeys = []) {
  const keys = ['name', 'display_name', 'displayName', 'title', 'site_name', 'siteName', 'description', 'label', 'nickname', ...extraKeys];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v !== 'string' || v.length < 2 || v.length > 60) continue;
    if (looksLikeObjectId(v)) continue;
    if (/^\d+$/.test(v)) continue;
    return v.trim();
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string' || v.length < 2 || v.length > 60) continue;
    if (looksLikeObjectId(v) || k.toLowerCase().includes('id') || k === '_id') continue;
    return v.trim();
  }
  return '';
}

/** Summarize a cloud API item (object) into a single line for context. For sites, prefer human name over id. */
function summarizeCloudItem(item, maxLen = 140) {
  if (item == null) return '—';
  if (typeof item !== 'object') return String(item).slice(0, maxLen);
  const idVal = item.id ?? item._id ?? item.key ?? item.site_id ?? item.siteId ?? '';
  const name = pickHumanName(item);
  const displayName = name || (idVal ? `Site ${String(idVal).slice(0, 12)}` : '—');
  const showId = idVal && !name ? ` (${String(idVal).slice(0, 12)}…)` : (idVal && name ? ` id:${String(idVal).slice(0, 8)}` : '');
  const rest = [];
  if (item.status != null) rest.push(`status: ${item.status}`);
  if (item.state != null) rest.push(`state: ${item.state}`);
  if (item.timestamp != null || item.time != null) rest.push(`time: ${item.timestamp ?? item.time}`);
  if (item.site_id != null || item.siteId != null) rest.push(`site: ${item.site_id ?? item.siteId}`);
  if (item.severity != null) rest.push(`severity: ${item.severity}`);
  const line = [displayName + showId, rest.join(' ')].filter(Boolean).join(' | ');
  return line.slice(0, maxLen) || JSON.stringify(item).slice(0, maxLen);
}

/** Format an array of cloud items for context (one line per item, capped). */
function formatCloudList(arr, label, maxItems = 50) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const lines = arr.slice(0, maxItems).map((item, i) => `  ${i + 1}. ${summarizeCloudItem(item)}`);
  return `\nUniFi Site Manager (cloud) – ${label} (use for user questions about this data):\n${lines.join('\n')}${arr.length > maxItems ? `\n  … and ${arr.length - maxItems} more` : ''}\n`;
}

/** Format a single object (e.g. account, health summary) for context. */
function formatCloudObject(obj, label) {
  if (obj == null || typeof obj !== 'object') return '';
  const keys = Object.keys(obj).slice(0, 25);
  const lines = keys.map((k) => `  ${k}: ${typeof obj[k] === 'object' ? JSON.stringify(obj[k]).slice(0, 80) : obj[k]}`);
  return `\nUniFi Site Manager (cloud) – ${label}:\n${lines.join('\n')}\n`;
}

/** Format one client for context: hostname, MAC, IP, connection type */
function formatClientForContext(c) {
  if (!c || typeof c !== 'object') return null;
  const hostname = c.hostname ?? c.name ?? c.host_name ?? c.display_name ?? '—';
  const mac = c.mac ?? c.mac_address ?? c.user ?? '—';
  const ip = c.ip ?? c.fixed_ip ?? c.network?.ip ?? c.ip_address ?? '—';
  const isWired = c.is_wired === true || c.is_wired === 1 || c.wired === true;
  const conn = isWired ? 'wired' : 'wireless';
  return { hostname: String(hostname).trim() || '—', mac: String(mac), ip: String(ip), conn };
}

/** Format one device (AP/switch) for context: name, MAC/serial/id, type, state. Handles both UniFi Network and Site Manager API field names; supports nested device.*. When cloud API omits per-device status, treat as online to match summary. */
function formatDeviceForContext(d) {
  if (!d || typeof d !== 'object') return null;
  const name = getAny(d, 'name', 'hostname', 'display_name', 'device_name', 'label', 'config.name', 'device.name') || '—';
  const mac = getAny(d, 'mac', 'mac_address', 'serial', 'serial_number', 'id', 'device_id', '_id', 'device.mac', 'device.serial') || '—';
  const type = getAny(d, 'type', 'model', 'device_type', 'model_name', 'product', 'config.model', 'device.model') || '—';
  const rawState = d.state ?? d.connection_state ?? d.status ?? d.connection_status ?? d.connected ?? d.isOnline ?? '';
  const explicitlyOffline = rawState === false || rawState === 0 || rawState === '0' || String(rawState).toLowerCase() === 'offline' || String(rawState).toLowerCase() === 'disconnected';
  const explicitlyOnline = rawState === 1 || rawState === '1' || String(rawState).toLowerCase() === 'connected' || rawState === true;
  const state = explicitlyOffline ? 'offline' : (explicitlyOnline ? 'online' : 'online');
  return { name: String(name).trim() || '—', mac: String(mac), type: String(type), state };
}

/** Get a value from object or nested object (e.g. d.device.name). */
function getAny(obj, ...keys) {
  for (const k of keys) {
    if (k.includes('.')) {
      const parts = k.split('.');
      let v = obj;
      for (const p of parts) {
        v = v?.[p];
      }
      if (v != null && v !== '') return v;
    } else if (obj?.[k] != null && obj[k] !== '') {
      return obj[k];
    }
  }
  return '';
}

/** Format a raw device (any shape) into a single line for context. When cloud API omits status, treat as online. */
function formatRawDeviceForContext(d) {
  if (!d || typeof d !== 'object') return null;
  const name = getAny(d, 'name', 'hostname', 'display_name', 'device_name', 'label', 'title', 'config.name', 'device.name', 'device.hostname');
  const id = getAny(d, 'mac', 'mac_address', 'serial', 'serial_number', 'id', 'device_id', '_id', 'device.mac', 'device.serial');
  const type = getAny(d, 'type', 'model', 'device_type', 'model_name', 'product', 'config.model', 'device.model', 'device.type');
  const rawState = d.state ?? d.connection_state ?? d.status ?? d.connection_status ?? d.connected ?? d.isOnline ?? '';
  const explicitlyOffline = rawState === false || rawState === 0 || rawState === '0' || String(rawState).toLowerCase() === 'offline' || String(rawState).toLowerCase() === 'disconnected';
  const state = explicitlyOffline ? 'offline' : 'online';
  const displayName = String(name || id || type || '').trim();
  if (!displayName) {
    const fallback = [];
    for (const [k, v] of Object.entries(d)) {
      if (k.startsWith('_') || v == null) continue;
      if (typeof v === 'string' && v.length > 0 && v.length < 80 && !looksLikeObjectId(v)) fallback.push(`${k}:${v}`);
      else if (typeof v === 'number' || typeof v === 'boolean') fallback.push(`${k}:${v}`);
      if (fallback.length >= 3) break;
    }
    const parts = [fallback.length ? fallback.join(' ') : 'device', state].filter(Boolean);
    return parts.join(' ').trim() || null;
  }
  const parts = [displayName, id && id !== displayName ? `(${String(id).slice(0, 16)}${String(id).length > 16 ? '…' : ''})` : '', type || '', state].filter(Boolean);
  return parts.join(' ').trim() || null;
}

/**
 * Get context for AI queries based on monitoring data.
 * If query contains an IPv4 address, appends IP lookup result (where that IP is connected).
 * If query asks for ping or traceroute, runs the command and appends output for the AI to interpret.
 * conversationHistory: optional array of { role: 'user'|'bot', message: string } to resolve "ping it" to a host from recent messages.
 */
async function getMonitoringContext(query, conversationHistory = []) {
  const monitoringData = await getMonitoringData();
  let context = '';

  const msg = typeof query === 'string' ? query.trim() : '';
  const recentText = Array.isArray(conversationHistory)
    ? conversationHistory.slice(-6).map((m) => (m && m.message ? String(m.message) : '')).join(' ')
    : '';
  let pingReq = msg ? detectPingRequest(msg) : null;
  let traceReq = msg ? detectTracerouteRequest(msg) : null;
  if (!pingReq && msg && detectPingIntentWithoutHost(msg)) {
    const host = resolveHostFromConversation(recentText + ' ' + msg);
    if (host) pingReq = { host, count: 4 };
  }
  if (!traceReq && msg && detectTracerouteIntentWithoutHost(msg)) {
    const host = resolveHostFromConversation(recentText + ' ' + msg);
    if (host) traceReq = { host, maxHops: 15 };
  }
  if (pingReq) {
    try {
      const result = await runPing(pingReq.host, pingReq.count);
      context += `\n\nPing result (from this server to ${pingReq.host}); use this to answer the user and help diagnose connectivity:\n`;
      context += result.output || result.error || 'No output.\n';
      if (result.error) context += `(Error: ${result.error})\n`;
    } catch (e) {
      context += `\n\nPing failed: ${e.message}\n`;
    }
  }
  if (traceReq) {
    try {
      const result = await runTraceroute(traceReq.host, traceReq.maxHops);
      context += `\n\nTraceroute result (from this server to ${traceReq.host}); use this to answer the user and help diagnose path/latency:\n`;
      context += result.output || result.error || 'No output.\n';
      if (result.error) context += `(Error: ${result.error})\n`;
    } catch (e) {
      context += `\n\nTraceroute failed: ${e.message}\n`;
    }
  }
  let portReq = msg ? detectPortTestRequest(msg) : null;
  if (!portReq && msg && detectPortTestIntentWithoutHost(msg)) {
    const host = resolveHostFromConversation(recentText + ' ' + msg);
    const port = extractPortFromMessage(msg);
    if (host && port) portReq = { host, port };
  }
  if (portReq) {
    try {
      const result = await testPort(portReq.host, portReq.port);
      context += `\n\nPort test result (from this server to ${portReq.host}:${portReq.port}); use this to answer the user:\n`;
      context += result.open ? `Port ${portReq.port} is OPEN on ${portReq.host}.` : `Port ${portReq.port} is closed or unreachable: ${result.message}`;
      context += '\n';
    } catch (e) {
      context += `\n\nPort test failed: ${e.message}\n`;
    }
  }

  const ipMatch = typeof query === 'string' && query.match(IPV4_REGEX);
  if (ipMatch) {
    const ip = ipMatch[0];
    try {
      const lookup = await lookupClientByIp(ip);
      if (lookup.found) {
        const c = lookup.client;
        const to = lookup.connectedTo;
        context += `\n\nIP lookup for ${ip}:\n`;
        context += `- Controller: ${lookup.controllerName} (site: ${lookup.site})\n`;
        context += `- Client: ${c.hostname || '—'} | MAC ${c.mac || '—'} | ${c.is_wired ? 'Wired' : 'Wireless'}\n`;
        context += `- Connected to: ${to?.name || to?.mac || '—'}${to?.port != null ? ` (port ${to.port})` : ''}\n`;
      } else {
        context += `\n\nIP lookup for ${ip}: ${lookup.error}\n`;
      }
    } catch (e) {
      context += `\n\nIP lookup for ${ip}: error — ${e.message}\n`;
    }
  }

  // Add UniFi context if available
  if (monitoringData.unifi?.summary) {
    const summary = monitoringData.unifi.summary;
    context += `\n\nUniFi Network Status (${summary.controllers.online}/${summary.controllers.total} controllers online):\n`;
    context += `- Devices: ${summary.devices.online}/${summary.devices.total} online across all controllers\n`;
    context += `- Clients: ${summary.clients.total} total (${summary.clients.wireless} wireless, ${summary.clients.wired} wired)\n`;
    
    // Per-controller/site details (include wireless and wired so "wireless at TOS" can be answered)
    if (monitoringData.unifi.controllers.length >= 1) {
      context += `\nPer site/controller (name = site or controller label):\n`;
      monitoringData.unifi.controllers.forEach(controller => {
        if (controller.success && controller.metrics) {
          const m = controller.metrics;
          const w = m.clients?.wireless ?? 0;
          const wd = m.clients?.wired ?? 0;
          context += `- ${controller.name}: ${m.devices.online}/${m.devices.total} devices, ${m.clients.total} clients (${w} wireless, ${wd} wired)\n`;
        } else if (!controller.success) {
          context += `- ${controller.name}: Error - ${controller.error}\n`;
        }
      });
    }

    // Recent connection events (last 5 minutes) so "who connected in the past X minutes" can be answered
    const controllersWithEvents = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && Array.isArray(c.recentConnectionEvents) && c.recentConnectionEvents.length > 0
    );
    if (controllersWithEvents.length > 0) {
      context += `\nRecent connections (last 5 minutes; use this for "clients connected in the past X minutes"):\n`;
      const nowSec = Date.now() / 1000;
      controllersWithEvents.forEach((controller) => {
        const events = controller.recentConnectionEvents.slice(0, 50);
        context += `- ${controller.name}: ${events.length} connection(s)\n`;
        events.forEach((e) => {
          const t = e.time != null ? (e.time > 1e12 ? e.time / 1000 : e.time) : 0;
          const minsAgo = t ? Math.round((nowSec - t) / 60) : '?';
          context += `  · ${e.hostname || e.mac} (${e.mac}) — ${minsAgo} min ago\n`;
        });
      });
    } else if ((monitoringData.unifi.controllers || []).some((c) => c.success)) {
      context += `\nRecent connections: no connection events in the last 5 minutes (or event API not available).\n`;
    }

    // Site event log = the "logs" — "last N items in the logs", "what do the logs show?", "recent events"
    const controllersWithEventLog = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && Array.isArray(c.eventLog) && c.eventLog.length > 0
    );
    if (controllersWithEventLog.length > 0) {
      context += `\nUniFi logs (event log). These ARE the logs. When the user asks for "last N items in the logs" or "show me the logs", use this list (items are most recent first; "last 10" = first 10 below). Use for "what do the logs show?", "recent events", "any errors in the logs?", diagnostics:\n`;
      controllersWithEventLog.forEach((controller) => {
        const log = controller.eventLog;
        context += `- ${controller.name} (${log.length} most recent log entries):\n`;
        log.forEach((e, idx) => {
          const key = e.key ?? e.event_type ?? e.msg ?? e.event ?? '—';
          const msg = (e.msg ?? e.message ?? e.desc ?? '').toString();
          const host = e.hostname ?? e.name ?? e.host_name ?? e.user ?? '';
          const mac = e.mac ?? e.mac_address ?? e.client_mac ?? '';
          const t = e.time ?? e.timestamp ?? e.datetime;
          const ts = t != null ? (t > 1e12 ? new Date(t).toISOString() : new Date(t * 1000).toISOString()) : '—';
          const line = [key, msg, host, mac].filter(Boolean).join(' | ');
          context += `  ${idx + 1}. ${ts} — ${line || '—'}\n`;
        });
      });
    } else if ((monitoringData.unifi.controllers || []).some((c) => c.success)) {
      context += `\nUniFi logs (event log): no entries from the event API. When the user asks for "logs", use the security/threat (intrusion) section below if present. If the user says they see threats in the UniFi UI (e.g. Traffic or Security tab), explain that those may not be exposed by the controller API we query (stat/event, stat/ips, stat/threat); they can check the UniFi Network app for full traffic/threat logs.\n`;
    }

    // Client list (UniFi Network) so "list of clients" can be answered
    const unifiControllersWithClients = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && c.metrics && Array.isArray(c.metrics.clientsList) && c.metrics.clientsList.length > 0
    );
    if (unifiControllersWithClients.length > 0) {
      context += `\nUniFi Network client list (answer list requests with the full list below; do not truncate):\n`;
      unifiControllersWithClients.forEach((controller) => {
        const list = controller.metrics.clientsList;
        const total = controller.metrics.clients?.total ?? list.length;
        context += `- ${controller.name} (${list.length} of ${total}):\n`;
        list.forEach((c, i) => {
          const f = formatClientForContext(c);
          if (f) context += `  ${i + 1}. ${f.hostname} | ${f.mac} | ${f.ip} | ${f.conn}\n`;
        });
      });
    }
    // Device list (UniFi Network) so "list devices at TOS" / "what APs are at site X" can be answered
    const unifiControllersWithDevices = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && c.metrics && Array.isArray(c.metrics.devicesList) && c.metrics.devicesList.length > 0
    );
    if (unifiControllersWithDevices.length > 0) {
      context += `\nUniFi Network device list (APs, switches; answer "list devices", "devices at site" with full list):\n`;
      unifiControllersWithDevices.forEach((controller) => {
        const list = controller.metrics.devicesList;
        const total = controller.metrics.devices?.total ?? list.length;
        context += `- ${controller.name} (${list.length} of ${total}):\n`;
        list.forEach((d, i) => {
          const f = formatDeviceForContext(d);
          if (f) context += `  ${i + 1}. ${f.name} | ${f.mac} | ${f.type} | ${f.state}\n`;
        });
      });
    }

    // Device port details (link speed, errors, port profile) — from stat/device port_table + rest/portconf
    const unifiControllersWithPortsAndProfiles = (monitoringData.unifi.controllers || []).filter(
      (c) =>
        c.success &&
        c.metrics &&
        Array.isArray(c.metrics.devicesList) &&
        Array.isArray(c.portProfiles)
    );
    if (unifiControllersWithPortsAndProfiles.length > 0) {
      context += `\nUniFi device ports (link speed, errors, port profile; use for "link speed", "port errors", "which profile is port X?", "switch port stats"):\n`;
      unifiControllersWithPortsAndProfiles.forEach((controller) => {
        const devicesList = controller.metrics.devicesList;
        const portProfiles = controller.portProfiles || [];
        const profileById = {};
        portProfiles.forEach((p) => {
          const id = p._id ?? p.id ?? p.attr_id;
          if (id) profileById[id] = p.name ?? p.display_name ?? p.attr_no_delete ?? id;
        });
        const devicesWithPorts = devicesList.filter((d) => Array.isArray(d.port_table) && d.port_table.length > 0);
        if (devicesWithPorts.length === 0) return;
        context += `- ${controller.name}:\n`;
        devicesWithPorts.forEach((dev) => {
          const devName = dev.name ?? dev.hostname ?? dev.display_name ?? dev.mac ?? '—';
          const portTable = dev.port_table || [];
          context += `  · ${devName} (${dev.mac ?? '—'}):\n`;
          portTable.forEach((port) => {
            const idx = port.port_idx ?? port.port_index ?? port.idx ?? '—';
            const name = port.name ? ` "${port.name}"` : '';
            const speedMbps = port.link_speed ?? port.speed ?? port.link_speed_mbps;
            const linkSpeed = speedMbps != null && speedMbps > 0
              ? (speedMbps >= 1000 ? `${speedMbps / 1000} Gbps` : `${speedMbps} Mbps`)
              : (port.up === false || port.link === false ? 'down' : '—');
            const rxErr = port.rx_errors ?? port.rx_err ?? 0;
            const txErr = port.tx_errors ?? port.tx_err ?? 0;
            const errStr = (rxErr || txErr) ? ` | rx_err: ${rxErr} tx_err: ${txErr}` : '';
            const portconfId = port.portconf_id ?? port.port_conf_id ?? port.profile_id;
            const profileName = portconfId ? (profileById[portconfId] ?? portconfId) : '—';
            context += `    Port ${idx}${name} | link: ${linkSpeed} | profile: ${profileName}${errStr}\n`;
          });
        });
      });
    }

    // Clients per device (which clients are on each switch/AP) — answer "clients on switch X?", "who is on AP Y?"
    const unifiControllersWithClientsAndDevices = (monitoringData.unifi.controllers || []).filter(
      (c) =>
        c.success &&
        c.metrics &&
        Array.isArray(c.metrics.clientsList) &&
        c.metrics.clientsList.length > 0 &&
        Array.isArray(c.metrics.devicesList) &&
        c.metrics.devicesList.length > 0
    );
    if (unifiControllersWithClientsAndDevices.length > 0) {
      context += `\nUniFi clients per device (use for "what clients are on switch/AP X?", "who is connected to [device name]?", "clients on [device]"):\n`;
      unifiControllersWithClientsAndDevices.forEach((controller) => {
        const clientsList = controller.metrics.clientsList;
        const devicesList = controller.metrics.devicesList;
        const deviceByMac = {};
        devicesList.forEach((d) => {
          const mac = (d.mac ?? d.mac_address ?? '').toLowerCase();
          if (mac) deviceByMac[mac] = d;
        });
        const clientsByDevice = {};
        clientsList.forEach((c) => {
          const isWired = c.is_wired === true || c.is_wired === 1 || c.wired === true;
          const uplinkMac = ((isWired ? c.sw_mac : c.ap_mac) || c.uplink_mac || '').toLowerCase();
          if (!uplinkMac) return;
          if (!clientsByDevice[uplinkMac]) clientsByDevice[uplinkMac] = [];
          const f = formatClientForContext(c);
          if (f) {
            const port = isWired && c.sw_port != null ? ` port ${c.sw_port}` : '';
            clientsByDevice[uplinkMac].push({ ...f, port });
          }
        });
        const deviceMacsWithClients = Object.keys(clientsByDevice).filter((mac) => clientsByDevice[mac].length > 0);
        if (deviceMacsWithClients.length === 0) return;
        context += `- ${controller.name}:\n`;
        deviceMacsWithClients.forEach((mac) => {
          const dev = deviceByMac[mac];
          const name = dev ? (dev.name ?? dev.hostname ?? dev.display_name ?? mac) : mac;
          const type = dev ? (dev.type ?? dev.model ?? '') : '';
          const clients = clientsByDevice[mac];
          context += `  · ${name} (${mac})${type ? ` [${type}]` : ''}: ${clients.length} client(s)\n`;
          clients.forEach((cx) => {
            context += `    - ${cx.hostname} | ${cx.mac} | ${cx.ip} | ${cx.conn}${cx.port || ''}\n`;
          });
        });
      });
    }

    // VLANs / networks (rest/networkconf) — answer "what VLANs?", "which VLAN is X on?", subnets
    const controllersWithNetworks = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && Array.isArray(c.networks) && c.networks.length > 0
    );
    if (controllersWithNetworks.length > 0) {
      context += `\nUniFi networks (VLANs); use for "what VLANs exist?", "which VLAN has subnet X?", "list networks":\n`;
      controllersWithNetworks.forEach((controller) => {
        const nets = controller.networks;
        context += `- ${controller.name}:\n`;
        nets.forEach((n) => {
          const name = n.name ?? n.display_name ?? '—';
          const purpose = n.purpose ?? n.type ?? '—';
          const vlan = n.vlan != null ? n.vlan : (n.vlan_id != null ? n.vlan_id : '—');
          const subnet = n.ip_subnet ?? n.subnet ?? n.cidr ?? '—';
          const dhcp = n.dhcpd_enabled != null ? (n.dhcpd_enabled ? 'DHCP on' : 'no DHCP') : '';
          context += `  · ${name} | purpose: ${purpose} | VLAN: ${vlan} | subnet: ${subnet} ${dhcp}\n`;
        });
      });
    }

    // WLANs (SSIDs) — answer "what Wi‑Fi networks?", "list SSIDs"
    const controllersWithWlans = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && Array.isArray(c.wlans) && c.wlans.length > 0
    );
    if (controllersWithWlans.length > 0) {
      context += `\nUniFi WLANs (SSIDs); use for "what Wi‑Fi networks?", "list SSIDs", "which SSID is enabled":\n`;
      controllersWithWlans.forEach((controller) => {
        const wlans = controller.wlans;
        context += `- ${controller.name}:\n`;
        wlans.forEach((w) => {
          const name = w.name ?? w.ssid ?? '—';
          const enabled = w.enabled != null ? (w.enabled ? 'enabled' : 'disabled') : '—';
          const security = w.security ?? w.wpa_mode ?? w.auth ?? '—';
          context += `  · ${name} | ${enabled} | security: ${security}\n`;
        });
      });
    }

    // Recent alarms — answer "any alarms?", "show issues", diagnostics
    const controllersWithAlarms = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && Array.isArray(c.alarms) && c.alarms.length > 0
    );
    if (controllersWithAlarms.length > 0) {
      context += `\nUniFi recent alarms (use for "any issues?", "show alarms", diagnostics):\n`;
      controllersWithAlarms.forEach((controller) => {
        const alarms = controller.alarms.slice(0, 20);
        context += `- ${controller.name} (${alarms.length} recent):\n`;
        alarms.forEach((a) => {
          const key = a.key ?? a.msg ?? a.message ?? '—';
          const msg = (a.msg ?? a.message ?? a.key ?? '').toString();
          const ts = a.timestamp ?? a.time ?? '—';
          context += `  · ${key}${msg && msg !== key ? ` — ${msg}` : ''} (${ts})\n`;
        });
      });
    } else if ((monitoringData.unifi.controllers || []).some((c) => c.success)) {
      context += `\nUniFi alarms: no recent alarms (or alarm API not available).\n`;
    }

    // Port profiles — answer "which VLAN is port X on?", "port profiles"
    const controllersWithPortProfiles = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && Array.isArray(c.portProfiles) && c.portProfiles.length > 0
    );
    if (controllersWithPortProfiles.length > 0) {
      context += `\nUniFi port profiles (switch port config; use for "port profiles", "which VLAN is port X on?"):\n`;
      controllersWithPortProfiles.forEach((controller) => {
        const profiles = controller.portProfiles;
        context += `- ${controller.name}:\n`;
        profiles.forEach((p) => {
          const name = p.name ?? p.display_name ?? '—';
          const autostart = p.autostart != null ? (p.autostart ? 'autostart' : '') : '';
          const poe = p.poe_mode != null ? `poe: ${p.poe_mode}` : '';
          const extras = [autostart, poe].filter(Boolean).join(' ');
          context += `  · ${name}${extras ? ` | ${extras}` : ''}\n`;
        });
      });
    }

    // Site health — answer "controller health?", "site health"
    const controllersWithHealth = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && c.siteHealth && typeof c.siteHealth === 'object' && Object.keys(c.siteHealth).length > 0
    );
    if (controllersWithHealth.length > 0) {
      context += `\nUniFi site health (use for "controller health?", "site health", diagnostics):\n`;
      controllersWithHealth.forEach((controller) => {
        const h = controller.siteHealth;
        const status = h.status ?? h.overall ?? '—';
        const subs = h.subsystem ?? h.subsystems;
        const arr = Array.isArray(subs) ? subs : [];
        context += `- ${controller.name}: ${status}\n`;
        arr.slice(0, 15).forEach((s) => {
          const subName = s.subsystem ?? s.name ?? s.type ?? '—';
          const subStatus = s.status ?? s.state ?? '—';
          context += `  · ${subName}: ${subStatus}\n`;
        });
      });
    }

    // Port forwarding — answer "what port forwarding is on?", "list port forwards"
    const controllersWithPortForwards = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && Array.isArray(c.portForwards) && c.portForwards.length > 0
    );
    if (controllersWithPortForwards.length > 0) {
      context += `\nUniFi port forwarding (use for "what port forwarding is on?", "list port forwards", "which ports are forwarded?"):\n`;
      controllersWithPortForwards.forEach((controller) => {
        const pf = controller.portForwards;
        context += `- ${controller.name}:\n`;
        pf.forEach((p) => {
          const name = p.name ?? p.description ?? p._id ?? '—';
          const enabled = p.enabled != null ? (p.enabled ? 'enabled' : 'disabled') : '—';
          const fwdPort = p.fwd_port ?? p.dst_port ?? p.port ?? '—';
          const proto = p.proto ?? p.protocol ?? '—';
          const target = p.fwd ?? p.fwd_address ?? p.dst_address ?? p.to ?? p.dst ?? '—';
          context += `  · ${name} | ${enabled} | ${proto} port ${fwdPort} → ${target}\n`;
        });
      });
    } else if ((monitoringData.unifi.controllers || []).some((c) => c.success)) {
      context += `\nUniFi port forwarding: none configured (or API not available).\n`;
    }

    // Routes — answer "what routes are established?", "list routes", "routing table"
    const controllersWithRoutes = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && Array.isArray(c.routes) && c.routes.length > 0
    );
    if (controllersWithRoutes.length > 0) {
      context += `\nUniFi routes (use for "what routes are established?", "list routes", "routing table", "static routes"):\n`;
      controllersWithRoutes.forEach((controller) => {
        const routes = controller.routes;
        context += `- ${controller.name}:\n`;
        routes.slice(0, 100).forEach((r) => {
          const dst = r.dst ?? r.destination ?? r.network ?? '—';
          const gw = r.gateway ?? r.via ?? r.next_hop ?? '—';
          const dev = r.dev ?? r.interface ?? r.if ?? '—';
          const dist = r.distance ?? r.metric ?? '';
          context += `  · ${dst} via ${gw}${dev !== '—' ? ` dev ${dev}` : ''}${dist ? ` metric ${dist}` : ''}\n`;
        });
      });
    } else if ((monitoringData.unifi.controllers || []).some((c) => c.success)) {
      context += `\nUniFi routes: no route data (or stat/routing API not available).\n`;
    }

    // Intrusion detection / IPS events (if available on UDM/UniFi OS)
    const controllersWithIntrusion = (monitoringData.unifi.controllers || []).filter(
      (c) => c.success && Array.isArray(c.intrusionEvents) && c.intrusionEvents.length > 0
    );
    if (controllersWithIntrusion.length > 0) {
      context += `\nUniFi security/threat logs (intrusion/IPS). These ARE part of "the logs". When the user asks for "logs" or "last N in the logs", include these (and event log above if any). Use for "threat detected", "security", "blocked", "intrusion", "IDS/IPS":\n`;
      controllersWithIntrusion.forEach((controller) => {
        const events = controller.intrusionEvents;
        context += `- ${controller.name} (${events.length} security/threat event(s)):\n`;
        events.forEach((e, idx) => {
          const msg = e.msg ?? e.message ?? e.name ?? e.description ?? e.key ?? '—';
          const src = e.src_ip ?? e.source_ip ?? e.ip ?? e.src ?? '—';
          const dst = e.dst_ip ?? e.dest_ip ?? e.dst ?? '—';
          const ts = e.timestamp ?? e.time ?? e.datetime ?? e.created ?? '—';
          const cat = e.category ?? e.type ?? e.attack ?? '';
          context += `  ${idx + 1}. ${msg}${src !== '—' ? ` | src ${src}` : ''}${dst !== '—' ? ` → ${dst}` : ''}${cat ? ` | ${cat}` : ''} | ${ts}\n`;
        });
      });
    } else if ((monitoringData.unifi.controllers || []).some((c) => c.success)) {
      context += `\nUniFi security/threat logs: no IPS/threat events returned from API (stat/ips, rest/ips, stat/threat tried). Traffic/threat data may be in the controller UI only.\n`;
    }
  } else if (monitoringData.unifi?.controllers?.length > 0) {
    const controller = monitoringData.unifi.controllers[0];
    if (controller.success && controller.metrics) {
      const m = controller.metrics;
      context += `\n\nUniFi Network Status (${controller.name}):\n`;
      context += `- Devices: ${m.devices.online}/${m.devices.total} online\n`;
      context += `- Clients: ${m.clients.total} total (${m.clients.wireless} wireless, ${m.clients.wired} wired)\n`;
      if (Array.isArray(m.clientsList) && m.clientsList.length > 0) {
        context += `\nUniFi Network client list (${controller.name}; include all ${m.clientsList.length} in your answer):\n`;
        m.clientsList.forEach((c, i) => {
          const f = formatClientForContext(c);
          if (f) context += `  ${i + 1}. ${f.hostname} | ${f.mac} | ${f.ip} | ${f.conn}\n`;
        });
      }
      if (Array.isArray(m.devicesList) && m.devicesList.length > 0) {
        context += `\nUniFi Network device list (${controller.name}):\n`;
        m.devicesList.forEach((d, i) => {
          const f = formatDeviceForContext(d);
          if (f) context += `  ${i + 1}. ${f.name} | ${f.mac} | ${f.type} | ${f.state}\n`;
        });
      }
    }
  }

  if (monitoringData.siteManager?.success && monitoringData.siteManager?.metrics) {
    const m = monitoringData.siteManager.metrics;
    const devTotal = m.devices?.total ?? 0;
    const devOnline = m.devices?.online ?? 0;
    const clTotal = m.clients?.total ?? 0;
    const clWireless = m.clients?.wireless ?? 0;
    const clWired = m.clients?.wired ?? 0;
    context += `\n\nUniFi Site Manager (cloud): ${m.sites?.total ?? 0} site(s). Devices: ${devOnline}/${devTotal} online. Clients: ${clTotal} total (${clWireless} wireless, ${clWired} wired). Anything requested from the cloud API that appears below is available to answer questions.\n`;
    if (Array.isArray(m.sitesList) && m.sitesList.length > 0) {
      context += formatCloudList(m.sitesList, 'sites list', 30);
    }
    if (Array.isArray(m.clientsList) && m.clientsList.length > 0) {
      context += `\nUniFi Site Manager client list (include all ${m.clientsList.length} in your answer):\n`;
      m.clientsList.forEach((c, i) => {
        const f = formatClientForContext(c);
        if (f) context += `  ${i + 1}. ${f.hostname} | ${f.mac} | ${f.ip} | ${f.conn}\n`;
      });
    }
    if (Array.isArray(m.devicesList) && m.devicesList.length > 0) {
      context += `\nUniFi Site Manager device list (include all ${m.devicesList.length} in your answer; list names and status):\n`;
      m.devicesList.forEach((d, i) => {
        const f = formatDeviceForContext(d);
        if (f) context += `  ${i + 1}. ${f.name} | ${f.mac} | ${f.type} | ${f.state}\n`;
      });
    } else if (Array.isArray(m.rawDeviceList) && m.rawDeviceList.length > 0) {
      context += `\nUniFi Site Manager device list (include all ${m.rawDeviceList.length} in your answer; list names and status):\n`;
      m.rawDeviceList.forEach((d, i) => {
        const line = formatRawDeviceForContext(d);
        if (line) context += `  ${i + 1}. ${line}\n`;
      });
    }
    if (Array.isArray(m.cloudAlerts) && m.cloudAlerts.length > 0) {
      context += formatCloudList(m.cloudAlerts, 'alerts', 30);
    }
    if (Array.isArray(m.internetHealth) && m.internetHealth.length > 0) {
      context += formatCloudList(m.internetHealth, 'internet health / metrics', 20);
    }
    if (Array.isArray(m.cloudEvents) && m.cloudEvents.length > 0) {
      context += formatCloudList(m.cloudEvents, 'events / activity', 40);
    }
    if (Array.isArray(m.cloudNetworks) && m.cloudNetworks.length > 0) {
      context += formatCloudList(m.cloudNetworks, 'networks', 30);
    }
    if (Array.isArray(m.cloudWlans) && m.cloudWlans.length > 0) {
      context += formatCloudList(m.cloudWlans, 'WLANs / SSIDs', 20);
    }
    if (Array.isArray(m.cloudGateways) && m.cloudGateways.length > 0) {
      context += formatCloudList(m.cloudGateways, 'gateways', 20);
    }
    if (Array.isArray(m.trafficOrInsights) && m.trafficOrInsights.length > 0) {
      context += formatCloudList(m.trafficOrInsights, 'traffic / insights / performance', 20);
    }
    if (m.accountOrSelf != null && typeof m.accountOrSelf === 'object') {
      context += formatCloudObject(m.accountOrSelf, 'account / self');
    }
  }

  return context;
}

/**
 * Look up a client by IP across all enabled UniFi Network controllers.
 * Returns where the IP is connected (which AP/switch and port if wired).
 */
async function lookupClientByIp(ip) {
  const normalized = String(ip || '').trim();
  if (!normalized) return { found: false, error: 'No IP provided' };
  const monitoringConfig = getMonitoringConfig();
  const controllers = (monitoringConfig.unifi?.controllers || []).filter((c) => c.enabled);
  if (controllers.length === 0) return { found: false, error: 'No UniFi Network controllers configured' };

  for (const cfg of controllers) {
    try {
      const mon = new UniFiMonitor(cfg);
      const [clients, devices] = await Promise.all([
        mon.getClients().catch(() => []),
        mon.getDevices().catch(() => []),
      ]);
      const clientList = Array.isArray(clients) ? clients : [];
      const deviceList = Array.isArray(devices) ? devices : [];
      const deviceByMac = {};
      deviceList.forEach((d) => {
        const mac = (d.mac || d.mac_address || '').toLowerCase();
        if (mac) deviceByMac[mac] = d;
      });
      const client = clientList.find((c) => {
        const cip = (c.ip || c.fixed_ip || (c.network && c.network.ip) || '').trim();
        return cip === normalized;
      });
      if (client) {
        const isWired = client.is_wired === true || client.is_wired === 1;
        const uplinkMac = (isWired ? client.sw_mac : client.ap_mac) || client.uplink_mac;
        const dev = uplinkMac ? deviceByMac[uplinkMac.toLowerCase()] : null;
        const port = isWired && (client.sw_port != null) ? client.sw_port : undefined;
        return {
          found: true,
          controllerName: cfg.name || cfg.baseUrl,
          site: cfg.site || 'default',
          client: {
            ip: client.ip || client.fixed_ip,
            mac: client.mac,
            hostname: client.hostname || client.name || null,
            is_wired: isWired,
          },
          connectedTo: dev
            ? {
                name: dev.name || dev.hostname || dev.mac,
                mac: dev.mac,
                type: dev.type || 'unknown',
                port,
              }
            : { name: null, mac: uplinkMac, type: null, port },
        };
      }
    } catch (err) {
      continue;
    }
  }
  return { found: false, error: `IP ${normalized} not found on any UniFi controller` };
}

/**
 * Test UniFi Network connection
 */
async function testUniFiConnection(config) {
  try {
    const unifi = new UniFiMonitor(config);
    return await unifi.testConnection();
  } catch (error) {
    return { success: false, message: error.message };
  }
}

/**
 * Test UniFi Site Manager connection
 */
async function testUniFiSiteManagerConnection(config) {
  try {
    const sm = new UniFiSiteManagerMonitor(config);
    return await sm.testConnection();
  } catch (error) {
    return { success: false, message: error.message };
  }
}

/**
 * Request an arbitrary path from the UniFi Site Manager (cloud) API.
 * Path should start with / (e.g. /api/list-alerts, /api/list-devices).
 * Returns { success: true, data } or { success: false, error }.
 */
async function requestSiteManagerPath(path) {
  const monitoringConfig = getMonitoringConfig();
  const sm = monitoringConfig.siteManager;
  if (!sm?.enabled || !sm?.apiKey) {
    return { success: false, error: 'UniFi Site Manager is not enabled or API key not set.' };
  }
  const normalizedPath = typeof path === 'string' && path.trim() ? path.trim() : '';
  if (!normalizedPath || !normalizedPath.startsWith('/')) {
    return { success: false, error: 'Path must be a non-empty string starting with / (e.g. /api/list-alerts).' };
  }
  try {
    const mon = new UniFiSiteManagerMonitor({
      apiKey: sm.apiKey,
      baseUrl: sm.baseUrl || 'https://api.ui.com',
      verifySSL: sm.verifySSL !== false,
    });
    const data = await mon.request(normalizedPath);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

module.exports = {
  getMonitoringData,
  getMonitoringContext,
  lookupClientByIp,
  testUniFiConnection,
  testUniFiSiteManagerConnection,
  requestSiteManagerPath,
  UniFiMonitor,
  UniFiSiteManagerMonitor,
  PrometheusMonitor,
};
