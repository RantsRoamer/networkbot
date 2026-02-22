// utils/llm.js
const { Configuration, OpenAIApi } = require('openai');
const axios = require('axios');
const { getConfig } = require('./config');

// Get configuration
function getLLMConfig() {
  const config = getConfig();
  return {
    provider: config.llm?.provider || process.env.LLM_PROVIDER || 'openai',
    openai: {
      apiKey: config.llm?.openai?.apiKey || process.env.OPENAI_API_KEY || '',
      model: config.llm?.openai?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    },
    ollama: {
      baseUrl: config.llm?.ollama?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: config.llm?.ollama?.model || process.env.OLLAMA_MODEL || 'llama2',
    },
  };
}

// Initialize OpenAI client
let openai = null;
function initializeOpenAI() {
  const config = getLLMConfig();
  if (config.provider === 'openai' && config.openai.apiKey) {
    try {
      const configuration = new Configuration({ apiKey: config.openai.apiKey });
      openai = new OpenAIApi(configuration);
    } catch (error) {
      console.error('Error initializing OpenAI:', error.message);
      openai = null;
    }
  } else {
    openai = null;
  }
}

// Initialize on load
initializeOpenAI();

// Re-export LLM_PROVIDER for backward compatibility
const LLM_PROVIDER = getLLMConfig().provider;

// Long timeout for AI requests so "thinking" / processing models don't get cut off (10 minutes)
const AI_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Convert chat history from frontend format [{role:'user'|'bot', message}] to API format [{role, content}]
 */
function formatHistoryForApi(history) {
  if (!Array.isArray(history) || history.length === 0) return [];
  return history.map((h) => ({
    role: h.role === 'bot' ? 'assistant' : 'user',
    content: typeof h.message === 'string' ? h.message : String(h.message || ''),
  })).filter((m) => m.content.length > 0);
}

/**
 * Query OpenAI API (supports conversation history for context)
 */
async function queryOpenAI(prompt, systemPrompt = null, conversationHistory = null) {
  const config = getLLMConfig();
  
  // Reinitialize if needed
  if (!openai && config.provider === 'openai') {
    initializeOpenAI();
  }
  
  if (!openai) {
    throw new Error('OpenAI API key not configured. Please configure it in the web interface or set OPENAI_API_KEY environment variable.');
  }

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  const history = formatHistoryForApi(conversationHistory);
  messages.push(...history);
  messages.push({ role: 'user', content: prompt });

  const response = await openai.createChatCompletion({
    model: config.openai.model,
    messages: messages,
    temperature: 0.2,
    max_tokens: 4096,
  });

  return response.data.choices[0].message.content.trim();
}

/**
 * Query Ollama API (supports conversation history via /api/chat)
 */
async function queryOllama(prompt, systemPrompt = null, conversationHistory = null) {
  const config = getLLMConfig();
  
  const history = formatHistoryForApi(conversationHistory);
  const hasHistory = history.length > 0;

  try {
    if (hasHistory) {
      // Use /api/chat for multi-turn context
      const messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push(...history);
      messages.push({ role: 'user', content: prompt });

      const response = await axios.post(`${config.ollama.baseUrl}/api/chat`, {
        model: config.ollama.model,
        messages,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 4096,
        },
      }, {
        timeout: AI_REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      });

      const msg = response.data?.message;
      if (msg && typeof msg.content === 'string') {
        return msg.content.trim();
      }
      throw new Error('Invalid response from Ollama /api/chat');
    }

    // No history: use /api/generate (single prompt)
    const requestBody = {
      model: config.ollama.model,
      prompt: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
      stream: false,
      options: {
        temperature: 0.2,
        num_predict: 4096,
      },
    };

    const response = await axios.post(`${config.ollama.baseUrl}/api/generate`, requestBody, {
      timeout: AI_REQUEST_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.data && response.data.response) {
      return response.data.response.trim();
    }
    throw new Error('Invalid response from Ollama API');
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      throw new Error(`Cannot connect to Ollama server at ${config.ollama.baseUrl}. Make sure Ollama is running.`);
    }
    if (error.response) {
      throw new Error(`Ollama API error: ${error.response.status} - ${error.response.statusText}`);
    }
    throw error;
  }
}

/**
 * Stream Ollama /api/chat (stream: true). Yields text chunks; throws on connection/API errors.
 */
async function* streamOllamaChat(prompt, systemPrompt = null, conversationHistory = null) {
  const config = getLLMConfig();
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push(...formatHistoryForApi(conversationHistory || []));
  messages.push({ role: 'user', content: prompt });

  const response = await axios({
    method: 'post',
    url: `${config.ollama.baseUrl}/api/chat`,
    data: {
      model: config.ollama.model,
      messages,
      stream: true,
      options: { temperature: 0.2, num_predict: 4096 },
    },
    responseType: 'stream',
    timeout: AI_REQUEST_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json' },
  });

  let buffer = '';
  for await (const chunk of response.data) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        const text = obj.message?.content ?? obj.response;
        if (typeof text === 'string' && text.length > 0) yield text;
      } catch (_) { /* skip malformed line */ }
    }
  }
  if (buffer.trim()) {
    try {
      const obj = JSON.parse(buffer.trim());
      const text = obj.message?.content ?? obj.response;
      if (typeof text === 'string' && text.length > 0) yield text;
    } catch (_) {}
  }
}

/**
 * Stream OpenAI chat completion via axios (SSE). Yields text chunks.
 */
async function* streamOpenAIChat(prompt, systemPrompt = null, conversationHistory = null) {
  const config = getLLMConfig();
  const apiKey = config.openai.apiKey;
  if (!apiKey) throw new Error('OpenAI API key not configured.');

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push(...formatHistoryForApi(conversationHistory || []));
  messages.push({ role: 'user', content: prompt });

  const response = await axios({
    method: 'post',
    url: 'https://api.openai.com/v1/chat/completions',
    data: {
      model: config.openai.model,
      messages,
      temperature: 0.2,
      max_tokens: 4096,
      stream: true,
    },
    responseType: 'stream',
    timeout: AI_REQUEST_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  let buffer = '';
  for await (const chunk of response.data) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        const text = parsed.choices?.[0]?.delta?.content;
        if (typeof text === 'string' && text.length > 0) yield text;
      } catch (_) {}
    }
  }
}

/**
 * Stream AI response chunk-by-chunk. Yields string chunks.
 * Use when debugShowThoughtStream is on so the client can show the thought stream.
 */
async function* streamQuery(prompt, systemPrompt = null, conversationHistory = null) {
  const config = getLLMConfig();
  if (config.provider === 'ollama') {
    yield* streamOllamaChat(prompt, systemPrompt, conversationHistory);
  } else {
    yield* streamOpenAIChat(prompt, systemPrompt, conversationHistory);
  }
}

/**
 * Main AI query function that routes to the appropriate provider.
 * conversationHistory: optional array of { role: 'user'|'bot', message } from frontend (for context).
 */
async function aiQuery(prompt, systemPrompt = null, conversationHistory = null) {
  const config = getLLMConfig();
  try {
    if (config.provider === 'ollama') {
      return await queryOllama(prompt, systemPrompt, conversationHistory);
    } else {
      return await queryOpenAI(prompt, systemPrompt, conversationHistory);
    }
  } catch (error) {
    console.error(`[LLM Error] ${config.provider} query failed:`, error.message);
    throw error;
  }
}

/**
 * Test Ollama connection
 */
async function testOllamaConnection(baseUrl, model) {
  try {
    const response = await axios.post(`${baseUrl}/api/generate`, {
      model: model,
      prompt: 'test',
      stream: false,
    }, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return { success: true, message: 'Connection successful' };
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      return { success: false, message: `Cannot connect to ${baseUrl}. Make sure Ollama is running.` };
    }
    return { success: false, message: error.message };
  }
}

module.exports = { aiQuery, streamQuery, LLM_PROVIDER, getLLMConfig, initializeOpenAI, testOllamaConnection };
