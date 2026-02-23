// utils/webhook.js – send webhook notifications to Slack, Discord, Teams, ntfy, or generic endpoints

const axios = require('axios');
const { getConfig } = require('./config');

const WEBHOOK_TIMEOUT_MS = 10000;

function getWebhookConfig() {
  return getConfig().webhook || {};
}

/**
 * Build the request body for each service type.
 * Returns { body, headers, isText } where isText = send as plain text (ntfy).
 */
function buildRequest(type, title, text) {
  switch ((type || 'generic').toLowerCase()) {
    case 'slack':
      return {
        body: {
          text: `*${title}*\n${text.slice(0, 3000)}`,
          username: 'NetworkBot',
          icon_emoji: ':satellite:',
        },
        headers: { 'Content-Type': 'application/json' },
      };

    case 'discord':
      return {
        body: {
          content: `**${title}**\n${text.slice(0, 1990)}`,
          username: 'NetworkBot',
        },
        headers: { 'Content-Type': 'application/json' },
      };

    case 'teams':
      return {
        body: {
          '@type': 'MessageCard',
          '@context': 'https://schema.org/extensions',
          summary: title,
          themeColor: '00ff41',
          title,
          text: text.slice(0, 4000),
        },
        headers: { 'Content-Type': 'application/json' },
      };

    case 'ntfy':
      return {
        body: text.slice(0, 4096),
        headers: {
          'Title': title.slice(0, 255),
          'Content-Type': 'text/plain',
        },
        isText: true,
      };

    default: // generic
      return {
        body: {
          title,
          text: text.slice(0, 4000),
          timestamp: new Date().toISOString(),
          source: 'NetworkBot',
        },
        headers: { 'Content-Type': 'application/json' },
      };
  }
}

/**
 * Send a webhook notification using the current config.
 * @param {Object} options - { title, text }
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendWebhook({ title, text }) {
  const wh = getWebhookConfig();
  if (!wh.enabled || !wh.url?.trim()) {
    return { success: false, error: 'Webhook not enabled or URL not configured.' };
  }

  const url = wh.url.trim();
  const type = wh.type || 'generic';

  try {
    const { body, headers } = buildRequest(type, title || 'NetworkBot', text || '');
    await axios.post(url, body, {
      timeout: WEBHOOK_TIMEOUT_MS,
      headers,
    });
    return { success: true };
  } catch (err) {
    const msg = err.response
      ? `HTTP ${err.response.status}: ${err.response.statusText}`
      : err.message || 'Request failed';
    return { success: false, error: msg };
  }
}

/**
 * Send a test webhook message to verify the configuration.
 */
async function testWebhook() {
  return sendWebhook({
    title: 'NetworkBot – Test notification',
    text: `This is a test webhook from NetworkBot.\nTime: ${new Date().toISOString()}\n\nIf you received this, webhook notifications are working.`,
  });
}

module.exports = { sendWebhook, testWebhook, getWebhookConfig };
