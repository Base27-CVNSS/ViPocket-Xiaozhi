const VERSION = '2.3.0';
const USER_AGENT = `ViPocket-Xiaozhi/${VERSION} (Web Companion)`;

function normalizeToken(value = '') {
  return String(value).replace(/^Bearer\s+/i, '').trim();
}

function parseWebsocketConfig(payload, fallback) {
  const websocket = payload?.websocket && typeof payload.websocket === 'object'
    ? payload.websocket
    : {};

  return {
    url: String(websocket.url || fallback.url || '').trim(),
    token: normalizeToken(websocket.token || websocket.access_token || fallback.token || ''),
    version: Number(websocket.version || websocket.protocol_version || 1)
  };
}

function safeActivation(payload) {
  const activation = payload?.activation && typeof payload.activation === 'object'
    ? payload.activation
    : {};
  const rawCode = activation.code;

  return {
    code: typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : '',
    message: typeof activation.message === 'string' ? activation.message : '',
    challenge: typeof activation.challenge === 'string' ? activation.challenge : '',
    timeoutMs: Number.isFinite(Number(activation.timeout_ms)) ? Number(activation.timeout_ms) : 0
  };
}

function upstreamError(error, otaUrl) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new Error(`Xiaozhi OTA timed out while connecting to ${new URL(otaUrl).host}.`);
  }
  if (error instanceof TypeError) {
    return new Error(`Unable to reach Xiaozhi OTA at ${new URL(otaUrl).host}. Check Internet, DNS, proxy, or firewall.`);
  }
  return error;
}

export class ActivationService {
  constructor({ otaUrl, fixedWsUrl, fixedAccessToken, connectionMode = 'custom', otaTimeoutMs = 15000, fetchImpl = fetch }) {
    this.otaUrl = otaUrl;
    this.fixedWsUrl = fixedWsUrl;
    this.fixedAccessToken = fixedAccessToken;
    this.connectionMode = connectionMode;
    this.otaTimeoutMs = otaTimeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async check({ deviceId, clientId, language = 'vi-VN', systemInfo = {} }) {
    if (!this.otaUrl) {
      if (this.fixedWsUrl && this.fixedAccessToken) {
        return {
          status: 'activated',
          activation: {
            code: '',
            message: 'Static WebSocket configuration is ready.',
            challenge: '',
            timeoutMs: 0
          },
          websocket: { url: this.fixedWsUrl, token: this.fixedAccessToken, version: 1 },
          upstreamStatus: 200,
          source: 'fixed'
        };
      }
      throw new Error('Xiaozhi upstream is disabled. Set XIAOZHI_MODE=official or configure a custom server.');
    }

    let response;
    try {
      response = await this.fetchImpl(this.otaUrl, {
        method: 'POST',
        headers: {
          'Activation-Version': '1',
          'Device-Id': deviceId,
          'Client-Id': clientId,
          'User-Agent': USER_AGENT,
          'Accept-Language': language,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(systemInfo && typeof systemInfo === 'object' ? systemInfo : {}),
        signal: AbortSignal.timeout(this.otaTimeoutMs)
      });
    } catch (error) {
      throw upstreamError(error, this.otaUrl);
    }

    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      const preview = text.slice(0, 120).replace(/\s+/g, ' ');
      throw new Error(`Xiaozhi OTA returned non-JSON content (HTTP ${response.status})${preview ? `: ${preview}` : '.'}`);
    }

    if (!response.ok) {
      const message = payload?.message || payload?.error || payload?.detail || `Activation request failed (HTTP ${response.status}).`;
      throw new Error(String(message));
    }

    const activation = safeActivation(payload);
    const websocket = parseWebsocketConfig(payload, {
      url: this.fixedWsUrl,
      token: this.fixedAccessToken
    });
    const activated = Boolean(websocket.url && websocket.token);

    if (!activated && !activation.code && !activation.challenge) {
      throw new Error('Xiaozhi OTA response did not contain an activation code or WebSocket configuration.');
    }

    return {
      status: activated ? 'activated' : 'pending',
      activation,
      websocket,
      upstreamStatus: response.status,
      source: this.connectionMode
    };
  }
}
