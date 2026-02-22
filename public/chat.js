// Chat functionality for web interface

let chatHistory = [];

// Initialize chat on page load
document.addEventListener('DOMContentLoaded', () => {
    setupChat();
    setupTabs();
    loadChatHistory();
    // Load dashboard data on init (Dashboard is the default tab)
    if (typeof loadDashboard === 'function') {
        loadDashboard();
    }
});

// Setup tab navigation
function setupTabs() {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.getAttribute('data-tab');

            // Update buttons
            tabButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            // Update content
            tabContents.forEach(content => content.classList.remove('active'));
            document.getElementById(`${targetTab}Tab`).classList.add('active');

            if (targetTab === 'dashboard' && typeof loadDashboard === 'function') {
                loadDashboard();
            }
            if (targetTab === 'schedules' && typeof loadSchedules === 'function') {
                loadSchedules();
            }
        });
    });
}

// Setup chat interface
function setupChat() {
    const chatForm = document.getElementById('chatForm');
    const chatInput = document.getElementById('chatInput');
    const chatSendBtn = document.getElementById('chatSendBtn');
    const clearChatBtn = document.getElementById('clearChatBtn');

    if (clearChatBtn) {
        clearChatBtn.addEventListener('click', () => {
            clearChatHistory();
        });
    }

    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = chatInput.value.trim();
        
        if (!message) return;

        // Add user message to chat
        addMessage('user', message);
        chatInput.value = '';
        chatSendBtn.disabled = true;

        // Show loading indicator
        const loadingId = addLoadingMessage();

        try {
            // Send recent conversation history so the AI can remember context (cleared when chat is cleared)
            const recentHistory = chatHistory.slice(-20);
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message, history: recentHistory }),
            });

            // Remove loading indicator
            removeLoadingMessage(loadingId);

            if (!response.ok) {
                if (response.status === 401) {
                    window.location.reload(); // Reload to show login
                    return;
                }
                const error = await response.json().catch(() => ({}));
                throw new Error(error.error || 'Failed to get response');
            }

            const contentType = response.headers.get('Content-Type') || '';
            const isStream = contentType.includes('text/event-stream');

            if (isStream) {
                // Debug thought stream: show tokens as they arrive
                const messageDiv = addMessageStreamingPlaceholder();
                const contentDiv = messageDiv.querySelector('.chat-message-content');
                let fullText = '';
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const events = buffer.split('\n\n');
                    buffer = events.pop() || '';
                    for (const event of events) {
                        const line = event.split('\n').find((l) => l.startsWith('data: '));
                        if (!line) continue;
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.error) {
                                fullText = (fullText || '') + '\n⚠️ Error: ' + data.error;
                                appendStreamingContent(contentDiv, fullText, true);
                                break;
                            }
                            if (data.chunk) {
                                fullText += data.chunk;
                                appendStreamingContent(contentDiv, fullText);
                            }
                            if (data.done && data.response != null) {
                                fullText = data.response;
                            }
                        } catch (_) {}
                    }
                }
                const { cleanText, scheduleCreated, scheduleName } = await parseAndCreateScheduleFromResponse(fullText);
                appendStreamingContent(contentDiv, cleanText, true);
                addStreamingMessageTime(messageDiv);
                if (scheduleCreated && typeof showStatus === 'function') {
                    showStatus(`Schedule added: ${scheduleName}. View in Schedules tab.`, 'success');
                }
                chatHistory.push({ role: 'user', message: message, timestamp: new Date().toISOString() });
                chatHistory.push({ role: 'bot', message: cleanText, timestamp: new Date().toISOString() });
                saveChatHistory();
            } else {
                const data = await response.json();
                if (data.success) {
                    const { cleanText, scheduleCreated, scheduleName } = await parseAndCreateScheduleFromResponse(data.response);
                    addMessage('bot', cleanText);
                    if (scheduleCreated && typeof showStatus === 'function') {
                        showStatus(`Schedule added: ${scheduleName}. View in Schedules tab.`, 'success');
                    }
                    chatHistory.push({
                        role: 'user',
                        message: message,
                        timestamp: new Date().toISOString()
                    });
                    chatHistory.push({
                        role: 'bot',
                        message: cleanText,
                        timestamp: data.timestamp
                    });
                    saveChatHistory();
                } else {
                    throw new Error(data.error || 'Unknown error');
                }
            }
        } catch (error) {
            removeLoadingMessage(loadingId);
            addMessage('bot', `⚠️ Error: ${error.message}`, true);
            console.error('Chat error:', error);
        } finally {
            chatSendBtn.disabled = false;
            chatInput.focus();
        }
    });

    // Allow Enter to send (Shift+Enter for new line)
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            chatForm.dispatchEvent(new Event('submit'));
        }
    });
}

// Parse [NETWORKBOT_SCHEDULE]...[/NETWORKBOT_SCHEDULE] from AI response; create schedule via API; return { cleanText, scheduleCreated, scheduleName }.
async function parseAndCreateScheduleFromResponse(responseText) {
    if (!responseText || typeof responseText !== 'string') return { cleanText: responseText || '', scheduleCreated: false };
    const tagOpen = '[NETWORKBOT_SCHEDULE]';
    const tagClose = '[/NETWORKBOT_SCHEDULE]';
    const idxOpen = responseText.indexOf(tagOpen);
    const idxClose = responseText.indexOf(tagClose, idxOpen);
    if (idxOpen === -1 || idxClose === -1) return { cleanText: responseText, scheduleCreated: false };
    const jsonStr = responseText.slice(idxOpen + tagOpen.length, idxClose).trim();
    let payload;
    try {
        payload = JSON.parse(jsonStr);
    } catch (e) {
        return { cleanText: responseText, scheduleCreated: false };
    }
    const name = payload.name || payload.request?.slice(0, 40) || 'Scheduled check';
    const body = {
        name: payload.name || name,
        request: payload.request || '',
        type: payload.type || 'recurring',
        intervalMinutes: payload.type === 'once' ? undefined : (payload.intervalMinutes || 5),
        runAt: payload.type === 'once' ? payload.runAt : undefined,
        notify: payload.notify || 'never',
        notifyEmail: payload.notifyEmail || '',
        enabled: payload.enabled !== false,
    };
    if (!body.request.trim()) return { cleanText: responseText, scheduleCreated: false };
    try {
        const res = await fetch('/api/schedules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        const before = responseText.slice(0, idxOpen).trim();
        const after = responseText.slice(idxClose + tagClose.length).trim();
        const cleanText = [before, after].filter(Boolean).join('\n\n').trim() || 'Schedule added.';
        return { cleanText, scheduleCreated: true, scheduleName: name };
    } catch (e) {
        console.error('Schedule create from chat failed:', e);
        return { cleanText: responseText, scheduleCreated: false };
    }
}

// Sanitize HTML from markdown to prevent XSS (strip script/iframe and event handlers)
function sanitizeHtml(html) {
    if (!html || typeof html !== 'string') return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('script, iframe, object, embed, form').forEach((el) => el.remove());
    div.querySelectorAll('*').forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
            if (/^on\w+/i.test(attr.name) || attr.name === 'href' && attr.value && attr.value.trim().toLowerCase().startsWith('javascript:')) {
                el.removeAttribute(attr.name);
            }
        });
    });
    return div.innerHTML;
}

// Add a message to the chat (bot messages rendered as Markdown)
function addMessage(role, content, isError = false) {
    const messagesContainer = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'chat-message-avatar';
    avatar.textContent = role === 'user' ? '👤' : '🤖';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'chat-message-content';
    if (isError) {
        contentDiv.style.color = 'var(--error-color)';
        contentDiv.textContent = content;
    } else if (role === 'bot' && typeof marked !== 'undefined') {
        try {
            const rawHtml = marked.parse(content || '', { gfm: true, breaks: true });
            contentDiv.innerHTML = sanitizeHtml(rawHtml);
        } catch (e) {
            contentDiv.textContent = content;
        }
    } else {
        contentDiv.textContent = content;
    }

    const timeDiv = document.createElement('div');
    timeDiv.className = 'chat-message-time';
    timeDiv.textContent = new Date().toLocaleTimeString();

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    contentDiv.appendChild(timeDiv);

    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    return messageDiv;
}

// Add a bot message placeholder for streaming (thought stream); returns the message div
function addMessageStreamingPlaceholder() {
    const messagesContainer = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'chat-message bot chat-message-streaming';
    const avatar = document.createElement('div');
    avatar.className = 'chat-message-avatar';
    avatar.textContent = '🤖';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'chat-message-content';
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return messageDiv;
}

// Update streaming content (plain text while streaming; optional markdown when final)
function appendStreamingContent(contentDiv, text, isFinal) {
    if (!contentDiv) return;
    if (isFinal && typeof marked !== 'undefined') {
        try {
            const rawHtml = marked.parse(text || '', { gfm: true, breaks: true });
            contentDiv.innerHTML = sanitizeHtml(rawHtml);
        } catch (e) {
            contentDiv.textContent = text;
        }
    } else {
        contentDiv.textContent = text;
    }
    const container = contentDiv.closest('#chatMessages');
    if (container) container.scrollTop = container.scrollHeight;
}

// Add timestamp to a streaming message when done
function addStreamingMessageTime(messageDiv) {
    const contentDiv = messageDiv?.querySelector('.chat-message-content');
    if (!contentDiv) return;
    const timeDiv = document.createElement('div');
    timeDiv.className = 'chat-message-time';
    timeDiv.textContent = new Date().toLocaleTimeString();
    contentDiv.appendChild(timeDiv);
    messageDiv.classList.remove('chat-message-streaming');
}

// Add loading message
function addLoadingMessage() {
    const messagesContainer = document.getElementById('chatMessages');
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'chat-message bot';
    loadingDiv.id = 'loading-message';
    
    const avatar = document.createElement('div');
    avatar.className = 'chat-message-avatar';
    avatar.textContent = '🤖';
    
    const loadingContent = document.createElement('div');
    loadingContent.className = 'chat-loading';
    loadingContent.innerHTML = '<span></span><span></span><span></span>';
    
    loadingDiv.appendChild(avatar);
    loadingDiv.appendChild(loadingContent);
    messagesContainer.appendChild(loadingDiv);
    
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    
    return 'loading-message';
}

// Remove loading message
function removeLoadingMessage(id) {
    const loadingDiv = document.getElementById(id);
    if (loadingDiv) {
        loadingDiv.remove();
    }
}

// Save chat history to localStorage
function saveChatHistory() {
    try {
        // Keep only last 50 messages
        const recentHistory = chatHistory.slice(-50);
        localStorage.setItem('networkbot_chat_history', JSON.stringify(recentHistory));
    } catch (error) {
        console.error('Error saving chat history:', error);
    }
}

// Load chat history from localStorage
function loadChatHistory() {
    try {
        const saved = localStorage.getItem('networkbot_chat_history');
        if (saved) {
            chatHistory = JSON.parse(saved);
            // Display history
            chatHistory.forEach(item => {
                addMessage(item.role, item.message);
            });
        }
    } catch (error) {
        console.error('Error loading chat history:', error);
    }
}

// Clear chat history
function clearChatHistory() {
    chatHistory = [];
    localStorage.removeItem('networkbot_chat_history');
    const messagesContainer = document.getElementById('chatMessages');
    messagesContainer.innerHTML = '';
}
