import { applyLanguage, messages } from './core/i18n.js';
import { UiStateMachine } from './core/state-machine.js';
import { createAbort, createHello, createListen, parseServerMessage } from './core/protocol.js';
import { VoiceEngine } from './audio/voice-engine.js';

const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = new URL('./styles.css', import.meta.url).href;
document.head.append(stylesheet);

const $ = (selector) => document.querySelector(selector);
const localOrigin = window.location.origin;
const storage = {
  get(key, fallback = null) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
};

function createDeviceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `web-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(':')}`;
}

const savedGateway = storage.get('vipocket.gatewayUrl', localOrigin);
const state = {
  language: storage.get('vipocket.language', 'vi'),
  gatewayUrl: savedGateway.includes(':8787') ? localOrigin : savedGateway,
  deviceLanguage: storage.get('vipocket.deviceLanguage', 'vi-VN'),
  deviceId: storage.get('vipocket.deviceId') || createDeviceId(),
  clientId: storage.get('vipocket.clientId') || crypto.randomUUID(),
  activationSession: storage.get('vipocket.activationSession'),
  listenMode: storage.get('vipocket.listenMode', 'manual'),
  bitrate: storage.get('vipocket.bitrate', 24000),
  bargeIn: storage.get('vipocket.bargeIn', true),
  socket: null,
  protocolSessionId: '',
  connectedAt: 0,
  pollTimer: null,
  pttActive: false,
  gatewayReady: false
};

storage.set('vipocket.deviceId', state.deviceId);
storage.set('vipocket.clientId', state.clientId);
storage.set('vipocket.gatewayUrl', state.gatewayUrl);

function t(key) {
  return messages[state.language]?.[key] || messages.vi[key] || key;
}

function log(message, detail = '') {
  const view = $('#eventLog');
  if (!view) return;
  const stamp = new Date().toLocaleTimeString();
  view.textContent += `[${stamp}] ${message}${detail ? ` · ${detail}` : ''}\n`;
  view.scrollTop = view.scrollHeight;
}

function showNotice(element, message = '', type = 'info') {
  if (!element) return;
  element.textContent = message;
  element.className = `notice ${type}${message ? '' : ' hidden'}`;
}

function setButtonBusy(button, busy, busyText = '') {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = busyText || '…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
    delete button.dataset.originalLabel;
  }
}

function normalizeGatewayUrl(value) {
  const url = new URL(value || localOrigin, window.location.href);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Gateway URL must use HTTP or HTTPS.');
  return url.origin;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${state.gatewayUrl}${path}`, { ...options, headers, signal: controller.signal });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Local server did not respond in time.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const ui = new UiStateMachine('setup', (next) => {
  for (const name of ['setup', 'activate', 'talk']) {
    $(`#${name}Stage`)?.classList.toggle('hidden', name !== next);
  }
  const order = ['setup', 'activate', 'talk'];
  const active = order.indexOf(next);
  document.querySelectorAll('.step').forEach((element, index) => {
    element.classList.toggle('active', index === active);
    element.classList.toggle('done', index < active);
  });
  document.querySelectorAll('.steps > i').forEach((element, index) => element.classList.toggle('done', index < active));
  const title = $('#stageTitle');
  if (title) {
    title.dataset.i18n = `stage.${next}.title`;
    title.textContent = t(`stage.${next}.title`);
  }
});

const voice = new VoiceEngine({
  bitrate: state.bitrate,
  onPacket(packet) {
    if (state.socket?.readyState === WebSocket.OPEN && state.pttActive) state.socket.send(packet);
  },
  onLevel(level) {
    const meter = $('#meterFill');
    if (meter) meter.style.width = `${Math.max(3, Math.round(level * 100))}%`;
  },
  onError(error) {
    log('Audio engine error', error.message);
    showNotice($('#voiceNotice'), error.message, 'error');
  }
});

function updateLanguage() {
  applyLanguage(state.language);
  $('#languageButton').textContent = state.language === 'vi' ? 'EN' : 'VI';
  storage.set('vipocket.language', state.language);
}

function updateNetwork() {
  const online = navigator.onLine;
  const status = $('#networkStatus');
  if (!status) return;
  status.classList.toggle('offline', !online);
  const label = status.querySelector('span');
  if (label) label.textContent = t(online ? 'network.online' : 'network.offline');
}

async function updateDiagnostics() {
  const caps = await VoiceEngine.capabilities();
  $('#secureContextValue').textContent = caps.secure ? 'OK' : 'NO';
  $('#webCodecsValue').textContent = caps.opus ? 'OPUS READY' : 'UNSUPPORTED';
  $('#audioWorkletValue').textContent = caps.worklet ? 'READY' : 'UNSUPPORTED';
  $('#gatewayValue').textContent = state.gatewayReady ? 'ONLINE' : 'OFFLINE';
}

function renderActivation(session) {
  state.activationSession = session;
  storage.set('vipocket.activationSession', session);
  $('#deviceIdLabel').textContent = state.deviceId;
  const status = $('#activationState');
  status.textContent = session.status === 'activated' ? 'Activated' : 'Pending';
  status.classList.toggle('success', session.status === 'activated');
  const code = String(session.code || '').replace(/\s/g, '');
  $('#activationCode').textContent = code ? code.replace(/(.{3})/, '$1 ') : '------';
  $('#activationMessage').textContent = session.message || '';
  $('#activationCard').classList.remove('hidden');
}

async function testGateway({ automatic = false } = {}) {
  const button = $('#testGatewayButton');
  if (!automatic) setButtonBusy(button, true, state.language === 'vi' ? 'Đang kiểm tra…' : 'Testing…');
  showNotice($('#setupNotice'));
  try {
    state.gatewayUrl = normalizeGatewayUrl($('#gatewayUrl').value.trim());
    state.deviceLanguage = $('#deviceLanguage').value;
    storage.set('vipocket.gatewayUrl', state.gatewayUrl);
    storage.set('vipocket.deviceLanguage', state.deviceLanguage);
    const health = await api('/health');
    state.gatewayReady = true;
    $('#gatewayValue').textContent = 'ONLINE';
    log('Local server connected', `${health.service} ${health.version}`);
    if (!health.activationConfigured) {
      showNotice($('#setupNotice'), state.language === 'vi'
        ? 'Website đã chạy. Để kết nối Xiaozhi thật, mở CONFIGURE-XIAOZHI.cmd và điền endpoint/token hợp lệ.'
        : 'Website is running. Configure an authorized Xiaozhi endpoint/token before activation.', 'warn');
    }
    ui.move('activate');
  } catch (error) {
    state.gatewayReady = false;
    $('#gatewayValue').textContent = 'OFFLINE';
    showNotice($('#setupNotice'), error.message, 'error');
    log('Local server check failed', error.message);
  } finally {
    if (!automatic) setButtonBusy(button, false);
    updateDiagnostics();
  }
}

async function requestActivation() {
  const button = $('#requestCodeButton');
  setButtonBusy(button, true, state.language === 'vi' ? 'Đang yêu cầu…' : 'Requesting…');
  showNotice($('#activationNotice'));
  try {
    const session = await api('/api/v1/activation', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: state.deviceId,
        clientId: state.clientId,
        language: state.deviceLanguage,
        systemInfo: {
          client: 'ViPocket-Xiaozhi',
          version: '2.2.0',
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          capabilities: await VoiceEngine.capabilities()
        }
      })
    });
    renderActivation(session);
    log('Activation session created', session.id);
    if (session.status === 'activated') completeActivation(session);
    else startPolling(session.pollAfterMs);
  } catch (error) {
    showNotice($('#activationNotice'), error.message, 'error');
    log('Activation request failed', error.message);
  } finally {
    setButtonBusy(button, false);
  }
}

function startPolling(interval = 2500) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => pollActivation({ silent: true }), Math.max(1000, interval));
}

async function pollActivation({ silent = false } = {}) {
  if (!state.activationSession?.id) return;
  const button = $('#pollButton');
  if (!silent) setButtonBusy(button, true, state.language === 'vi' ? 'Đang kiểm tra…' : 'Checking…');
  try {
    const session = await api(`/api/v1/activation/${state.activationSession.id}`);
    renderActivation(session);
    if (session.status === 'activated') completeActivation(session);
    else if (!silent) showNotice($('#activationNotice'), state.language === 'vi' ? 'Thiết bị vẫn đang chờ liên kết.' : 'The device is still waiting for pairing.', 'warn');
  } catch (error) {
    if (!silent) showNotice($('#activationNotice'), error.message, 'error');
    log('Activation polling failed', error.message);
  } finally {
    if (!silent) setButtonBusy(button, false);
  }
}

function completeActivation(session) {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  renderActivation(session);
  showNotice($('#activationNotice'), state.language === 'vi' ? 'Kích hoạt thành công.' : 'Activation completed.', 'success');
  log('Device activated', session.id);
  ui.move('talk');
}

function websocketUrl(ticket) {
  const url = new URL(state.gatewayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/xiaozhi';
  url.search = new URLSearchParams({ ticket }).toString();
  return url.toString();
}

function sendJson(payload) {
  if (state.socket?.readyState !== WebSocket.OPEN) throw new Error('Voice WebSocket is not connected.');
  state.socket.send(JSON.stringify(payload));
}

async function connectVoice() {
  const button = $('#connectButton');
  setButtonBusy(button, true, state.language === 'vi' ? 'Đang kết nối…' : 'Connecting…');
  showNotice($('#voiceNotice'));
  try {
    const caps = await VoiceEngine.capabilities();
    if (!caps.secure || !caps.opus || !caps.worklet) throw new Error('Current Edge/Chrome must support Secure Context, AudioWorklet and WebCodecs Opus.');
    if (!state.activationSession?.id) throw new Error('No activated device session is available.');
    const { token: ticket } = await api(`/api/v1/activation/${state.activationSession.id}/ticket`, { method: 'POST', body: '{}' });
    const socket = new WebSocket(websocketUrl(ticket));
    socket.binaryType = 'arraybuffer';
    state.socket = socket;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Voice WebSocket handshake timed out.')), 10000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        state.connectedAt = performance.now();
        sendJson(createHello());
        log('Browser WebSocket connected');
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Unable to open local WebSocket.'));
      }, { once: true });
    });

    socket.addEventListener('message', handleSocketMessage);
    socket.addEventListener('close', handleSocketClose);
    socket.addEventListener('error', () => showNotice($('#voiceNotice'), 'WebSocket error.', 'error'));
    $('#voiceTitle').textContent = state.language === 'vi' ? 'Đang chờ Xiaozhi xác nhận…' : 'Waiting for Xiaozhi hello…';
  } catch (error) {
    showNotice($('#voiceNotice'), error.message, 'error');
    log('Voice connection failed', error.message);
    disconnectVoice();
  } finally {
    setButtonBusy(button, false);
  }
}

function handleSocketMessage(event) {
  if (typeof event.data !== 'string') {
    voice.decode(event.data);
    return;
  }
  try {
    const message = parseServerMessage(event.data);
    log('RX JSON', message.type);
    if (message.type === 'hello') {
      if (message.transport !== 'websocket') throw new Error('Unexpected Xiaozhi transport.');
      state.protocolSessionId = message.session_id || '';
      voice.configureDecoder(message.audio_params?.sample_rate || 24000);
      $('#latencyLabel').textContent = `${Math.round(performance.now() - state.connectedAt)} ms`;
      $('#connectionBadge').textContent = state.language === 'vi' ? 'Đã kết nối' : 'Connected';
      $('#voiceTitle').textContent = t('talk.ready');
      $('#pttButton').disabled = false;
      $('#interruptButton').disabled = !state.bargeIn;
      showNotice($('#voiceNotice'), state.language === 'vi' ? 'Bắt tay giao thức thành công.' : 'Protocol handshake completed.', 'success');
    } else if (message.type === 'stt') {
      $('#userTranscript').textContent = message.text || '…';
    } else if (message.type === 'llm') {
      $('#voiceOrb').dataset.emotion = message.emotion || 'neutral';
    } else if (message.type === 'tts') {
      if (message.state === 'start') {
        $('#voiceOrb').classList.add('speaking');
        $('#voiceTitle').textContent = state.language === 'vi' ? 'Xiaozhi đang nói…' : 'Xiaozhi is speaking…';
      } else if (message.state === 'stop') {
        $('#voiceOrb').classList.remove('speaking');
        $('#voiceTitle').textContent = t('talk.ready');
      } else if (message.state === 'sentence_start' && message.text) {
        $('#assistantTranscript').textContent = message.text;
      }
    } else if (message.type === 'alert') {
      showNotice($('#voiceNotice'), `${message.status || 'Alert'}: ${message.message || ''}`, 'warn');
    } else if (message.type === 'mcp') {
      log('MCP message', message.payload?.method || 'response');
    }
  } catch (error) {
    log('Invalid server message', error.message);
  }
}

function handleSocketClose(event) {
  log('Voice WebSocket closed', `${event.code} ${event.reason}`);
  state.socket = null;
  state.protocolSessionId = '';
  state.pttActive = false;
  $('#pttButton').disabled = true;
  $('#interruptButton').disabled = true;
  $('#connectionBadge').textContent = state.language === 'vi' ? 'Đã ngắt kết nối' : 'Disconnected';
  $('#voiceOrb').classList.remove('listening', 'speaking');
  voice.stopCapture();
}

function disconnectVoice() {
  if (state.socket && state.socket.readyState < WebSocket.CLOSING) state.socket.close(1000, 'User disconnected.');
  state.socket = null;
  state.protocolSessionId = '';
  voice.stopCapture();
}

async function startTalking() {
  if (state.pttActive || state.socket?.readyState !== WebSocket.OPEN || !state.protocolSessionId) return;
  try {
    if (state.bargeIn) {
      voice.interruptPlayback();
      sendJson(createAbort(state.protocolSessionId, 'user_interruption'));
    }
    state.pttActive = true;
    sendJson(createListen(state.protocolSessionId, 'start', state.listenMode));
    await voice.startCapture();
    $('#voiceOrb').classList.add('listening');
    $('#voiceTitle').textContent = state.language === 'vi' ? 'Đang lắng nghe…' : 'Listening…';
  } catch (error) {
    state.pttActive = false;
    showNotice($('#voiceNotice'), error.message, 'error');
  }
}

async function stopTalking() {
  if (!state.pttActive) return;
  state.pttActive = false;
  await voice.stopCapture();
  $('#voiceOrb').classList.remove('listening');
  $('#voiceTitle').textContent = state.language === 'vi' ? 'Đang xử lý…' : 'Processing…';
  if (state.socket?.readyState === WebSocket.OPEN && state.protocolSessionId) {
    sendJson(createListen(state.protocolSessionId, 'stop', state.listenMode));
  }
}

function interrupt() {
  voice.interruptPlayback();
  if (state.socket?.readyState === WebSocket.OPEN && state.protocolSessionId) sendJson(createAbort(state.protocolSessionId, 'user_interruption'));
}

function restoreUi() {
  $('#gatewayUrl').value = state.gatewayUrl;
  $('#deviceLanguage').value = state.deviceLanguage;
  $('#deviceIdLabel').textContent = state.deviceId;
  $('#listenMode').value = state.listenMode;
  $('#opusBitrate').value = String(state.bitrate);
  $('#bargeInToggle').checked = state.bargeIn;
  if (state.activationSession?.id) renderActivation(state.activationSession);
}

$('#languageButton').addEventListener('click', () => {
  state.language = state.language === 'vi' ? 'en' : 'vi';
  updateLanguage();
  updateNetwork();
});
$('#settingsButton').addEventListener('click', () => $('#settingsDialog').showModal());
$('#saveSettingsButton').addEventListener('click', (event) => {
  event.preventDefault();
  state.listenMode = $('#listenMode').value;
  state.bitrate = Number($('#opusBitrate').value);
  state.bargeIn = $('#bargeInToggle').checked;
  voice.bitrate = state.bitrate;
  storage.set('vipocket.listenMode', state.listenMode);
  storage.set('vipocket.bitrate', state.bitrate);
  storage.set('vipocket.bargeIn', state.bargeIn);
  $('#settingsDialog').close();
});
$('#testGatewayButton').addEventListener('click', () => testGateway());
$('#requestCodeButton').addEventListener('click', requestActivation);
$('#pollButton').addEventListener('click', () => pollActivation());
$('#copyCodeButton').addEventListener('click', async () => {
  const code = String(state.activationSession?.code || '');
  if (code) await navigator.clipboard.writeText(code);
});
$('#connectButton').addEventListener('click', () => {
  if (state.socket?.readyState === WebSocket.OPEN) disconnectVoice();
  else connectVoice();
});
$('#pttButton').addEventListener('pointerdown', (event) => { event.preventDefault(); startTalking(); });
$('#pttButton').addEventListener('pointerup', (event) => { event.preventDefault(); stopTalking(); });
$('#pttButton').addEventListener('pointerleave', () => { if (state.pttActive) stopTalking(); });
$('#pttButton').addEventListener('keydown', (event) => {
  if ((event.code === 'Space' || event.code === 'Enter') && !event.repeat) startTalking();
});
$('#pttButton').addEventListener('keyup', (event) => {
  if (event.code === 'Space' || event.code === 'Enter') stopTalking();
});
$('#interruptButton').addEventListener('click', interrupt);
$('#clearLogButton').addEventListener('click', () => { $('#eventLog').textContent = ''; });
window.addEventListener('online', updateNetwork);
window.addEventListener('offline', updateNetwork);
window.addEventListener('beforeunload', () => {
  clearInterval(state.pollTimer);
  disconnectVoice();
});

document.querySelectorAll('.step').forEach((button) => {
  button.addEventListener('click', () => {
    const target = button.dataset.step;
    if (target === 'setup') ui.move('setup', { force: true });
    if (target === 'activate' && state.gatewayReady) ui.move('activate', { force: true });
    if (target === 'talk' && state.activationSession?.status === 'activated') ui.move('talk', { force: true });
  });
});

updateLanguage();
updateNetwork();
restoreUi();
updateDiagnostics();
log('ViPocket 2.2 initialized', `${state.deviceId} / ${state.clientId}`);
window.setTimeout(() => testGateway({ automatic: true }), 250);
