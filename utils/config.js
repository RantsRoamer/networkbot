// utils/config.js
// Configuration management system

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const DEFAULT_CONFIG = {
  llm: {
    provider: 'openai', // 'openai' or 'ollama'
    openai: {
      apiKey: '',
      model: 'gpt-4o-mini',
    },
    ollama: {
      baseUrl: 'http://localhost:11434',
      model: 'llama2',
    },
    debugShowThoughtStream: false, // when true, stream AI response in chat (SSE)
  },
  monitoring: {
    unifi: {
      controllers: [], // Array of UniFi Network controllers with API keys
    },
    siteManager: {
      // UniFi Site Manager API (cloud): https://developer.ui.com/site-manager/v1.0.0/gettingstarted
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.ui.com', // optional override
    },
    prometheus: {
      enabled: false,
      baseUrl: '',
      basicAuth: null,
    },
  },
  server: {
    port: 3000,
    logLevel: 'INFO',
  },
  web: {
    enabled: true,
    port: 3000,
    auth: {
      username: 'admin',
      password: '', // Will be set from env or generated
    },
  },
  webhook: {
    enabled: false,
    url: '',
    type: 'slack', // 'slack', 'discord', 'teams', 'ntfy', 'generic'
  },
  email: {
    enabled: false,
    smtp: {
      host: '',
      port: 587,
      secure: false, // true for 465
      auth: {
        user: '',
        pass: '',
      },
    },
    from: '', // e.g. "NetworkBot <noreply@example.com>"
    to: '',   // default recipient for notifications
  },
};

/**
 * Load configuration from file or return defaults
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');
      const config = JSON.parse(fileContent);
      // Merge with defaults to ensure all keys exist
      return mergeConfig(DEFAULT_CONFIG, config);
    }
  } catch (error) {
    console.error('⚠️  Error loading config file:', error.message);
    console.log('📝 Using default configuration');
  }
  
  // Load from environment variables if config file doesn't exist
  const envConfig = loadFromEnv();
  return mergeConfig(DEFAULT_CONFIG, envConfig);
}

/**
 * Load configuration from environment variables
 */
function loadFromEnv() {
  const config = {};
  
  if (process.env.LLM_PROVIDER) {
    config.llm = { provider: process.env.LLM_PROVIDER };
  }
  
  if (process.env.OPENAI_API_KEY) {
    config.llm = config.llm || {};
    config.llm.openai = {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    };
  }
  
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
    config.llm = config.llm || {};
    config.llm.ollama = {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'llama2',
    };
  }
  
  if (process.env.PORT) {
    config.server = { port: parseInt(process.env.PORT) };
  }
  
  if (process.env.LOG_LEVEL) {
    config.server = config.server || {};
    config.server.logLevel = process.env.LOG_LEVEL;
  }
  
  if (process.env.WEB_AUTH_USERNAME || process.env.WEB_AUTH_PASSWORD) {
    config.web = config.web || {};
    config.web.auth = {
      username: process.env.WEB_AUTH_USERNAME || 'admin',
      password: process.env.WEB_AUTH_PASSWORD || 'admin', // Default to 'admin' if not set
    };
  }
  
  // Monitoring configuration from env (optional - for backward compatibility)
  if (process.env.UNIFI_BASE_URL && process.env.UNIFI_API_KEY) {
    config.monitoring = config.monitoring || {};
    config.monitoring.unifi = config.monitoring.unifi || {};
    config.monitoring.unifi.controllers = config.monitoring.unifi.controllers || [];
    
    // Add single controller from env vars
    config.monitoring.unifi.controllers.push({
      id: 'env-controller',
      name: 'UniFi Controller (from env)',
      enabled: true,
      baseUrl: process.env.UNIFI_BASE_URL,
      apiKey: process.env.UNIFI_API_KEY,
      site: process.env.UNIFI_SITE || 'default',
      verifySSL: process.env.UNIFI_VERIFY_SSL !== 'false',
    });
  }
  
  return config;
}

/**
 * Merge two config objects deeply
 */
function mergeConfig(defaultConfig, userConfig) {
  const merged = JSON.parse(JSON.stringify(defaultConfig));
  
  for (const key in userConfig) {
    if (userConfig[key] && typeof userConfig[key] === 'object' && !Array.isArray(userConfig[key])) {
      merged[key] = mergeConfig(merged[key] || {}, userConfig[key]);
    } else {
      merged[key] = userConfig[key];
    }
  }
  
  return merged;
}

/**
 * Save configuration to file
 */
function saveConfig(config) {
  try {
    // Ensure directory exists
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    // Write config file
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log('✅ Configuration saved successfully');
    return true;
  } catch (error) {
    console.error('❌ Error saving config:', error.message);
    throw error;
  }
}

/**
 * Get current configuration
 */
let currentConfig = loadConfig();

function getConfig() {
  return currentConfig;
}

/**
 * Update configuration
 */
function updateConfig(updates) {
  currentConfig = mergeConfig(currentConfig, updates);
  saveConfig(currentConfig);
  return currentConfig;
}

/**
 * Reload configuration from file
 */
function reloadConfig() {
  currentConfig = loadConfig();
  return currentConfig;
}

module.exports = {
  getConfig,
  updateConfig,
  reloadConfig,
  saveConfig,
  CONFIG_FILE,
};
