// utils/diagnostics.js – run ping, traceroute, and port check for AI-assisted diagnostics

const net = require('net');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const PING_TIMEOUT_MS = 15000;
const TRACEROUTE_TIMEOUT_MS = 30000;
const PORT_CHECK_TIMEOUT_MS = 5000;
const MAX_PING_COUNT = 5;
const MAX_TRACEROUTE_HOPS = 20;

/** Allow hostnames and IPs only (no shell metacharacters) */
function sanitizeHost(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 253) return null;
  if (!/^[a-zA-Z0-9.\-_:\[\]]+$/.test(s)) return null;
  return s;
}

/**
 * Run ping toward host. Returns { success, output, error }.
 * Runs from the server (Node process), so reachability is from the server's network.
 */
async function runPing(host, count = 4) {
  const target = sanitizeHost(host);
  if (!target) return { success: false, output: '', error: 'Invalid or missing host' };
  const c = Math.min(Math.max(1, parseInt(count, 10) || 4), MAX_PING_COUNT);
  const cmd = process.platform === 'win32'
    ? `ping -n ${c} ${target}`
    : `ping -c ${c} -W 3 ${target}`;
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: PING_TIMEOUT_MS,
      maxBuffer: 4096,
    });
    return { success: true, output: (stdout || '') + (stderr || ''), error: null };
  } catch (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    return { success: false, output: out, error: err.message || 'Ping failed' };
  }
}

/**
 * Run traceroute toward host. Returns { success, output, error }.
 * Windows uses tracert; Unix uses traceroute (or tracepath if no traceroute).
 */
async function runTraceroute(host, maxHops = 15) {
  const target = sanitizeHost(host);
  if (!target) return { success: false, output: '', error: 'Invalid or missing host' };
  const hops = Math.min(Math.max(1, parseInt(maxHops, 10) || 15), MAX_TRACEROUTE_HOPS);
  let cmd;
  if (process.platform === 'win32') {
    cmd = `tracert -h ${hops} ${target}`;
  } else {
    cmd = `traceroute -m ${hops} ${target} 2>/dev/null || tracepath -m ${hops} ${target}`;
  }
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: TRACEROUTE_TIMEOUT_MS,
      maxBuffer: 8192,
    });
    return { success: true, output: (stdout || '') + (stderr || ''), error: null };
  } catch (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    return { success: false, output: out, error: err.message || 'Traceroute failed' };
  }
}

/**
 * Test TCP connectivity to host:port. Returns { open, message }.
 * Open = connection succeeded within timeout; otherwise closed/filtered/unreachable.
 */
function testPort(host, port) {
  const target = sanitizeHost(host);
  if (!target) return Promise.resolve({ open: false, message: 'Invalid or missing host' });
  const p = parseInt(port, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return Promise.resolve({ open: false, message: 'Invalid port (use 1-65535)' });
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ open: false, message: `Connection timed out after ${PORT_CHECK_TIMEOUT_MS / 1000}s` });
    }, PORT_CHECK_TIMEOUT_MS);
    socket.on('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve({ open: true, message: `Port ${p} is open on ${target}` });
    });
    socket.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ open: false, message: err.message || 'Connection refused or unreachable' });
    });
    socket.connect(p, target);
  });
}

/** Detect if the user is asking to test a port and extract host and port */
function detectPortTestRequest(message) {
  const m = message.trim();
  const host = '([a-zA-Z0-9.\\-_:\\[\\]]+)';
  const port = '(\\d{1,5})';
  const tests = [
    { re: new RegExp(`(?:test|check|is)\\s+port\\s+${port}\\s+(?:on|at|to)\\s+${host}`, 'i'), portIdx: 1, hostIdx: 2 },
    { re: new RegExp(`${host}\\s+port\\s+${port}`, 'i'), portIdx: 2, hostIdx: 1 },
    { re: new RegExp(`port\\s+${port}\\s+(?:on|at)\\s+${host}`, 'i'), portIdx: 1, hostIdx: 2 },
    { re: new RegExp(`(?:test|check)\\s+${host}\\s+port\\s+${port}`, 'i'), portIdx: 2, hostIdx: 1 },
  ];
  for (const { re, portIdx, hostIdx } of tests) {
    const match = m.match(re);
    if (match) {
      const p = parseInt(match[portIdx], 10);
      const h = match[hostIdx];
      if (p >= 1 && p <= 65535 && h) return { host: h, port: p };
    }
  }
  return null;
}

/** Detect port-test intent without host (e.g. "test port 80 on it") */
function detectPortTestIntentWithoutHost(message) {
  const m = message.trim();
  return /\b(?:test|check)\s+port\s+\d{1,5}\s+(?:on\s+)?(it|that|them)\s*[?.]?$/i.test(m) ||
    /\bport\s+\d{1,5}\s+on\s+(it|that|them)\s*[?.]?$/i.test(m);
}

/** Extract port number from message when we have intent but need port from context (e.g. "test port 80 on it") */
function extractPortFromMessage(message) {
  const match = message.trim().match(/\bport\s+(\d{1,5})\b/i);
  if (match) {
    const p = parseInt(match[1], 10);
    if (p >= 1 && p <= 65535) return p;
  }
  return null;
}

/** Detect if the user is asking for ping and extract host (and optional count) */
function detectPingRequest(message) {
  const m = message.trim();
  const pingRe = /\bping\s+([a-zA-Z0-9.\-_:\[\]]+)(?:\s+(\d+))?/i;
  const match = m.match(pingRe);
  if (match) return { host: match[1], count: match[2] ? parseInt(match[2], 10) : 4 };
  return null;
}

/** Detect if the user wants to ping but didn't specify a host (e.g. "can you ping it?", "ping it") */
function detectPingIntentWithoutHost(message) {
  const m = message.trim();
  return /\b(?:can you |please |could you )?ping\s*(it|that|them)?\s*[?.]?$/i.test(m) ||
    /^ping\s*(it|that|them)\s*[?.]?$/i.test(m);
}

/** Detect if the user is asking for traceroute and extract host (and optional max hops) */
function detectTracerouteRequest(message) {
  const m = message.trim();
  const traceRe = /\b(?:traceroute|tracert|trace\s+route)\s+(?:to\s+)?([a-zA-Z0-9.\-_:\[\]]+)(?:\s+(\d+))?/i;
  const match = m.match(traceRe);
  if (match) return { host: match[1], maxHops: match[2] ? parseInt(match[2], 10) : 15 };
  return null;
}

/** Detect if the user wants traceroute but didn't specify a host (e.g. "traceroute to it") */
function detectTracerouteIntentWithoutHost(message) {
  const m = message.trim();
  return /\b(?:can you |please )?(?:traceroute|tracert|trace\s+route)\s*(?:to\s+)?(it|that|them)\s*[?.]?$/i.test(m) ||
    /^(?:traceroute|tracert)\s*(?:to\s+)?(it|that|them)\s*[?.]?$/i.test(m);
}

const IPV4_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const HOSTNAME_REGEX = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/g;

/** Extract the most recently mentioned IP or hostname from conversation text (e.g. to resolve "it") */
function resolveHostFromConversation(conversationText) {
  if (typeof conversationText !== 'string' || !conversationText.trim()) return null;
  const ips = conversationText.match(IPV4_REGEX);
  if (ips && ips.length > 0) return ips[ips.length - 1];
  const hosts = conversationText.match(HOSTNAME_REGEX);
  if (hosts && hosts.length > 0) return hosts[hosts.length - 1];
  return null;
}

module.exports = {
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
  sanitizeHost,
};
