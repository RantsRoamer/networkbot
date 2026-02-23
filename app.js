#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs');
const express = require('express');
const path = require('path');
const basicAuth = require('express-basic-auth');
const { aiQuery, streamQuery, getLLMConfig, initializeOpenAI, testOllamaConnection } = require('./utils/llm');
const { getConfig, updateConfig, reloadConfig } = require('./utils/config');
const { getMonitoringContext, getMonitoringData, lookupClientByIp, testUniFiConnection, testUniFiSiteManagerConnection, requestSiteManagerPath, invalidateMonitoringCache } = require('./utils/monitoring');
const { sendTestEmail } = require('./utils/email');
const { sendWebhook, testWebhook } = require('./utils/webhook');
const scheduler = require('./utils/scheduler');

// Load configuration
let config = getConfig();

const PERSONALITY_PATH = path.join(__dirname, 'Personality.MD');

/** Defaults used when Personality.MD is missing or a section is empty */
const DEFAULT_SCOPE = `**Scope – you must follow this:**
- Answer ONLY questions about: (1) the networks, sites, devices, and clients you have monitoring data for below, and (2) network diagnostics and troubleshooting to help fix issues on those networks.
- If the user asks about anything else (general knowledge, other topics, unrelated questions about the world, history, coding, etc.), respond with a short, polite message that you are a network monitoring assistant and can only help with questions about the monitored networks and network diagnostics. Do not attempt to answer off-topic questions.
- You only "know" what is in the monitoring data. Do not make up sites, devices, or data. If the user asks about something not in the data, say so. The monitoring data may include a "UniFi logs" section—that is the log data; do not say you lack access to logs if that section is present.
`;

const DEFAULT_FORMATTING = `When you do report status or an overview, use a clear structure:
- **Status Summary** – Use a small table when listing counts (e.g. Controllers, Devices, Clients). Example: | Item | Count | Status |
- **Error / Warning Check** – Bullet points for issues found; say "No error or warning entries" if none.
- **Conclusion** – One short paragraph. **Next Steps** – Only if the user asked for recommendations; otherwise skip.
Keep sections short. Use **bold** for important terms. Prefer bullets and tables over long paragraphs.`;

const DEFAULT_INSTRUCTIONS = `You are a network and server monitoring AI assistant. Think like a network administrator.

Use the monitoring data below to answer questions about clients, devices, sites, connectivity, status, VLANs, routes, port forwarding, intrusion/IPS events, logs (event log), and diagnostics.

When the user asks for "logs" or "last N items in the logs": use the "UniFi logs" / event log section in the data below; "last 10" = first 10 entries (most recent first). If no entries are listed, say the logs are empty or no events were returned.

When the user asks to ping a host or run traceroute, the data below may include "Ping result" or "Traceroute result". Use that output to summarize reachability, latency, and path, and to help diagnose connectivity issues. Results are from the server running this app.

When the user asks to test a port (e.g. "10.0.0.1 port 80", "test port 443 on host"), the data below may include "Port test result". Use it to say whether the port is open or closed/unreachable.

Answer the user's question directly. Give only the information that is asked for.

Use the conversation history for context: if the user refers to a device, site (e.g. by name like TOS), or topic from earlier messages, use that context to answer.

When the user asks for a list of clients (or "clients at TOS", "list all clients", etc.), return the complete list from the data in a clear table or numbered list—do not stop early or truncate; include every client shown in the data.

When the user asks for a list of devices (APs, switches), return the full device list from the data.

Do not give a full system or status summary unless the user explicitly asks for status, overview, or "how is everything".

For specific questions (e.g. "what is the IP of X?", "is Y online?", "where is 192.168.1.50 connected?", "how many wireless clients at TOS?") use the monitoring data below and answer directly.

Use the monitoring data below only to support your answer. Be objective and concise.

Formatting: Use Markdown.`;

const DEFAULT_CAPABILITIES = `When the user asks "what can you do?", "what commands can you do?", "what do you support?", or similar, answer with this list (you may format it clearly as a list or table):

**Monitoring & data**
- Answer questions about monitored networks: clients, devices, sites, connectivity, status, VLANs, WLANs (SSIDs), routes, port forwarding, alarms, intrusion/IPS (security threat) events, and logs.
- List clients or devices (full lists from the data), show clients per switch or AP, show recent connection events.
- IP lookup: say "where is 10.x.x.x?" and I look up which client has that IP and where it’s connected (which switch/AP and port).

**Diagnostics (run from this server)**
- **Ping** a host: e.g. "ping 10.69.69.5" or "can you ping it?" (uses the host from our last message).
- **Traceroute** to a host: e.g. "traceroute to 8.8.8.8" or "traceroute to it".
- **Test a port**: e.g. "10.69.69.5 port 80", "test port 443 on example.com", or "test port 80 on it" (host from context).

**Logs**
- Show the last N items in the logs (event log and/or security/threat logs from UniFi).

I only answer questions about these monitored networks and diagnostics; I don’t answer general-knowledge or off-topic questions.`;

const DEFAULT_DIAGNOSTICS = `You are a server diagnostics AI. Answer based on the log snippet and what the user asked.
If they ask a specific question (e.g. "any errors?", "why did X fail?"), answer that directly.
When summarizing or reporting findings, use **Findings** (bullets), **Conclusion**, and **Next Steps** only if relevant. Use Markdown; keep it concise.`;

/**
 * Parse Personality.MD into sections by ## Header.
 * Returns { scope, instructions, formatting, diagnostics } with trimmed content; missing sections are empty string.
 */
function loadPersonality() {
  let raw;
  try {
    raw = fs.readFileSync(PERSONALITY_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const sections = {};
  const sectionRe = /^##\s+(.+)$/gm;
  let match;
  let lastEnd = 0;
  let lastKey = null;
  while ((match = sectionRe.exec(raw)) !== null) {
    if (lastKey) {
      const content = raw.slice(lastEnd, match.index).replace(/\n+$/, '').trim();
      sections[lastKey] = content;
    }
    lastKey = match[1].toLowerCase().replace(/\s+/g, '');
    lastEnd = match.index + match[0].length;
  }
  if (lastKey) {
    const content = raw.slice(lastEnd).replace(/\n+$/, '').trim();
    sections[lastKey] = content;
  }
  return {
    scope: sections.scope || '',
    instructions: sections.instructions || '',
    formatting: sections.formatting || '',
    diagnostics: sections.diagnostics || '',
    capabilities: sections.capabilities || '',
  };
}

function getMonitoringSystemPrompt(monitoringContext) {
  const p = loadPersonality();
  const scope = p.scope.trim() || DEFAULT_SCOPE;
  const instructions = p.instructions.trim() || DEFAULT_INSTRUCTIONS;
  const formatting = p.formatting.trim() || DEFAULT_FORMATTING;
  const capabilities = p.capabilities.trim() || DEFAULT_CAPABILITIES;
  const monitoringBlock = monitoringContext
    ? `\n\nRelevant monitoring data:\n${monitoringContext}`
    : '\n\nNo monitoring data is currently available; answer only that you do not have network data to work with and suggest checking that monitoring (e.g. UniFi) is configured. ';
  return [scope, '\n\n', instructions, '\n\n**What you can do (use when the user asks "what can you do?", "what commands can you do?", or similar):**\n', capabilities, monitoringBlock, '\n\n', formatting].join('');
}

function getDiagnosticsSystemPrompt() {
  const p = loadPersonality();
  const formatting = p.formatting.trim() || DEFAULT_FORMATTING;
  const diagnostics = p.diagnostics.trim() || DEFAULT_DIAGNOSTICS;
  return `${diagnostics}\n\n${formatting}`;
}

const PORT = config.web?.port ?? config.server?.port ?? process.env.PORT ?? 3000;

// In-memory log for dashboard (last 100 entries: errors, warnings, important info)
const dashboardLog = [];
const MAX_DASHBOARD_LOG = 100;

function addDashboardLog(level, source, message, detail) {
  dashboardLog.push({
    time: new Date().toISOString(),
    level,
    source,
    message: String(message),
    detail: detail != null ? String(detail) : undefined,
  });
  if (dashboardLog.length > MAX_DASHBOARD_LOG) dashboardLog.shift();
}

// ==================== Web Interface ====================

const webApp = express();
webApp.use(express.json());
webApp.use(express.static(path.join(__dirname, 'public')));

// Basic authentication middleware
const getAuthConfig = () => {
  const currentConfig = getConfig();
  const username = currentConfig.web?.auth?.username || process.env.WEB_AUTH_USERNAME || 'admin';
  const password = currentConfig.web?.auth?.password || process.env.WEB_AUTH_PASSWORD || 'admin';
  
  const users = {};
  users[username] = password;
  
  return {
    users: users,
    challenge: true,
    realm: 'NetworkBot Configuration',
  };
};

// Apply auth to API routes - use authorizer function for dynamic config
webApp.use('/api', basicAuth({
  authorizer: (username, password) => {
    const authConfig = getAuthConfig();
    const validUser = Object.keys(authConfig.users)[0];
    const validPassword = authConfig.users[validUser];
    const ok = basicAuth.safeCompare(username, validUser) && basicAuth.safeCompare(password, validPassword);
    if (!ok) {
      const safeUser = typeof username === 'string' ? username.slice(0, 50).replace(/[^\w@.\-]/g, '?') : '?';
      addDashboardLog('warning', 'auth', 'Failed authentication attempt', `User: ${safeUser}`);
    }
    return ok;
  },
  challenge: true,
  realm: 'NetworkBot Configuration',
}));

// API Routes

// GET /api/config - Get current configuration
webApp.get('/api/config', (req, res) => {
  try {
    const currentConfig = getConfig();
    // Don't send sensitive data in response
    const safeConfig = JSON.parse(JSON.stringify(currentConfig));
    if (safeConfig.web?.auth?.password) {
      safeConfig.web.auth.password = safeConfig.web.auth.password ? '***hidden***' : '';
    }
    if (safeConfig.llm?.openai?.apiKey) {
      safeConfig.llm.openai.apiKey = safeConfig.llm.openai.apiKey ? '***hidden***' : '';
    }
    if (safeConfig.email?.smtp?.auth?.pass) {
      safeConfig.email.smtp.auth.pass = '***hidden***';
    }
    res.json(safeConfig);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/config - Update configuration
webApp.put('/api/config', async (req, res) => {
  try {
    const updates = req.body;
    // Preserve existing Site Manager API key when client sends empty (e.g. masked value not re-entered)
    if (updates.monitoring?.siteManager && (updates.monitoring.siteManager.apiKey === '' || updates.monitoring.siteManager.apiKey === '***hidden***')) {
      const existing = getConfig().monitoring?.siteManager?.apiKey;
      if (existing && existing !== '***hidden***') updates.monitoring.siteManager.apiKey = existing;
    }
    // Preserve existing email SMTP password when client sends empty or masked
    if (updates.email?.smtp?.auth && (updates.email.smtp.auth.pass === '' || updates.email.smtp.auth.pass === '***hidden***')) {
      const existing = getConfig().email?.smtp?.auth?.pass;
      if (existing && existing !== '***hidden***') updates.email.smtp.auth.pass = existing;
    }
    const updatedConfig = updateConfig(updates);

    // Reload config
    config = getConfig();

    // Reinitialize OpenAI if provider changed
    if (updates.llm?.provider || updates.llm?.openai?.apiKey) {
      initializeOpenAI();
    }

    // Invalidate monitoring cache when monitoring config changes
    if (updates.monitoring) {
      invalidateMonitoringCache();
    }
    
    // Don't send sensitive fields in response
    const safeConfig = JSON.parse(JSON.stringify(updatedConfig));
    if (safeConfig.web?.auth?.password) {
      safeConfig.web.auth.password = '***hidden***';
    }
    if (safeConfig.llm?.openai?.apiKey) {
      safeConfig.llm.openai.apiKey = safeConfig.llm.openai.apiKey ? '***hidden***' : '';
    }
    if (safeConfig.monitoring?.unifi?.controllers) {
      safeConfig.monitoring.unifi.controllers = safeConfig.monitoring.unifi.controllers.map(c => ({
        ...c,
        apiKey: c.apiKey ? '***hidden***' : '',
      }));
    }
    if (safeConfig.monitoring?.siteManager?.apiKey) {
      safeConfig.monitoring.siteManager = { ...safeConfig.monitoring.siteManager, apiKey: '***hidden***' };
    }
    if (safeConfig.email?.smtp?.auth?.pass) {
      safeConfig.email.smtp.auth.pass = '***hidden***';
    }

    res.json(safeConfig);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/config/test-email - Send a test notification email using current config
webApp.post('/api/config/test-email', async (req, res) => {
  try {
    const result = await sendTestEmail();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/config/test-webhook - Send a test webhook using current config
webApp.post('/api/config/test-webhook', async (req, res) => {
  try {
    const result = await testWebhook();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/config/test - Test current configuration
webApp.post('/api/config/test', async (req, res) => {
  try {
    const llmConfig = getLLMConfig();
    
    if (llmConfig.provider === 'ollama') {
      const result = await testOllamaConnection(llmConfig.ollama.baseUrl, llmConfig.ollama.model);
      if (!result.success) addDashboardLog('error', 'config', 'LLM test failed', result.message);
      res.json(result);
    } else {
      try {
        await aiQuery('test', 'You are a test assistant. Reply with "OK" if you can read this.');
        res.json({ success: true, message: 'OpenAI configuration is valid' });
      } catch (error) {
        addDashboardLog('error', 'config', 'OpenAI test failed', error.message);
        res.json({ success: false, message: error.message });
      }
    }
  } catch (error) {
    addDashboardLog('error', 'config', 'Configuration test failed', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/config/test-ollama - Test Ollama connection with custom params
webApp.post('/api/config/test-ollama', async (req, res) => {
  try {
    const { baseUrl, model } = req.body;
    if (!baseUrl || !model) {
      return res.status(400).json({ success: false, message: 'baseUrl and model are required' });
    }
    
    const result = await testOllamaConnection(baseUrl, model);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/config/reload - Reload configuration from file
webApp.post('/api/config/reload', (req, res) => {
  try {
    const reloadedConfig = reloadConfig();
    initializeOpenAI(); // Reinitialize OpenAI client
    invalidateMonitoringCache(); // Clear stale monitoring cache
    
    const safeConfig = JSON.parse(JSON.stringify(reloadedConfig));
    if (safeConfig.web?.auth?.password) {
      safeConfig.web.auth.password = '***hidden***';
    }
    
    res.json(safeConfig);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/monitoring/data - Get current monitoring data
webApp.get('/api/monitoring/data', async (req, res) => {
  try {
    const data = await getMonitoringData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/monitoring/cloud - Get all cloud (Site Manager) data currently fetched
webApp.get('/api/monitoring/cloud', async (req, res) => {
  try {
    const data = await getMonitoringData();
    if (!data.siteManager?.success) {
      return res.status(400).json({ error: 'UniFi Site Manager not configured or failed.', siteManager: data.siteManager });
    }
    res.json(data.siteManager.metrics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/monitoring/cloud-request - Request an arbitrary cloud API path (e.g. { "path": "/api/list-alerts" })
webApp.post('/api/monitoring/cloud-request', async (req, res) => {
  try {
    const apiPath = req.body?.path;
    const result = await requestSiteManagerPath(apiPath);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/monitoring/test-unifi - Test UniFi Network connection
webApp.post('/api/monitoring/test-unifi', async (req, res) => {
  try {
    const { baseUrl, apiKey, site, verifySSL } = req.body;
    if (!baseUrl || !apiKey) {
      return res.status(400).json({ success: false, message: 'baseUrl and apiKey are required' });
    }
    const config = { baseUrl, apiKey, site: site || 'default', verifySSL: verifySSL !== false };
    const result = await testUniFiConnection(config);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/monitoring/test-site-manager - Test UniFi Site Manager connection
webApp.post('/api/monitoring/test-site-manager', async (req, res) => {
  try {
    const { apiKey, baseUrl, verifySSL } = req.body;
    if (!apiKey) {
      return res.status(400).json({ success: false, message: 'apiKey is required' });
    }
    const config = {
      apiKey,
      baseUrl: baseUrl || 'https://api.ui.com',
      verifySSL: verifySSL !== false,
    };
    const result = await testUniFiSiteManagerConnection(config);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/lookup/ip?q=192.168.1.50 - Look up where an IP is connected (UniFi)
webApp.get('/api/lookup/ip', async (req, res) => {
  try {
    const ip = (req.query.q || req.query.ip || '').trim();
    if (!ip) return res.status(400).json({ success: false, error: 'Missing query parameter: q or ip' });
    const result = await lookupClientByIp(ip);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Allow the chat route to run a long time so "thinking" / processing models don't time out (10 min)
const CHAT_ROUTE_TIMEOUT_MS = 10 * 60 * 1000;

// POST /api/chat - Chat with the AI bot (optionally stream when debugShowThoughtStream is on)
webApp.post('/api/chat', async (req, res) => {
  req.setTimeout(CHAT_ROUTE_TIMEOUT_MS);
  res.setTimeout(CHAT_ROUTE_TIMEOUT_MS);
  try {
    const { message, history } = req.body;
    
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    const conversationHistory = Array.isArray(history) ? history : [];
    // Get monitoring context (includes ping/traceroute when asked; "ping it" uses host from recent conversation)
    let monitoringContext = '';
    try {
      monitoringContext = await getMonitoringContext(message.trim(), conversationHistory);
    } catch (error) {
      console.log('[Monitoring] Could not fetch monitoring data:', error.message);
    }
    
    const systemPrompt = getMonitoringSystemPrompt(monitoringContext);
    const debugStream = getConfig().llm?.debugShowThoughtStream === true;

    if (debugStream) {
      // Stream response as Server-Sent Events so the client can show the thought stream
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      let fullText = '';
      try {
        for await (const chunk of streamQuery(message.trim(), systemPrompt, conversationHistory)) {
          fullText += chunk;
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
          if (typeof res.flush === 'function') res.flush();
        }
        res.write(`data: ${JSON.stringify({ done: true, response: fullText, timestamp: new Date().toISOString() })}\n\n`);
      } catch (streamErr) {
        console.error('[Chat API Stream Error]:', streamErr.message);
        addDashboardLog('error', 'chat', streamErr.message);
        res.write(`data: ${JSON.stringify({ error: streamErr.message })}\n\n`);
      }
      res.end();
      return;
    }

    const response = await aiQuery(message.trim(), systemPrompt, conversationHistory);
    
    res.json({ 
      success: true, 
      response: response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Chat API Error]:', error.message);
    addDashboardLog('error', 'chat', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'An error occurred while processing your message'
    });
  }
});

// ==================== Scheduler API ====================

// GET /api/scheduler/heartbeat – Scheduler heartbeat (confirm it's running)
webApp.get('/api/scheduler/heartbeat', (req, res) => {
  try {
    res.json(scheduler.getHeartbeat());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/schedules – List all scheduled jobs
webApp.get('/api/schedules', (req, res) => {
  try {
    res.json(scheduler.getSchedules());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/schedules – Create a new scheduled job
webApp.post('/api/schedules', (req, res) => {
  try {
    const body = req.body || {};
    const job = scheduler.addJob({
      name: body.name,
      request: body.request,
      type: body.type || 'recurring',
      intervalMinutes: body.intervalMinutes,
      runAt: body.runAt,
      notify: body.notify || 'never',
      notifyEmail: body.notifyEmail,
      enabled: body.enabled !== false,
    });
    res.status(201).json(job);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/schedules/:id – Update a job
webApp.put('/api/schedules/:id', (req, res) => {
  try {
    const id = req.params.id;
    const existing = scheduler.getJob(id);
    if (!existing) return res.status(404).json({ error: 'Job not found' });
    const updated = scheduler.updateJob(id, req.body || {});
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/schedules/:id – Delete a job
webApp.delete('/api/schedules/:id', (req, res) => {
  try {
    const id = req.params.id;
    const deleted = scheduler.deleteJob(id);
    if (!deleted) return res.status(404).json({ error: 'Job not found' });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/schedules/:id/run – Run a job now
webApp.post('/api/schedules/:id/run', async (req, res) => {
  try {
    const id = req.params.id;
    const result = await scheduler.runJobNow(id, addDashboardLog);
    if (!result.success) return res.status(404).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/dashboard - System stats, monitoring summary, recent log
webApp.get('/api/dashboard', async (req, res) => {
  try {
    let monitoringSummary = null;
    try {
      const data = await getMonitoringData();
      monitoringSummary = {
        unifi: data.unifi?.summary
          ? {
              controllers: data.unifi.summary.controllers,
              devices: data.unifi.summary.devices,
              clients: data.unifi.summary.clients,
            }
          : null,
        siteManager: data.siteManager?.success
          ? { sites: data.siteManager.metrics?.sites, devices: data.siteManager.metrics?.devices, clients: data.siteManager.metrics?.clients }
          : null,
        timestamp: data.timestamp,
      };
    } catch (err) {
      addDashboardLog('warning', 'monitoring', 'Dashboard monitoring fetch failed', err.message);
    }
    const mem = process.memoryUsage();
    const heartbeat = scheduler.getHeartbeat();
    res.json({
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        rss: Math.round(mem.rss / 1024 / 1024),
      },
      monitoring: monitoringSummary,
      scheduler: { heartbeat: heartbeat.status, lastHeartbeatAt: heartbeat.lastHeartbeatAt },
      log: dashboardLog.slice(-50).reverse(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Redirect root to index.html
webApp.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
(async () => {
  try {
    const llmConfig = getLLMConfig();
    console.log(`📡 LLM Provider: ${llmConfig.provider.toUpperCase()}`);
    if (llmConfig.provider === 'ollama') {
      console.log(`🔗 Ollama URL: ${llmConfig.ollama.baseUrl}`);
      console.log(`🤖 Ollama Model: ${llmConfig.ollama.model}`);
    }
    
    webApp.listen(PORT, '0.0.0.0', async () => {
      console.log(`🌐 NetworkBot running at http://0.0.0.0:${PORT}`);
      addDashboardLog('info', 'server', 'NetworkBot started', `Port ${PORT}`);
      const authConfig = getAuthConfig();
      const username = Object.keys(authConfig.users)[0];
      console.log(`🔐 Login: ${username} / ${authConfig.users[username] === 'admin' ? '(default password - change in config!)' : '***'}`);

      // Start in-process scheduler (heartbeat-based, no cron)
      scheduler.startScheduler({
        addDashboardLog,
        runRequest: async (message) => {
          let monitoringContext = '';
          try {
            monitoringContext = await getMonitoringContext(message.trim(), []);
          } catch (err) {
            console.log('[Scheduler] Monitoring context error:', err.message);
          }
          const systemPrompt = getMonitoringSystemPrompt(monitoringContext);
          return await aiQuery(message.trim(), systemPrompt, []);
        },
      });
    });
  } catch (error) {
    console.error('❌ Failed to start NetworkBot:', error);
    process.exit(1);
  }
})();
