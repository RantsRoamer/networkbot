// utils/scheduler.js – In-process scheduler with heartbeat (no cron).
// Runs user-defined checks at intervals or once at a set time; sends notifications on request.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');
const { sendEmail } = require('./email');
const { sendWebhook } = require('./webhook');

const SCHEDULES_FILE = path.join(__dirname, '..', 'schedules.json');
const HEARTBEAT_INTERVAL_MS = 30 * 1000;   // 30 seconds
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;  // 2 minutes without tick = stale
const DEFAULT_TICK_MS = 30 * 1000;         // check for due jobs every 30s

let state = {
  jobs: [],
  lastHeartbeatAt: null,
  meta: { version: 1 },
};
let tickTimer = null;
let runRequestFn = null; // set by app: async (message) => responseText

function loadState() {
  try {
    if (fs.existsSync(SCHEDULES_FILE)) {
      const raw = fs.readFileSync(SCHEDULES_FILE, 'utf8');
      const data = JSON.parse(raw);
      state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      state.lastHeartbeatAt = data.lastHeartbeatAt || null;
      state.meta = data.meta || state.meta;
    }
  } catch (err) {
    console.error('[Scheduler] Error loading schedules:', err.message);
    state.jobs = [];
  }
  return state;
}

function saveState() {
  try {
    const data = {
      jobs: state.jobs,
      lastHeartbeatAt: state.lastHeartbeatAt,
      meta: state.meta,
    };
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[Scheduler] Error saving schedules:', err.message);
  }
}

function generateId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Check if AI response suggests issues are present (errors, warnings, down, etc.).
 * Only matches positive indications of problems, not phrases like "no errors" or "no issues found".
 */
function responseIndicatesIssues(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();

  // Phrases that strongly indicate issues are present (not "no errors" / "all clear")
  const positiveIssuePhrases = [
    'errors found', 'error found', 'error in ', 'error:', 'errors in ', 'errors:',
    'warnings found', 'warning found', 'warning in ', 'warning:', 'warnings in ', 'warnings:',
    'issues found', 'issue found', 'issues detected', 'issue detected', 'issues:',
    'problems found', 'problem found', 'problems detected', 'problem detected',
    'is down', 'are down', 'went down', 'device down', 'devices down',
    'offline', 'are offline', 'is offline', 'went offline',
    'unreachable', 'not reachable',
    'failure', 'failed to', 'failed:', 'failures',
    'not responding', 'not responding.',
    'critical error', 'critical warning', 'critical issue',
    'alert triggered', 'alerts triggered', 'alert:', 'alerts:',
  ];

  for (const phrase of positiveIssuePhrases) {
    if (lower.includes(phrase)) return true;
  }

  return false;
}

/**
 * Run a single job: get context, run AI request, optionally send notification.
 */
async function runJob(job, addDashboardLog) {
  if (!runRequestFn) {
    console.error('[Scheduler] runRequest not configured; cannot run job:', job.id);
    if (addDashboardLog) addDashboardLog('error', 'scheduler', 'Scheduler runRequest not configured', job.name);
    return;
  }
  const now = new Date().toISOString();
  try {
    const responseText = await runRequestFn(job.request);
    job.lastRunAt = now;
    job.lastResult = responseText ? responseText.slice(0, 2000) : '';
    job.lastError = null;

    const notify = job.notify || 'never';
    const shouldNotifyAlways = notify === 'always';
    const shouldNotifyOnIssues = notify === 'on_issues' && responseIndicatesIssues(responseText);
    const to = job.notifyEmail?.trim() || getConfig().email?.to?.trim();

    if ((shouldNotifyAlways || shouldNotifyOnIssues) && to) {
      const subject = shouldNotifyOnIssues
        ? `NetworkBot – Issues detected: ${(job.name || job.request || 'Scheduled check').slice(0, 50)}`
        : `NetworkBot – Scheduled check: ${(job.name || job.request || 'Check').slice(0, 50)}`;
      const preview = responseText ? responseText.slice(0, 1500) : 'No response.';
      await sendEmail({
        to,
        subject,
        text: `Scheduled check ran at ${now}\n\nRequest: ${job.request}\n\nResult:\n${preview}`,
        html: `<p>Scheduled check ran at <code>${now}</code></p><p><b>Request:</b> ${escapeHtml(job.request)}</p><pre>${escapeHtml(preview)}</pre>`,
      });
    }

    // Webhook notification (uses same notify conditions as email)
    if (shouldNotifyAlways || shouldNotifyOnIssues) {
      const whTitle = shouldNotifyOnIssues
        ? `Issues detected: ${(job.name || job.request || 'Scheduled check').slice(0, 80)}`
        : `Scheduled check: ${(job.name || job.request || 'Check').slice(0, 80)}`;
      const whText = `Ran at: ${now}\nRequest: ${job.request}\n\n${(responseText || 'No response.').slice(0, 3000)}`;
      sendWebhook({ title: whTitle, text: whText }).catch((e) =>
        console.error('[Scheduler] Webhook notification failed:', e.message)
      );
    }

    if (job.type === 'recurring' && job.intervalMinutes > 0) {
      const next = new Date(Date.now() + job.intervalMinutes * 60 * 1000);
      job.nextRunAt = next.toISOString();
    } else if (job.type === 'once') {
      job.enabled = false;
      job.nextRunAt = null;
    }
    saveState();
    if (addDashboardLog) addDashboardLog('info', 'scheduler', `Job ran: ${job.name || job.id}`, job.request?.slice(0, 80));
  } catch (err) {
    job.lastRunAt = now;
    job.lastError = err.message || String(err);
    job.lastResult = null;
    saveState();
    console.error('[Scheduler] Job failed:', job.id, err.message);
    if (addDashboardLog) addDashboardLog('error', 'scheduler', `Job failed: ${job.name || job.id}`, err.message);

    const notify = job.notify || 'never';
    const to = job.notifyEmail?.trim() || getConfig().email?.to?.trim();
    if ((notify === 'on_issues' || notify === 'always') && to) {
      await sendEmail({
        to,
        subject: `NetworkBot – Scheduled check failed: ${(job.name || job.request || 'Check').slice(0, 50)}`,
        text: `Scheduled check failed at ${now}\n\nRequest: ${job.request}\n\nError: ${job.lastError}`,
      }).catch((e) => console.error('[Scheduler] Failed to send error email:', e.message));
    }
    if (notify === 'on_issues' || notify === 'always') {
      sendWebhook({
        title: `Scheduled check FAILED: ${(job.name || job.request || 'Check').slice(0, 80)}`,
        text: `Failed at: ${now}\nRequest: ${job.request}\n\nError: ${job.lastError}`,
      }).catch((e) => console.error('[Scheduler] Webhook error notification failed:', e.message));
    }
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tick(addDashboardLog) {
  const now = Date.now();
  state.lastHeartbeatAt = new Date(now).toISOString();
  saveState();

  const due = state.jobs.filter((j) => {
    if (!j.enabled) return false;
    if (j.type === 'once') return j.runAt && new Date(j.runAt).getTime() <= now;
    if (j.type === 'recurring') return !j.nextRunAt || new Date(j.nextRunAt).getTime() <= now;
    return false;
  });

  due.forEach((job) => {
    runJob(job, addDashboardLog).catch((err) => {
      console.error('[Scheduler] runJob error:', err);
    });
  });
}

function getHeartbeat() {
  const at = state.lastHeartbeatAt ? new Date(state.lastHeartbeatAt).getTime() : 0;
  const stale = Date.now() - at > HEARTBEAT_STALE_MS;
  return {
    lastHeartbeatAt: state.lastHeartbeatAt,
    status: stale ? 'stale' : 'ok',
    tickIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

function getSchedules() {
  loadState();
  return state.jobs;
}

function getJob(id) {
  return state.jobs.find((j) => j.id === id) || null;
}

function addJob(job) {
  loadState();
  const id = job.id || generateId();
  const nextRunAt = job.type === 'once' && job.runAt
    ? job.runAt
    : job.type === 'recurring' && job.intervalMinutes
      ? new Date(Date.now() + job.intervalMinutes * 60 * 1000).toISOString()
      : null;
  const newJob = {
    id,
    name: job.name || '',
    request: job.request || '',
    type: job.type || 'recurring',
    intervalMinutes: job.type === 'recurring' ? Math.max(1, parseInt(job.intervalMinutes, 10) || 5) : null,
    runAt: job.type === 'once' && job.runAt ? job.runAt : null,
    notify: job.notify || 'never',
    notifyEmail: job.notifyEmail || '',
    enabled: job.enabled !== false,
    lastRunAt: null,
    lastError: null,
    lastResult: null,
    nextRunAt,
    createdAt: new Date().toISOString(),
  };
  state.jobs.push(newJob);
  saveState();
  return newJob;
}

function updateJob(id, updates) {
  loadState();
  const idx = state.jobs.findIndex((j) => j.id === id);
  if (idx === -1) return null;
  const current = state.jobs[idx];
  const next = { ...current, ...updates };
  if (next.type === 'recurring' && next.intervalMinutes != null) {
    next.intervalMinutes = Math.max(1, parseInt(next.intervalMinutes, 10) || 5);
  }
  if (next.type === 'once' && next.runAt) {
    next.nextRunAt = next.runAt;
  } else if (next.type === 'recurring' && next.intervalMinutes && !next.nextRunAt) {
    next.nextRunAt = new Date(Date.now() + next.intervalMinutes * 60 * 1000).toISOString();
  }
  state.jobs[idx] = next;
  saveState();
  return next;
}

function deleteJob(id) {
  loadState();
  const idx = state.jobs.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  state.jobs.splice(idx, 1);
  saveState();
  return true;
}

/**
 * Run a job once immediately (does not change nextRunAt for recurring jobs).
 */
async function runJobNow(id, addDashboardLog) {
  const job = getJob(id);
  if (!job) return { success: false, error: 'Job not found' };
  await runJob(job, addDashboardLog);
  return { success: true, lastRunAt: job.lastRunAt, lastError: job.lastError };
}

/**
 * Start the scheduler. runRequest(message) must return the AI response text.
 * addDashboardLog(level, source, message, detail) is optional.
 */
function startScheduler(options = {}) {
  runRequestFn = options.runRequest || null;
  const addDashboardLog = options.addDashboardLog || (() => {});
  loadState();

  if (tickTimer) clearInterval(tickTimer);
  tick(addDashboardLog);
  tickTimer = setInterval(() => tick(addDashboardLog), options.tickIntervalMs || DEFAULT_TICK_MS);
  console.log('[Scheduler] Started (heartbeat every ' + (options.tickIntervalMs || DEFAULT_TICK_MS) / 1000 + 's)');
  return { getHeartbeat, getSchedules, getJob, addJob, updateJob, deleteJob, runJobNow };
}

function stopScheduler() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  runRequestFn = null;
}

module.exports = {
  loadState,
  saveState,
  getHeartbeat,
  getSchedules,
  getJob,
  addJob,
  updateJob,
  deleteJob,
  runJobNow,
  startScheduler,
  stopScheduler,
  SCHEDULES_FILE,
  responseIndicatesIssues,
};
