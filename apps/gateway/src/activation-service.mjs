const USER_AGENT = 'ViPocket-Xiaozhi/2.0 (Web Companion)';

function normalizeToken(value = '') {
  return value.replace(/^Bearer\s+/i, '').trim();
}

function parseWebsocketConfig(payload, fallback) {
  const websocket = payload?.websocket && typeof payload.websocket === 'object'
    ? payload.websocket
    : {};

  return {
    url: websocket.url || fallback.url || '',
    token: normalizeToken(websocket.token || websocket.access_token || fallback.token || ''),
    version: Number(websocket.version || websocket.protocol_version || 1)
  };
}

function safeActivation(payload) {
  const activation = payload?.activation && typeof payload.activation === 'object'
    ? payload.activation
    : {};

  return {
    code: typeof activation.code === 'string' ? activation.code : '',
    message: typeof activation.message === 'string' ? activation.message : '',
    challenge: typeof activation.challenge === 'string' ? activation.challenge : '',
    timeoutMs: Number.isFinite(activation.timeout_ms) ? activation.timeout_ms : 0
  };
}

export class ActivationService {
  constructor({ otaUrl, fixedWsUrl, fixedAccessToken, fetchImpl = fetch }) {
    this.otaUrl = otaUrl;
    this.fixedWsUrl = fixedWsUrl;
    this.fixedAccessToken = fixedAccessToken;
    this.fetchImpl = fetchImpl;
  }

  async check({ deviceId, clientId, language = 'vi-VN', systemInfo = {} }) {
    if (!this.otaUrl) {
      if (this.fixedWsUrl && this.fixedAccessToken) {
        return {
          status: 'activated',
          activation: { code: '', message: 'Static gateway configuration is ready.', challenge: '', timeoutMs: 0 },
          websocket: { url: this.fixedWsUrl, token: this.fixedAccessToken, version: 1 },
          upstreamStatus: 200
        };
      }
      throw new Error('XIAOZHI_OTA_URL is not configured on the gateway.');
    }

    const response = await this.fetchImpl(this.otaUrl, {
      method: 'POST',
      headers: {
        'Activation-Version': '1',
        'Device-Id': deviceId,
        'Client-Id': clientId,
        'User-Agent': USER_AGENT,
        'Accept-Language': language,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(systemInfo)
    });

    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Activation endpoint returned non-JSON content (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const message = payload?.message || payload?.error || `Activation request failed (HTTP ${response.status}).`;
      throw new Error(message);
    }

    const activation = safeActivation(payload);
    const websocket = parseWebsocketConfig(payload, {
      url: this.fixedWsUrl,
      token: this.fixedAccessToken
    });
    const activated = Boolean(websocket.url && websocket.token);

    return {
      status: activated ? 'activated' : 'pending',
      activation,
      websocket,
      upstreamStatus: response.status
    };
  }
}
