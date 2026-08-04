import './styles.css';
import './otp.css';
import { applyLanguage, messages } from './core/i18n.js';
import { UiStateMachine } from './core/state-machine.js';
import { createAbort, createHello, createListen, parseServerMessage } from './core/protocol.js';
import { VoiceEngine } from './audio/voice-engine.js';
import {
  formatOtp,
  isOtpExpired,
  isValidOtp,
  normalizeOtp,
  remainingOtpSeconds,
  withOtpExpiry
} from './core/otp.js';

const $ = (selector) => document.querySelector(selector);
const storage = {
  get(key, fallback = null) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
  remove(key) { localStorage.removeItem(key); }
};

const state = {
  language: storage.get('vipocket.language', 'vi'),
  gatewayUrl: storage.get('vipocket.gatewayUrl', 'http://127.0.0.1:8787'),
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
  otpTimer: null,
  pttActive: false,
  gatewayReady: false
};

storage.set('vipocket.deviceId', state.deviceId);
storage.set('vipocket.clientId', state.clientId);

function createDeviceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  bytes[0] = (bytes[0] | 0x02) & 0xfe;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(':');
}

function t(key) {
  return messages[state.language]?.[key] || messages.vi[key] || key;
}

function log(message, detail = '') {
  const stamp = new Date().toLocaleTimeString();
  const line = `[${stamp}] ${message}${detail ? ` · ${detail}` : ''}`;
  const logView = $('#eventLog');
  logView.textContent += `${line}\n`;
  logView.scrollTop = logView.scrollHeight;
}

function showNotice(element, message = '', type = 'info') {
  element.textContent = message;
  element.className = `notice ${type}${message ? '' : ' hidden'}`;
}

function setButtonBusy(button, busy, busyText) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
    delete button.dataset.label;
  }
}

function normalizeGatewayUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Gateway URL must use http:// or https://.');
  return url.origin;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(`${state.gatewayUrl}${path}`, {
    ...options,
    headers
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Gateway request failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const ui = new UiStateMachine('setup', (next) => {
  for (const name of ['setup', 'activate', 'talk']) {
    $(`#${name}Stage`).classList.toggle('hidden', name !== next);
  }
  const order = ['setup', 'activate', 'talk'];
  const activeIndex = order.indexOf(next);
  document.querySelectorAll('.step').forEach((element, index) => {
    element.classList.toggle('active', index === activeIndex);
    element.classList.toggle('done', index < activeIndex);
  });
  document.querySelectorAll('.steps > i').forEach((element, index) => element.classList.toggle('done', index < activeIndex));
  $('#stageTitle').dataset.i18n = `stage.${next}.title`;
  $('#stageTitle').textContent = t(`stage.${next}.title`);
});

const voice = new VoiceEngine({
  bitrate: state.bitrate,
  onPacket(packet) {
    if (state.socket?.readyState === WebSocket.OPEN && state.pttActive) state.socket.send(packet);
  },
  onLevel(level) {
    $('#meterFill').style.width = `${Math.max(3, Math.round(level * 100))}%`;
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
  if (state.activationSession?.id) renderActivation(state.activationSession, { restartTimer: false });
}

function updateNetwork() {
  const online = navigator.onLine;
  const status = $('#networkStatus');
  status.classList.toggle('offline', !online);
  status.querySelector('span').textContent = t(online ? 'network.online' : 'network.offline');
}

async function updateDiagnostics() {
  const caps = await VoiceEngine.capabilities();
  $('#secureContextValue').textContent = caps.secure ? 'OK' : 'NO';
  $('#webCodecsValue').textContent = caps.opus ? 'OPUS READY' : 'UNSUPPORTED';
  $('#audioWorkletValue').textContent = caps.worklet ? 'READY' : 'UNSUPPORTED';
  $('#gatewayValue').textContent = state.gatewayReady ? 'ONLINE' : 'OFFLINE';
}

function stopOtpTimers() {
  clearInterval(state.pollTimer);
  clearInterval(state.otpTimer);
  state.pollTimer = null;
  state.otpTimer = null;
}

function formatClock(seconds) {
  if (seconds == null) return '--:--';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function renderOtpCountdown() {
  const session = state.activationSession;
  const timer = $('#otpTimer');
  const progress = $('#otpProgress');
  const card = $('#activationCard');
  const pollButton = $('#pollButton');
  if (!session || session.status === 'activated') {
    timer.textContent = session?.status === 'activated' ? '✓' : '--:--';
    progress.style.width = session?.status === 'activated' ? '100%' : '0%';
    progress.classList.remove('warning');
    card.classList.toggle('otp-verified', session?.status === 'activated');
    return;
  }

  const seconds = remainingOtpSeconds(session);
  const total = Math.max(1, Math.ceil(Number(session.timeoutMs || 0) / 1000));
  const ratio = seconds == null ? 1 : Math.max(0, Math.min(1, seconds / total));
  timer.textContent = formatClock(seconds);
  progress.style.width = `${Math.round(ratio * 100)}%`;
  progress.classList.toggle('warning', ratio <= 0.25);

  const expired = isOtpExpired(session);
  card.classList.toggle('otp-expired', expired);
  pollButton.disabled = expired || !isValidOtp(session.code);
  $('#newOtpButton').classList.toggle('hidden', !expired);
  if (expired) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    $('#activationState').textContent = state.language === 'vi' ? 'Hết hạn' : 'Expired';
    showNotice($('#activationNotice'), t('activate.expired'), 'error');
  }
}

function startOtpCountdown() {
  clearInterval(state.otpTimer);
  renderOtpCountdown();
  if (!state.activationSession || state.activationSession.status === 'activated') return;
  state.otpTimer = setInterval(renderOtpCountdown, 1000);
}

function renderActivation(session, { restartTimer = true } = {}) {
  const normalized = withOtpExpiry(session);
  state.activationSession = normalized;
  storage.set('vipocket.activationSession', normalized);
  $('#deviceIdLabel').textContent = state.deviceId;

  const activated = normalized.status === 'activated';
  const code = normalizeOtp(normalized.code);
  const validCode = activated || isValidOtp(code);
  const expired = !activated && isOtpExpired(normalized);

  $('#activationState').textContent = activated
    ? (state.language === 'vi' ? 'Đã liên kết' : 'Linked')
    : expired
      ? (state.language === 'vi' ? 'Hết hạn' : 'Expired')
      : (state.language === 'vi' ? 'Chờ OTP' : 'Waiting for OTP');
  $('#activationState').classList.toggle('success', activated);
  $('#activationCode').textContent = activated && !code ? '✓ LIÊN KẾT' : formatOtp(code);
  $('#activationMessage').textContent = activated
    ? t('activate.verified')
    : normalized.message || t('activate.waiting');
  $('#activationCard').classList.remove('hidden');
  $('#activationCard').classList.toggle('otp-verified', activated);
  $('#activationCard').classList.toggle('otp-expired', expired);
  $('#pollButton').disabled = !validCode || expired || activated;
  $('#newOtpButton').classList.toggle('hidden', !expired && !activated);

  if (!validCode) {
    showNotice(
      $('#activationNotice'),
      state.language === 'vi'
        ? 'OTA không trả về OTP đúng định dạng 6 chữ số. ViPocket đã từ chối hiển thị mã không hợp lệ.'
        : 'OTA did not return a valid six-digit OTP. ViPocket rejected the malformed code.',
      'error'
    );
  }

  if (restartTimer) startOtpCountdown();
  else renderOtpCountdown();
}

async function testGateway() {
  const button = $('#testGatewayButton');
  setButtonBusy(button, true, state.language === 'vi' ? 'Đang kiểm tra…' : 'Testing…');
  showNotice($('#setupNotice'));
  try {
    state.gatewayUrl = normalizeGatewayUrl($('#gatewayUrl').value.trim());
    state.deviceLanguage = $('#deviceLanguage').value;
    storage.set('vipocket.gatewayUrl', state.gatewayUrl);
    storage.set('vipocket.deviceLanguage', state.deviceLanguage);
    const health = await api('/health', { method: 'GET', headers: {} });
    state.gatewayReady = true;
    $('#gatewayValue').textContent = 'ONLINE';
    log('Gateway connected', `${health.service} ${health.version}`);
    if (!health.activationConfigured) {
      showNotice(
        $('#setupNotice'),
        state.language === 'vi'
          ? 'Gateway đang chạy ở chế độ ngoại tuyến và chưa có upstream Xiaozhi.'
          : 'The gateway is running offline without a Xiaozhi upstream.',
        'warn'
      );
    }
    ui.move('activate');
  } catch (error) {
    state.gatewayReady = false;
    $('#gatewayValue').textContent = 'OFFLINE';
    showNotice($('#setupNotice'), error.message, 'error');
    log('Gateway check failed', error.message);
  } finally {
    setButtonBusy(button, false);
    updateDiagnostics();
  }
}

async function deletePreviousActivation() {
  const sessionId = state.activationSession?.id;
  stopOtpTimers();
  state.activationSession = null;
  storage.remove('vipocket.activationSession');
  if (!sessionId) return;
  try {
    await api(`/api/v1/activation/${sessionId}`, { method: 'DELETE', headers: {} });
  } catch {
    // The previous session may already be expired or belong to an old gateway.
  }
}

async function requestActivation() {
  const button = $('#requestCodeButton');
  setButtonBusy(button, true, state.language === 'vi' ? 'Đang yêu cầu OTP…' : 'Requesting OTP…');
  showNotice($('#activationNotice'));
  try {
    await deletePreviousActivation();
    const session = await api('/api/v1/activation', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: state.deviceId,
        clientId: state.clientId,
        language: state.deviceLanguage,
        systemInfo: {
          client: 'ViPocket-Xiaozhi',
          version: '2.3.0',
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          capabilities: await VoiceEngine.capabilities()
        }
      })
    });
    renderActivation(session);
    log('Activation session created', session.id);
    if (session.status === 'activated') {
      completeActivation(session);
    } else if (isValidOtp(session.code)) {
      showNotice($('#activationNotice'), t('activate.instructions'), 'info');
    }
  } catch (error) {
    showNotice($('#activationNotice'), error.message, 'error');
    log('Activation request failed', error.message);
  } finally {
    setButtonBusy(button, false);
  }
}

function startPolling(interval = 2500) {
  clearInterval(state.pollTimer);
  if (!state.activationSession || isOtpExpired(state.activationSession)) return;
  state.pollTimer = setInterval(() => pollActivation({ silent: true }), Math.max(1000, interval));
}

async function pollActivation({ silent = false } = {}) {
  if (!state.activationSession?.id) return;
  if (isOtpExpired(state.activationSession)) {
    renderOtpCountdown();
    return;
  }

  const button = $('#pollButton');
  if (!silent) setButtonBusy(button, true, state.language === 'vi' ? 'Đang xác minh OTP…' : 'Verifying OTP…');
  try {
    const session = await api(`/api/v1/activation/${state.activationSession.id}`, { method: 'GET', headers: {} });
    renderActivation(session);
    if (session.status === 'activated') {
      completeActivation(session);
    } else if (!silent) {
      showNotice(
        $('#activationNotice'),
        state.language === 'vi'
          ? 'Chưa thấy liên kết. ViPocket sẽ kiểm tra tự động cho đến khi OTP hết hạn.'
          : 'Pairing is not visible yet. ViPocket will keep checking until the OTP expires.',
        'warn'
      );
      startPolling(session.pollAfterMs);
    }
  } catch (error) {
    if (error.status === 404) {
      stopOtpTimers();
      state.activationSession = null;
      storage.remove('vipocket.activationSession');
      $('#activationCard').classList.add('otp-expired');
      $('#newOtpButton').classList.remove('hidden');
    }
    if (!silent) showNotice($('#activationNotice'), error.message, 'error');
    log('Activation polling failed', error.message);
  } finally {
    if (!silent) setButtonBusy(button, false);
  }
}

function completeActivation(session) {
  stopOtpTimers();
  renderActivation({ ...session, status: 'activated' }, { restartTimer: false });
  showNotice($('#activationNotice'), t('activate.verified'), 'success');
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
    if (!caps.secure || !caps.opus || !caps.worklet) throw new Error('Secure context, AudioWorklet and WebCodecs Opus are required. Use localhost on current Edge/Chrome.');
    const { ticket } = await api(`/api/v1/activation/${state.activationSession.id}/ticket`, { method: 'POST', body: '{}' });
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
        reject(new Error('Unable to open gateway WebSocket.'));
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
    switch (message.type) {
      case 'hello': {
        if (message.transport !== 'websocket') throw new Error('Unexpected Xiaozhi transport.');
        state.protocolSessionId = message.session_id || '';
        const outputRate = message.audio_params?.sample_rate || 24000;
        voice.configureDecoder(outputRate);
        $('#latencyLabel').textContent = `${Math.round(performance.now() - state.connectedAt)} ms`;
        $('#connectionBadge').textContent = state.language === 'vi' ? 'Đã kết nối' : 'Connected';
        $('#voiceTitle').textContent = t('talk.ready');
        $('#pttButton').disabled = false;
        $('#interruptButton').disabled = !state.bargeIn;
        showNotice($('#voiceNotice'), state.language === 'vi' ? 'Bắt tay giao thức thành công.' : 'Protocol handshake completed.', 'success');
        break;
      }
      case 'stt':
        $('#userTranscript').textContent = message.text || '…';
        break;
      case 'llm':
        $('#voiceOrb').dataset.emotion = message.emotion || 'neutral';
        break;
      case 'tts':
        if (message.state === 'start') {
          $('#voiceOrb').classList.add('speaking');
          $('#voiceTitle').textContent = state.language === 'vi' ? 'Xiaozhi đang nói…' : 'Xiaozhi is speaking…';
        } else if (message.state === 'stop') {
          $('#voiceOrb').classList.remove('speaking');
          $('#voiceTitle').textContent = t('talk.ready');
        } else if (message.state === 'sentence_start' && message.text) {
          $('#assistantTranscript').textContent = message.text;
        }
        break;
      case 'alert':
        showNotice($('#voiceNotice'), `${message.status || 'Alert'}: ${message.message || ''}`, 'warn');
        break;
      case 'mcp':
        log('MCP message', message.payload?.method || 'response');
        break;
      default:
        log('Unhandled message', message.type);
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
    log('Microphone started', state.listenMode);
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
  log('Microphone stopped');
}

function interrupt() {
  voice.interruptPlayback();
  if (state.socket?.readyState === WebSocket.OPEN && state.protocolSessionId) {
    sendJson(createAbort(state.protocolSessionId, 'user_interruption'));
    log('Barge-in sent');
  }
}

function restoreUi() {
  $('#gatewayUrl').value = state.gatewayUrl;
  $('#deviceLanguage').value = state.deviceLanguage;
  $('#deviceIdLabel').textContent = state.deviceId;
  $('#listenMode').value = state.listenMode;
  $('#opusBitrate').value = String(state.bitrate);
  $('#bargeInToggle').checked = state.bargeIn;
  if (state.activationSession?.id) {
    renderActivation(state.activationSession);
    if (state.activationSession.status === 'activated') ui.move('talk', { force: true });
  }
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
$('#testGatewayButton').addEventListener('click', testGateway);
$('#requestCodeButton').addEventListener('click', requestActivation);
$('#newOtpButton').addEventListener('click', requestActivation);
$('#pollButton').addEventListener('click', () => pollActivation());
$('#copyCodeButton').addEventListener('click', async () => {
  const code = normalizeOtp(state.activationSession?.code);
  if (!isValidOtp(code)) return;
  await navigator.clipboard.writeText(code);
  const button = $('#copyCodeButton');
  button.classList.add('copied');
  window.setTimeout(() => button.classList.remove('copied'), 900);
  log('Activation OTP copied');
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
  stopOtpTimers();
  disconnectVoice();
  voice.close();
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
$('#bootShell')?.setAttribute('hidden', '');
log('ViPocket initialized', `${state.deviceId} / ${state.clientId}`);
