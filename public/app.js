// Web interface JavaScript

let currentConfig = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('configTab')) {
        loadConfig();
        setupEventListeners();
    }
    if (document.getElementById('schedulesTab')) {
        setupSchedulesEvents();
    }
});

// Setup event listeners
function setupEventListeners() {
    const form = document.getElementById('configForm');
    form.addEventListener('submit', handleSubmit);

    const providerSelect = document.getElementById('llmProvider');
    providerSelect.addEventListener('change', toggleProviderSections);

    document.getElementById('reloadBtn').addEventListener('click', loadConfig);
    document.getElementById('testConfigBtn').addEventListener('click', testConfiguration);
    document.getElementById('testOllama').addEventListener('click', testOllamaConnection);
    
    // Monitoring: UniFi Network, Site Manager
    document.getElementById('addUnifiControllerBtn')?.addEventListener('click', () => addUnifiController());
    document.getElementById('testSiteManagerBtn')?.addEventListener('click', testSiteManagerConnection);
    document.getElementById('testEmailBtn')?.addEventListener('click', testEmailConnection);
    setupUnifiControllers();

    document.getElementById('dashboardRefreshBtn')?.addEventListener('click', () => loadDashboard());

    // Config tabs
    setupConfigTabs();
}

// Setup config tab navigation
function setupConfigTabs() {
    const tabButtons = document.querySelectorAll('.config-tab-button');
    const tabContents = document.querySelectorAll('.config-tab-content');

    const tabIdMap = {
        'ai': 'configTabAi',
        'monitoring': 'configTabMonitoring',
        'server': 'configTabServer',
        'email': 'configTabEmail'
    };

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.getAttribute('data-config-tab');

            // Update buttons
            tabButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            // Update content
            tabContents.forEach(content => content.classList.remove('active'));
            const targetId = tabIdMap[targetTab];
            if (targetId) {
                document.getElementById(targetId).classList.add('active');
            }
        });
    });
}

// Load configuration from API
async function loadConfig() {
    try {
        showStatus('Loading configuration...', 'info');
        
        const response = await fetch('/api/config');
        if (!response.ok) {
            if (response.status === 401) {
                // Redirect to login if not authenticated
                window.location.href = '/login';
                return;
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        currentConfig = await response.json();
        populateForm(currentConfig);
        updateStatusInfo(currentConfig);
        showStatus('Configuration loaded successfully', 'success');
    } catch (error) {
        console.error('Error loading config:', error);
        showStatus(`Error loading configuration: ${error.message}`, 'error');
    }
}

// Populate form with configuration
function populateForm(config) {
    // LLM Provider
    document.getElementById('llmProvider').value = config.llm?.provider || 'openai';
    toggleProviderSections();

    // OpenAI settings
    if (config.llm?.openai) {
        document.getElementById('openaiApiKey').value = config.llm.openai.apiKey || '';
        document.getElementById('openaiModel').value = config.llm.openai.model || 'gpt-4o-mini';
    }

    // Ollama settings
    if (config.llm?.ollama) {
        document.getElementById('ollamaBaseUrl').value = config.llm.ollama.baseUrl || 'http://localhost:11434';
        document.getElementById('ollamaModel').value = config.llm.ollama.model || 'llama2';
    }

    // Debug: show thought stream
    const debugStreamEl = document.getElementById('debugShowThoughtStream');
    if (debugStreamEl) debugStreamEl.checked = config.llm?.debugShowThoughtStream === true;

    // UniFi Network controllers
    if (config.monitoring?.unifi?.controllers) {
        const list = document.getElementById('unifiControllersList');
        if (list) {
            list.innerHTML = '';
            config.monitoring.unifi.controllers.forEach((c) => addUnifiController(c));
        }
    }

    // UniFi Site Manager (apiKey may be hidden in API response)
    if (config.monitoring?.siteManager) {
        const sm = config.monitoring.siteManager;
        const enabledEl = document.getElementById('siteManagerEnabled');
        const apiKeyEl = document.getElementById('siteManagerApiKey');
        const baseUrlEl = document.getElementById('siteManagerBaseUrl');
        if (enabledEl) enabledEl.checked = sm.enabled === true;
        if (apiKeyEl) apiKeyEl.value = (sm.apiKey && sm.apiKey !== '***hidden***') ? sm.apiKey : '';
        if (baseUrlEl) baseUrlEl.value = sm.baseUrl || 'https://api.ui.com';
    }

    // Server settings
    if (config.server) {
        document.getElementById('port').value = config.server.port || 3000;
        document.getElementById('logLevel').value = config.server.logLevel || 'INFO';
    }

    // Email / Notifications
    if (config.email) {
        const emailEnabledEl = document.getElementById('emailEnabled');
        const smtpHostEl = document.getElementById('smtpHost');
        const smtpPortEl = document.getElementById('smtpPort');
        const smtpSecureEl = document.getElementById('smtpSecure');
        const smtpUserEl = document.getElementById('smtpUser');
        const smtpPassEl = document.getElementById('smtpPass');
        const emailFromEl = document.getElementById('emailFrom');
        const emailToEl = document.getElementById('emailTo');
        if (emailEnabledEl) emailEnabledEl.checked = config.email.enabled === true;
        if (smtpHostEl) smtpHostEl.value = config.email.smtp?.host || '';
        if (smtpPortEl) smtpPortEl.value = config.email.smtp?.port ?? 587;
        if (smtpSecureEl) smtpSecureEl.checked = config.email.smtp?.secure === true;
        if (smtpUserEl) smtpUserEl.value = config.email.smtp?.auth?.user || '';
        if (smtpPassEl) smtpPassEl.value = (config.email.smtp?.auth?.pass && config.email.smtp.auth.pass !== '***hidden***') ? config.email.smtp.auth.pass : '';
        if (emailFromEl) emailFromEl.value = config.email.from || '';
        if (emailToEl) emailToEl.value = config.email.to || '';
    }
}

// Toggle provider-specific sections
function toggleProviderSections() {
    const provider = document.getElementById('llmProvider').value;
    const openaiSection = document.getElementById('openaiSection');
    const ollamaSection = document.getElementById('ollamaSection');

    if (provider === 'openai') {
        openaiSection.style.display = 'block';
        ollamaSection.style.display = 'none';
    } else {
        openaiSection.style.display = 'none';
        ollamaSection.style.display = 'block';
    }
}

// Handle form submission
async function handleSubmit(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const config = {
        llm: {
            provider: formData.get('llmProvider'),
            openai: {
                apiKey: formData.get('openaiApiKey') || currentConfig?.llm?.openai?.apiKey || '',
                model: formData.get('openaiModel') || 'gpt-4o-mini',
            },
            ollama: {
                baseUrl: formData.get('ollamaBaseUrl') || 'http://localhost:11434',
                model: formData.get('ollamaModel') || 'llama2',
            },
            debugShowThoughtStream: document.getElementById('debugShowThoughtStream')?.checked === true,
        },
        monitoring: {
            unifi: { controllers: getUnifiControllersFromForm() },
            siteManager: {
                enabled: document.getElementById('siteManagerEnabled')?.checked === true,
                apiKey: document.getElementById('siteManagerApiKey')?.value?.trim() || '',
                baseUrl: document.getElementById('siteManagerBaseUrl')?.value?.trim() || 'https://api.ui.com',
            },
        },
        server: {
            port: parseInt(formData.get('port')) || 3000,
            logLevel: formData.get('logLevel') || 'INFO',
        },
        email: {
            enabled: document.getElementById('emailEnabled')?.checked === true,
            smtp: {
                host: (document.getElementById('smtpHost')?.value || '').trim(),
                port: parseInt(document.getElementById('smtpPort')?.value, 10) || 587,
                secure: document.getElementById('smtpSecure')?.checked === true,
                auth: {
                    user: (document.getElementById('smtpUser')?.value || '').trim(),
                    pass: (document.getElementById('smtpPass')?.value || '').trim(),
                },
            },
            from: (document.getElementById('emailFrom')?.value || '').trim(),
            to: (document.getElementById('emailTo')?.value || '').trim(),
        },
    };

    try {
        showStatus('Saving configuration...', 'info');
        
        const response = await fetch('/api/config', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(config),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `HTTP ${response.status}`);
        }

        const savedConfig = await response.json();
        currentConfig = savedConfig;
        updateStatusInfo(savedConfig);
        showStatus('Configuration saved successfully! Note: Server restart may be required for some changes.', 'success');
    } catch (error) {
        console.error('Error saving config:', error);
        showStatus(`Error saving configuration: ${error.message}`, 'error');
    }
}

// Test configuration
async function testConfiguration() {
    try {
        showStatus('Testing configuration...', 'info');
        
        const response = await fetch('/api/config/test', {
            method: 'POST',
        });

        const result = await response.json();
        
        if (result.success) {
            showStatus(`✅ Configuration test passed! ${result.message || ''}`, 'success');
        } else {
            showStatus(`❌ Configuration test failed: ${result.message || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        console.error('Error testing config:', error);
        showStatus(`Error testing configuration: ${error.message}`, 'error');
    }
}

// UniFi Controllers Management
let unifiControllerCounter = 0;

function setupUnifiControllers() {
    // Setup event delegation for dynamic controller items
    const controllersList = document.getElementById('unifiControllersList');
    if (controllersList) {
        controllersList.addEventListener('click', (e) => {
            if (e.target.classList.contains('controller-remove-btn')) {
                e.target.closest('.unifi-controller-item').remove();
            } else if (e.target.classList.contains('controller-test-btn')) {
                testUnifiController(e.target.closest('.unifi-controller-item'));
            }
        });
    }
}

function addUnifiController(controllerData = null, index = null) {
    const template = document.getElementById('unifiControllerTemplate');
    const controllersList = document.getElementById('unifiControllersList');
    
    if (!template || !controllersList) return;
    
    const clone = template.content.cloneNode(true);
    const controllerItem = clone.querySelector('.unifi-controller-item');
    const controllerId = controllerData?.id || `unifi-${Date.now()}-${unifiControllerCounter++}`;
    controllerItem.setAttribute('data-controller-id', controllerId);
    
    // Populate with data if provided
    if (controllerData) {
        controllerItem.querySelector('.controller-enabled').checked = controllerData.enabled !== false;
        controllerItem.querySelector('.controller-name').value = controllerData.name || '';
        controllerItem.querySelector('.controller-baseUrl').value = controllerData.baseUrl || '';
        controllerItem.querySelector('.controller-apiKey').value = controllerData.apiKey || '';
        controllerItem.querySelector('.controller-site').value = controllerData.site || 'default';
        controllerItem.querySelector('.controller-verifySSL').checked = controllerData.verifySSL !== false;
        controllerItem.querySelector('.controller-title').textContent = controllerData.name || 'UniFi Controller';
    }
    
    controllersList.appendChild(clone);
}

function getUnifiControllersFromForm() {
    const controllers = [];
    const controllerItems = document.querySelectorAll('.unifi-controller-item');
    
    controllerItems.forEach((item) => {
        const controllerId = item.getAttribute('data-controller-id');
        const enabled = item.querySelector('.controller-enabled').checked;
        const name = item.querySelector('.controller-name').value.trim();
        const baseUrl = item.querySelector('.controller-baseUrl').value.trim();
        const apiKey = item.querySelector('.controller-apiKey').value.trim();
        const site = item.querySelector('.controller-site').value.trim() || 'default';
        const verifySSL = item.querySelector('.controller-verifySSL').checked;
        
        // Only include controllers with required fields
        if (name && baseUrl && apiKey) {
            controllers.push({
                id: controllerId,
                name: name,
                enabled: enabled,
                baseUrl: baseUrl,
                apiKey: apiKey,
                site: site,
                verifySSL: verifySSL,
            });
        }
    });
    
    return controllers;
}

async function testSiteManagerConnection() {
    const apiKey = document.getElementById('siteManagerApiKey')?.value?.trim();
    const baseUrl = document.getElementById('siteManagerBaseUrl')?.value?.trim() || 'https://api.ui.com';
    const resultEl = document.getElementById('siteManagerTestResult');
    if (!apiKey) {
        showStatus('Enter Site Manager API key', 'error');
        setTestResult(resultEl, 'Enter API key', false);
        return;
    }
    const btn = document.getElementById('testSiteManagerBtn');
    btn.disabled = true;
    showStatus('Testing Site Manager...', 'info');
    setTestResult(resultEl, 'Testing…', null);
    try {
        const res = await fetch('/api/monitoring/test-site-manager', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey, baseUrl }),
        });
        const result = await res.json();
        const msg = result.message || (result.success ? 'OK' : 'Failed');
        if (result.success) {
            showStatus(`✅ Site Manager: ${msg}`, 'success');
            setTestResult(resultEl, '✓ ' + msg, true);
        } else {
            showStatus(`❌ Site Manager: ${result.message || 'Failed'}`, 'error');
            setTestResult(resultEl, '✗ ' + msg, false);
        }
    } catch (err) {
        showStatus(`Error: ${err.message}`, 'error');
        setTestResult(resultEl, '✗ ' + err.message, false);
    } finally {
        btn.disabled = false;
    }
}

// Test individual UniFi controller
async function testUnifiController(controllerItem) {
    const baseUrl = controllerItem.querySelector('.controller-baseUrl').value.trim();
    const apiKey = controllerItem.querySelector('.controller-apiKey').value.trim();
    const site = controllerItem.querySelector('.controller-site').value.trim() || 'default';
    const verifySSL = controllerItem.querySelector('.controller-verifySSL').checked;
    const testBtn = controllerItem.querySelector('.controller-test-btn');
    const resultEl = controllerItem.querySelector('.controller-test-result');
    
    if (!baseUrl || !apiKey) {
        showStatus('Please fill in Controller URL and API Key before testing', 'error');
        setTestResult(resultEl, 'Fill in URL and API Key', false);
        return;
    }
    
    const originalText = testBtn.textContent;
    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';
    setTestResult(resultEl, 'Testing…', null);
    
    try {
        const response = await fetch('/api/monitoring/test-unifi', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ baseUrl, apiKey, site, verifySSL }),
        });

        const result = await response.json();
        const msg = result.message || (result.success ? 'OK' : 'Unknown error');
        if (result.success) {
            showStatus(`✅ ${controllerItem.querySelector('.controller-name').value || 'UniFi'} connection successful! ${result.message}`, 'success');
            setTestResult(resultEl, '✓ ' + msg, true);
        } else {
            showStatus(`❌ UniFi connection failed: ${result.message || 'Unknown error'}`, 'error');
            setTestResult(resultEl, '✗ ' + msg, false);
        }
    } catch (error) {
        console.error('Error testing UniFi:', error);
        showStatus(`Error testing UniFi: ${error.message}`, 'error');
        setTestResult(resultEl, '✗ ' + error.message, false);
    } finally {
        testBtn.disabled = false;
        testBtn.textContent = originalText;
    }
}

// Test Ollama connection
async function testOllamaConnection() {
    const baseUrl = document.getElementById('ollamaBaseUrl').value || 'http://localhost:11434';
    const model = document.getElementById('ollamaModel').value || 'llama2';
    
    try {
        showStatus('Testing Ollama connection...', 'info');
        
        const response = await fetch('/api/config/test-ollama', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ baseUrl, model }),
        });

        const result = await response.json();
        
        if (result.success) {
            showStatus(`✅ Ollama connection successful! Model "${model}" is available.`, 'success');
        } else {
            showStatus(`❌ Ollama connection failed: ${result.message || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        console.error('Error testing Ollama:', error);
        showStatus(`Error testing Ollama: ${error.message}`, 'error');
    }
}

// Send test email (uses current saved config; save first for custom SMTP)
async function testEmailConnection() {
    const resultEl = document.getElementById('emailTestResult');
    const btn = document.getElementById('testEmailBtn');
    btn.disabled = true;
    showStatus('Sending test email...', 'info');
    setTestResult(resultEl, 'Sending…', null);
    try {
        const res = await fetch('/api/config/test-email', { method: 'POST' });
        const result = await res.json();
        const msg = result.message || result.error || (result.success ? 'Sent' : 'Failed');
        if (result.success) {
            showStatus(`✅ Test email sent to ${currentConfig?.email?.to || 'recipient'}`, 'success');
            setTestResult(resultEl, '✓ ' + msg, true);
        } else {
            showStatus(`❌ Test email failed: ${msg}`, 'error');
            setTestResult(resultEl, '✗ ' + msg, false);
        }
    } catch (err) {
        showStatus(`Error: ${err.message}`, 'error');
        setTestResult(resultEl, '✗ ' + err.message, false);
    } finally {
        btn.disabled = false;
    }
}

// Update status information display
function updateStatusInfo(config) {
    document.getElementById('currentProvider').textContent = config.llm?.provider?.toUpperCase() || 'Unknown';
    document.getElementById('currentStatus').textContent = 'Active';
    document.getElementById('lastUpdated').textContent = new Date().toLocaleString();
}

// Show status message (global bar at top)
function showStatus(message, type = 'info') {
    const statusEl = document.getElementById('status');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = `status-message show ${type}`;
    statusEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (type !== 'error') {
        setTimeout(() => statusEl.classList.remove('show'), 5000);
    }
}

// Inline test result next to Test button (pass/fail visible where user clicked)
function setTestResult(el, message, success) {
    if (!el) return;
    el.textContent = message;
    el.className = 'test-result' + (success === true ? ' success' : success === false ? ' error' : '');
    el.style.display = message ? 'inline' : 'none';
    if (message) {
        clearTimeout(el._clearTimer);
        el._clearTimer = setTimeout(() => {
            el.textContent = '';
            el.className = 'test-result';
            el.style.display = 'none';
        }, 8000);
    }
}

// Dashboard: fetch and render system stats, monitoring summary, recent log
async function loadDashboard() {
    const systemEl = document.getElementById('dashboardSystem');
    const monitoringEl = document.getElementById('dashboardMonitoring');
    const logEl = document.getElementById('dashboardLog');
    if (!systemEl || !monitoringEl || !logEl) return;
    systemEl.innerHTML = '<span class="dashboard-loading">Loading…</span>';
    monitoringEl.innerHTML = '<span class="dashboard-loading">Loading…</span>';
    logEl.innerHTML = '<span class="dashboard-loading">Loading…</span>';
    try {
        const res = await fetch('/api/dashboard');
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();

        const uptime = data.uptimeSeconds ?? 0;
        const uptimeStr = uptime >= 3600
            ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
            : uptime >= 60
                ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
                : `${uptime}s`;
        const schedulerStatus = data.scheduler?.heartbeat === 'ok' ? 'Active' : (data.scheduler?.heartbeat === 'stale' ? 'Stale' : '—');
        const schedulerClass = data.scheduler?.heartbeat === 'ok' ? '' : (data.scheduler?.heartbeat === 'stale' ? 'dashboard-stat-value-warn' : '');
        systemEl.innerHTML = `
            <div class="dashboard-stat"><span class="dashboard-stat-label">Uptime</span><span class="dashboard-stat-value">${uptimeStr}</span></div>
            <div class="dashboard-stat"><span class="dashboard-stat-label">Memory (heap)</span><span class="dashboard-stat-value">${data.memory?.heapUsed ?? '-'} / ${data.memory?.heapTotal ?? '-'} MB</span></div>
            <div class="dashboard-stat"><span class="dashboard-stat-label">RSS</span><span class="dashboard-stat-value">${data.memory?.rss ?? '-'} MB</span></div>
            <div class="dashboard-stat"><span class="dashboard-stat-label">Scheduler</span><span class="dashboard-stat-value ${schedulerClass}">${schedulerStatus}</span></div>
        `;

        let monHtml = '';
        if (data.monitoring?.unifi) {
            const u = data.monitoring.unifi;
            const ctrl = u.controllers;
            const dev = u.devices;
            const cl = u.clients;
            monHtml += `<div class="dashboard-stat"><span class="dashboard-stat-label">UniFi Network</span><span class="dashboard-stat-value">${ctrl?.online ?? 0}/${ctrl?.total ?? 0} controllers</span></div>`;
            if (dev) monHtml += `<div class="dashboard-stat"><span class="dashboard-stat-label">Devices</span><span class="dashboard-stat-value">${dev.online}/${dev.total} online</span></div>`;
            if (cl) monHtml += `<div class="dashboard-stat"><span class="dashboard-stat-label">Clients</span><span class="dashboard-stat-value">${cl.total} (${cl.wireless ?? 0} wireless, ${cl.wired ?? 0} wired)</span></div>`;
        }
        if (data.monitoring?.siteManager) {
            const sm = data.monitoring.siteManager;
            monHtml += `<div class="dashboard-stat"><span class="dashboard-stat-label">Site Manager</span><span class="dashboard-stat-value">${sm.sites?.total ?? 0} site(s), ${sm.devices?.online ?? 0}/${sm.devices?.total ?? 0} devices, ${sm.clients?.total ?? 0} clients</span></div>`;
        }
        if (!monHtml) monHtml = '<span class="dashboard-muted">No monitoring data (configure UniFi Network or Site Manager in Config)</span>';
        monitoringEl.innerHTML = monHtml;

        const log = data.log || [];
        if (log.length === 0) {
            logEl.innerHTML = '<span class="dashboard-muted">No recent entries</span>';
        } else {
            logEl.innerHTML = log.map(entry => {
                const levelClass = entry.level === 'error' ? 'dashboard-log-error' : entry.level === 'warning' ? 'dashboard-log-warning' : 'dashboard-log-info';
                const time = entry.time ? new Date(entry.time).toLocaleString() : '';
                const detail = entry.detail ? ` <span class="dashboard-log-detail">${escapeHtml(entry.detail)}</span>` : '';
                return `<div class="dashboard-log-entry ${levelClass}"><span class="dashboard-log-time">${escapeHtml(time)}</span> [${escapeHtml(entry.source)}] ${escapeHtml(entry.message)}${detail}</div>`;
            }).join('');
        }
    } catch (err) {
        systemEl.innerHTML = `<span class="dashboard-error">${escapeHtml(err.message)}</span>`;
        monitoringEl.innerHTML = '';
        logEl.innerHTML = `<span class="dashboard-error">${escapeHtml(err.message)}</span>`;
    }
}

function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

// ==================== Schedules tab ====================

function setupSchedulesEvents() {
    const scheduleType = document.getElementById('scheduleType');
    const intervalGroup = document.getElementById('scheduleIntervalGroup');
    const runAtGroup = document.getElementById('scheduleRunAtGroup');
    if (scheduleType) {
        scheduleType.addEventListener('change', () => {
            const isRecurring = scheduleType.value === 'recurring';
            intervalGroup.style.display = isRecurring ? 'block' : 'none';
            runAtGroup.style.display = isRecurring ? 'none' : 'block';
        });
    }

    document.getElementById('scheduleForm')?.addEventListener('submit', handleScheduleSubmit);
    document.getElementById('scheduleCancelBtn')?.addEventListener('click', clearScheduleForm);
    document.getElementById('schedulesRefreshBtn')?.addEventListener('click', () => loadSchedules());

    const listEl = document.getElementById('schedulesList');
    if (listEl) {
        listEl.addEventListener('click', (e) => {
            const item = e.target.closest('.schedule-item');
            if (!item) return;
            const id = item.getAttribute('data-job-id');
            if (e.target.classList.contains('schedule-run-btn')) runScheduleNow(id);
            else if (e.target.classList.contains('schedule-edit-btn')) editSchedule(id);
            else if (e.target.classList.contains('schedule-delete-btn')) deleteSchedule(id);
        });
    }
}

async function loadSchedules() {
    const listEl = document.getElementById('schedulesList');
    const heartbeatEl = document.getElementById('schedulerHeartbeat');
    if (!listEl) return;
    try {
        const [jobsRes, heartbeatRes] = await Promise.all([
            fetch('/api/schedules'),
            fetch('/api/scheduler/heartbeat'),
        ]);
        if (!jobsRes.ok) throw new Error('Failed to load schedules');
        const jobs = await jobsRes.json();
        renderScheduleList(jobs);

        if (heartbeatEl && heartbeatRes.ok) {
            const hb = await heartbeatRes.json();
            heartbeatEl.textContent = hb.status === 'ok' ? '● Scheduler active' : (hb.status === 'stale' ? '○ Scheduler stale' : '—');
            heartbeatEl.className = 'scheduler-heartbeat ' + (hb.status === 'ok' ? 'heartbeat-ok' : 'heartbeat-stale');
        }
    } catch (err) {
        listEl.innerHTML = '<p class="dashboard-error">' + escapeHtml(err.message) + '</p>';
        if (heartbeatEl) heartbeatEl.textContent = '—';
    }
}

function renderScheduleList(jobs) {
    const listEl = document.getElementById('schedulesList');
    const template = document.getElementById('scheduleItemTemplate');
    if (!listEl || !template) return;
    if (!jobs || jobs.length === 0) {
        listEl.innerHTML = '<p class="dashboard-muted">No scheduled jobs. Add one using the form.</p>';
        return;
    }
    listEl.innerHTML = '';
    jobs.forEach((job) => {
        const clone = template.content.cloneNode(true);
        const item = clone.querySelector('.schedule-item');
        item.setAttribute('data-job-id', job.id);
        item.querySelector('.schedule-item-name').textContent = job.name || job.request?.slice(0, 40) || job.id;
        const badges = [];
        if (job.type === 'recurring') badges.push(`every ${job.intervalMinutes}m`);
        else if (job.runAt) badges.push('once @ ' + new Date(job.runAt).toLocaleString());
        if (job.notify !== 'never') badges.push(job.notify === 'on_issues' ? 'email on issues' : 'email always');
        if (!job.enabled) badges.push('paused');
        item.querySelector('.schedule-item-badges').textContent = badges.join(' · ');
        item.querySelector('.schedule-item-meta').innerHTML = (job.lastRunAt ? 'Last: ' + new Date(job.lastRunAt).toLocaleString() : 'Never run') +
            (job.nextRunAt ? ' · Next: ' + new Date(job.nextRunAt).toLocaleString() : '');
        item.querySelector('.schedule-item-request').textContent = job.request || '—';
        listEl.appendChild(clone);
    });
}

function clearScheduleForm() {
    document.getElementById('scheduleJobId').value = '';
    document.getElementById('scheduleFormTitle').textContent = 'Add scheduled check';
    document.getElementById('scheduleSubmitBtn').textContent = 'Add';
    document.getElementById('scheduleName').value = '';
    document.getElementById('scheduleRequest').value = '';
    document.getElementById('scheduleType').value = 'recurring';
    document.getElementById('scheduleIntervalMinutes').value = '5';
    document.getElementById('scheduleRunAt').value = '';
    document.getElementById('scheduleNotify').value = 'never';
    document.getElementById('scheduleNotifyEmail').value = '';
    document.getElementById('scheduleEnabled').checked = true;
    document.getElementById('scheduleIntervalGroup').style.display = 'block';
    document.getElementById('scheduleRunAtGroup').style.display = 'none';
}

function openEditForm(job) {
    document.getElementById('scheduleJobId').value = job.id;
    document.getElementById('scheduleFormTitle').textContent = 'Edit scheduled check';
    document.getElementById('scheduleSubmitBtn').textContent = 'Save';
    document.getElementById('scheduleName').value = job.name || '';
    document.getElementById('scheduleRequest').value = job.request || '';
    document.getElementById('scheduleType').value = job.type || 'recurring';
    document.getElementById('scheduleIntervalMinutes').value = job.intervalMinutes || 5;
    document.getElementById('scheduleRunAt').value = job.runAt ? new Date(job.runAt).toISOString().slice(0, 16) : '';
    document.getElementById('scheduleNotify').value = job.notify || 'never';
    document.getElementById('scheduleNotifyEmail').value = job.notifyEmail || '';
    document.getElementById('scheduleEnabled').checked = job.enabled !== false;
    const isRecurring = (job.type || 'recurring') === 'recurring';
    document.getElementById('scheduleIntervalGroup').style.display = isRecurring ? 'block' : 'none';
    document.getElementById('scheduleRunAtGroup').style.display = isRecurring ? 'none' : 'block';
}

function editSchedule(id) {
    fetch('/api/schedules')
        .then((r) => r.json())
        .then((jobs) => {
            const job = jobs.find((j) => j.id === id);
            if (job) openEditForm(job);
        })
        .catch(() => showStatus('Failed to load job', 'error'));
}

async function handleScheduleSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('scheduleJobId').value.trim();
    const payload = {
        name: document.getElementById('scheduleName').value.trim(),
        request: document.getElementById('scheduleRequest').value.trim(),
        type: document.getElementById('scheduleType').value,
        intervalMinutes: parseInt(document.getElementById('scheduleIntervalMinutes').value, 10) || 5,
        runAt: document.getElementById('scheduleRunAt').value ? new Date(document.getElementById('scheduleRunAt').value).toISOString() : null,
        notify: document.getElementById('scheduleNotify').value,
        notifyEmail: document.getElementById('scheduleNotifyEmail').value.trim(),
        enabled: document.getElementById('scheduleEnabled').checked,
    };
    if (!payload.request) {
        showStatus('Request text is required', 'error');
        return;
    }
    try {
        if (id) {
            const res = await fetch(`/api/schedules/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) throw new Error((await res.json()).error || res.statusText);
            showStatus('Schedule updated', 'success');
        } else {
            const res = await fetch('/api/schedules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) throw new Error((await res.json()).error || res.statusText);
            showStatus('Schedule added', 'success');
        }
        clearScheduleForm();
        loadSchedules();
    } catch (err) {
        showStatus('Error: ' + err.message, 'error');
    }
}

async function deleteSchedule(id) {
    if (!confirm('Delete this scheduled check?')) return;
    try {
        const res = await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        showStatus('Schedule deleted', 'success');
        loadSchedules();
    } catch (err) {
        showStatus('Error: ' + err.message, 'error');
    }
}

async function runScheduleNow(id) {
    const btn = document.querySelector(`.schedule-item[data-job-id="${id}"] .schedule-run-btn`);
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Running…';
    }
    try {
        const res = await fetch(`/api/schedules/${id}/run`, { method: 'POST' });
        const result = await res.json();
        if (result.success) {
            showStatus('Job ran successfully', 'success');
            loadSchedules();
        } else {
            showStatus(result.error || 'Run failed', 'error');
        }
    } catch (err) {
        showStatus('Error: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Run';
        }
    }
}

