# NetworkBot – AI‑powered network monitoring

## Overview

> **NetworkBot** is a web-based AI assistant for network monitoring. It uses a large‑language model (LLM) to answer questions about your infrastructure, with optional integration to UniFi Network and UniFi Site Manager.
>
> - Chat with the AI about status, logs, and diagnostics in a Matrix-style web UI.
> - Fetch current metrics from your monitoring system or paste log snippets for analysis.
> - Configure LLM (OpenAI or Ollama), monitoring integrations, and server settings from the same interface.
>
> NetworkBot is **Node.js** + **Express** and supports **OpenAI** or **Ollama** as the LLM provider.

## Features

| Feature | How it works |
|---------|--------------|
| **Web Chat** | Ask questions in the browser; the AI uses monitoring data when available and returns structured, human-readable answers. |
| **Web Configuration** | Configure LLM provider, API keys, models, UniFi Network/Site Manager, port, and auth—all from the UI. |
| **UniFi integrations** | Optional: pull devices and clients from UniFi Network; sites and devices from UniFi Site Manager (cloud). |
| **Structured AI output** | Status summary tables, error checks, conclusion, and next steps for easy scanning. |
| **Docker** | Docker Compose stack for deployment. |

## 📦 Installation

1. **Clone the repo**:
   ```bash
   git clone https://github.com/your-username/networkbot-ai.git
   cd networkbot-ai
   ```
2. **Create a `.env` file** (optional; you can configure everything in the web UI):
   ```ini
   # LLM Provider (choose one)
   LLM_PROVIDER=openai  # or 'ollama'
   
   # For OpenAI
   OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   OPENAI_MODEL=gpt-4o-mini
   
   # For Ollama (if LLM_PROVIDER=ollama)
   # OLLAMA_BASE_URL=http://localhost:11434
   # OLLAMA_MODEL=llama2
   
   PORT=3000
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Run**:
   ```bash
   npm start
   ```
   The app runs a **single server** on `http://localhost:3000` (or the port you set in config).
5. **Open the web interface**:
   - Go to `http://localhost:3000`
   - Log in (default: `admin` / `admin` — change this in Configuration!)
   - Use **Chat** to talk to the AI and **Config** to set LLM, monitoring, and server options.

## 🌐 Web Interface

### Accessing the Web Interface

1. Start NetworkBot: `npm start`
2. Open your browser to `http://localhost:3000`
3. Log in with your credentials (default: `admin` / `admin`)

### Features

- ✅ **Switch LLM Providers**: Toggle between OpenAI and Ollama with one click
- ✅ **Configure API Keys**: Securely store and update API keys
- ✅ **Model Selection**: Choose different models for each provider
- ✅ **Monitoring**: Configure UniFi Network and UniFi Site Manager from the web UI—add/remove controllers, test connections
- ✅ **Test Connections**: Verify Ollama and each monitoring integration before saving
- ✅ **Server Settings**: Adjust port and log levels
- ✅ **Real-time Updates**: Changes take effect immediately (some may require restart)

### Security

- The web interface is protected with HTTP Basic Authentication
- Default credentials: `admin` / `admin` - **CHANGE THIS IN PRODUCTION!**
- Set custom credentials via environment variables:
  ```ini
  WEB_AUTH_USERNAME=your_username
  WEB_AUTH_PASSWORD=your_secure_password
  ```
- Or configure through the web interface itself (stored in `config.json`)

### Configuration Storage

- Settings are saved to `config.json` in the project root
- Environment variables take precedence over config file
- The web interface updates `config.json` directly

## 🤖 Ollama Setup

NetworkBot supports **Ollama** for local LLM inference. This is perfect for privacy-sensitive environments or when you want to avoid API costs.

1. **Install Ollama**:
   - Visit [https://ollama.ai](https://ollama.ai) and download for your platform
   - Or use Docker: `docker run -d -p 11434:11434 ollama/ollama`

2. **Pull a model**:
   ```bash
   ollama pull llama2
   # or
   ollama pull mistral
   # or any other supported model
   ```

3. **Configure NetworkBot**:
   ```ini
   LLM_PROVIDER=ollama
   OLLAMA_BASE_URL=http://localhost:11434
   OLLAMA_MODEL=llama2
   ```

4. **Verify Ollama is running**:
   ```bash
   curl http://localhost:11434/api/tags
   ```

> **Note**: If running NetworkBot in Docker and Ollama on the host, use `OLLAMA_BASE_URL=http://host.docker.internal:11434` or configure Docker networking.

## 📡 UniFi Network monitoring

NetworkBot can pull metrics from UniFi Network (devices, clients) using the **official UniFi Network API**.

- **API reference**: [UniFi Network API – Getting started](https://developer.ui.com/network/v10.1.84/gettingstarted)
- **API key**: Create in **Network → Control Plane → Integrations** (or Controller **Settings → API Access** on older versions).
- **Base URL**: Use your controller URL (e.g. `https://10.69.69.1` or `https://unifi.example.com`). For UDM Pro / UniFi OS, the app uses `/proxy/network` or `/unifi-api/network` automatically.
- Authentication uses the **X-API-Key** header when supported; local controllers fall back to session login with the same key.

Configure one or more UniFi Network controllers in the web UI under **Configuration → Monitoring → UniFi Network**.

## ☁️ UniFi Site Manager (cloud)

NetworkBot can pull **sites and devices** from the cloud **UniFi Site Manager API** for a single UI account.

- **API reference**: [UniFi Site Manager API – Getting started](https://developer.ui.com/site-manager/v1.0.0/gettingstarted)
- **Base URL**: `https://api.ui.com` (default)
- **Authentication**: **X-API-Key** header. Create a key in your UI account: **Settings → API Keys** (EA) or **API** section (GA).
- **Rate limits**: EA 100 req/min; v1 stable 10,000 req/min (read-only).

Enable in the web UI under **Configuration → Monitoring → UniFi Site Manager (cloud)** (checkbox + API key + optional base URL), or in `config.json` → `monitoring.siteManager`. Test with **Test Site Manager** or `POST /api/monitoring/test-site-manager`.

## 🚀 Usage

- Open the **Chat** tab and type a question (e.g. “Summarize UniFi device status” or “What do these logs indicate?”).
- The AI uses monitoring data when configured and returns a structured reply (status summary, error check, conclusion, next steps).
- Use the **Configuration** tab to set the LLM provider, API keys, UniFi integrations, and server port/auth.

## 🔧 Architecture

- **Express** serves the web UI and API (chat, config, monitoring tests).
- **LLM** queries go to OpenAI or Ollama based on configuration.
- **Monitoring** (optional) pulls data from UniFi Network and Site Manager and injects it into the AI context.

## 📁 Project Structure

```
networkbot-ai/
├─ app.js             # Express server, API routes, chat & config
├─ public/            # Web UI (Matrix-style)
├─ utils/
│ ├─ llm.js          # LLM query helper (OpenAI / Ollama)
│ └─ logAnalyzer.js  # Config & monitoring (see config.js, monitoring.js)
├─ docker-compose.yml
├─ Dockerfile
├─ package.json
└─ README.md
```

## Extending

| Goal | Where to extend |
|------|----------------|
| Query Prometheus | `utils/prometheus.js` – add a function that runs ``curl`` or uses the official client and formats output for the LLM |
| Persist logs | Add a small SQLite database and `utils/logger.js` |
| Multi‑language LLM | Replace the `OpenAIApi` call with a LangChain provider |

## Contributing

1. Fork the repo.
2. Create a feature branch (`git checkout -b feature/xxxx`).
3. Add tests under `__tests__`.
4. Ensure `npm test` passes.
5. Open a pull request.

## License

MIT – feel free to adapt and distribute.

---

> **Tip** – If you want a ready‑loaded environment, use the Docker stack below.

## 🎉 Docker Compose

The included `docker-compose.yml` provides:
- **NetworkBot service** with health checks
- **Optional Ollama service** (commented out by default)
- Proper networking configuration

### Build & run
```bash
docker compose up --build
```

The web interface will be available at `http://localhost:3000`.

### Running with Ollama in Docker
Uncomment the `ollama` service in `docker-compose.yml` and set `OLLAMA_BASE_URL=http://ollama:11434` in your `.env` file.

## ✨ Features & Improvements

- ✅ **Web Configuration Interface**: Beautiful UI for managing all settings
- ✅ **Dual LLM Support**: Works with both OpenAI and Ollama
- ✅ **Robust Error Handling**: Graceful error messages and logging
- ✅ **Matrix-style UI**: Dark theme with green/cyan terminal aesthetic
- ✅ **Enhanced Log Analysis**: Extracts errors, warnings, IPs, timestamps, and URLs
- ✅ **Environment Validation**: Checks required config on startup
- ✅ **Health Checks**: Docker health monitoring included
- ✅ **Better Logging**: Configurable log levels and structured output
- ✅ **Configuration Management**: JSON-based config with web UI and env var support
