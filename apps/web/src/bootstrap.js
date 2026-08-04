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

const previousDeviceId = readJson(DEVICE_KEY);
const deviceId = migrateLegacyDeviceId(previousDeviceId);
writeJson(DEVICE_KEY, deviceId);

if (previousDeviceId !== deviceId) {
  localStorage.removeItem(SESSION_KEY);
}

if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
  writeJson(GATEWAY_KEY, window.location.origin);
}
