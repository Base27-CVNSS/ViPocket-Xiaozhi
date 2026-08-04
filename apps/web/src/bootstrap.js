const VERSION = '2.3.0';
const DEVICE_KEY = 'vipocket.deviceId';
const SESSION_KEY = 'vipocket.activationSession';
const GATEWAY_KEY = 'vipocket.gatewayUrl';

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function isMacAddress(value) {
  return typeof value === 'string' && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value);
}

function createLocalMacAddress() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  // Locally administered, unicast MAC address. This matches the Device-Id
  // shape used by xiaozhi-esp32 without impersonating a physical vendor OUI.
  bytes[0] = (bytes[0] | 0x02) & 0xfe;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(':');
}

function migrateLegacyDeviceId(value) {
  if (isMacAddress(value)) return value.toLowerCase();
  if (typeof value === 'string') {
    const match = value.match(/(?:^|web-)((?:[0-9a-f]{2}:){5}[0-9a-f]{2})$/i);
    if (match) {
      const bytes = match[1].split(':').map((part) => Number.parseInt(part, 16));
      bytes[0] = (bytes[0] | 0x02) & 0xfe;
      return bytes.map((part) => part.toString(16).padStart(2, '0')).join(':');
    }
  }
  return createLocalMacAddress();
}

function createSystemInfo(payload) {
  const width = Number(window.screen?.width || window.innerWidth || 0);
  const height = Number(window.screen?.height || window.innerHeight || 0);
  return {
    version: 2,
    language: payload.language || 'vi-VN',
    flash_size: 0,
    minimum_free_heap_size: '0',
    mac_address: payload.deviceId,
    uuid: payload.clientId,
    chip_model_name: 'web-browser',
    chip_info: {
      model: 0,
      cores: Number(navigator.hardwareConcurrency || 1),
      revision: 0,
      features: 0
    },
    application: {
      name: 'vipocket-xiaozhi-web',
      version: VERSION,
      compile_time: 'web-runtime',
      idf_version: 'Web Platform',
      elf_sha256: ''
    },
    partition_table: [],
    ota: { label: 'web' },
    display: {
      monochrome: false,
      width,
      height
    },
    board: {
      type: 'web-browser',
      name: 'ViPocket-Xiaozhi',
      version: VERSION,
      platform: navigator.platform || 'web',
      user_agent: navigator.userAgent
    },
    capabilities: payload.systemInfo?.capabilities || {}
  };
}

const previousDeviceId = readJson(DEVICE_KEY);
const deviceId = migrateLegacyDeviceId(previousDeviceId);
writeJson(DEVICE_KEY, deviceId);

if (previousDeviceId !== deviceId) {
  localStorage.removeItem(SESSION_KEY);
}

if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
  writeJson(GATEWAY_KEY, window.location.origin);
}

// Keep the legacy main module small while upgrading its activation payload to
// the structure emitted by xiaozhi-esp32 Board::GetSystemInfoJson().
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  try {
    const requestUrl = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.href);
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'POST' && requestUrl.pathname === '/api/v1/activation' && typeof init.body === 'string') {
      const payload = JSON.parse(init.body);
      payload.deviceId = deviceId;
      payload.systemInfo = createSystemInfo(payload);
      return nativeFetch(input, { ...init, body: JSON.stringify(payload) });
    }
  } catch {
    // Preserve the original request when it is not a ViPocket activation call.
  }
  return nativeFetch(input, init);
};
