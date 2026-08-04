import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { ActivationService } from './activation-service.mjs';
import { SessionStore } from './session-store.mjs';

const VERSION = '2.2.0';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..', '..', '..');
const webRoot = join(rootDir, 'apps', 'web');

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(join(rootDir, '.env'));

function integerEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: integerEnv('PORT', 5173, 1, 65535),
  otaUrl: process.env.XIAOZHI_OTA_URL || '',
  fixedWsUrl: process.env.XIAOZHI_WS_URL || '',
  fixedAccessToken: process.env.XIAOZHI_ACCESS_TOKEN || '',
  activationPollMs: integerEnv('ACTIVATION_POLL_MS', 2500, 1000, 30000),
  sessionTtlMs: integerEnv('SESSION_TTL_MS', 1800000, 60000, 86400000),
  ticketTtlMs: integerEnv('TICKET_TTL_MS', 60000, 10000, 300000),
  maxBodyBytes: integerEnv('MAX_BODY_BYTES', 65536, 1024, 1048576)
});

const store = new SessionStore(config);
const activationService = new ActivationService(config);
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
const requestCounters = new Map();

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8']
]);

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), payment=()',
    'Cross-Origin-Resource-Policy': 'same-origin'
  };
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...securityHeaders(),
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}

function sendError(response, statusCode, code, message) {
  sendJson(response, statusCode, { error: code, message });
}

function publicSession(session) {
  return {
    id: session.id,
    status: session.status,
    deviceId: session.deviceId,
    clientId: session.clientId,
    code: session.activation?.code || '',
    message: session.activation?.message || '',
    timeoutMs: session.activation?.timeoutMs || 0,
    pollAfterMs: config.activationPollMs,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

async function refreshSession(session) {
  const result = await activationService.check(session);
  return store.updateSession(session.id, {
    status: result.status,
    activation: result.activation,
    websocket: result.websocket
  });
}

function validateActivationRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be an object.');
  if (typeof value.deviceId !== 'string' || !/^[a-zA-Z0-9:_-]{8,128}$/.test(value.deviceId)) {
    throw new Error('deviceId is invalid.');
  }
  if (typeof value.clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.clientId)) {
    throw new Error('clientId must be a UUID.');
  }
  const language = typeof value.language === 'string' && value.language.length >= 2 && value.language.length <= 16
    ? value.language
    : 'vi-VN';
  const systemInfo = value.systemInfo && typeof value.systemInfo === 'object' && !Array.isArray(value.systemInfo)
    ? value.systemInfo
    : {};
  return { deviceId: value.deviceId, clientId: value.clientId, language, systemInfo };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body is not valid JSON.');
  }
}

function allowRequest(request, limit = 120, windowMs = 60000) {
  const address = request.socket.remoteAddress || 'unknown';
  const route = request.url?.split('?')[0] || '/';
  const key = `${address}:${route}`;
  const now = Date.now();
  const current = requestCounters.get(key);
  if (!current || current.resetAt <= now) {
    requestCounters.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function safeStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const clean = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = resolve(webRoot, clean || 'index.html');
  if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${sep}`)) return null;
  return candidate;
}

function cacheControl(filePath) {
  const fileName = filePath.split(/[\\/]/).at(-1) || '';
  if (fileName === 'index.html') return 'no-cache, no-store, must-revalidate';
  return 'public, max-age=3600';
}

function serveStatic(request, response, pathname) {
  let filePath = safeStaticPath(pathname);
  if (!filePath) {
    sendError(response, 400, 'BAD_PATH', 'Invalid path.');
    return;
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    if (extname(filePath)) {
      sendError(response, 404, 'NOT_FOUND', 'File not found.');
      return;
    }
    filePath = join(webRoot, 'index.html');
  }

  const stat = statSync(filePath);
  const contentType = mimeTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream';
  response.writeHead(200, {
    ...securityHeaders(contentType),
    'Content-Length': stat.size,
    'Cache-Control': cacheControl(filePath)
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
}

async function handleApi(request, response, url) {
  if (!allowRequest(request, url.pathname.includes('/ticket') ? 20 : 60)) {
    sendError(response, 429, 'RATE_LIMITED', 'Too many requests.');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'vipocket-standalone',
      version: VERSION,
      singlePort: true,
      activationConfigured: Boolean(config.otaUrl || (config.fixedWsUrl && config.fixedAccessToken))
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/activation') {
    try {
      const body = validateActivationRequest(await readJsonBody(request));
      const session = store.createSession(body);
      const refreshed = await refreshSession(session);
      sendJson(response, 201, publicSession(refreshed));
    } catch (error) {
      const upstream = /XIAOZHI_|Activation endpoint|Activation request/i.test(error.message);
      sendError(response, upstream ? 502 : 400, upstream ? 'ACTIVATION_UPSTREAM_ERROR' : 'INVALID_REQUEST', error.message);
    }
    return;
  }

  const match = url.pathname.match(/^\/api\/v1\/activation\/([0-9a-f-]+)(?:\/(ticket))?$/i);
  if (match) {
    const session = store.getSession(match[1]);
    if (!session) {
      sendError(response, 404, 'SESSION_NOT_FOUND', 'Activation session expired or does not exist.');
      return;
    }

    if (request.method === 'GET' && !match[2]) {
      try {
        const refreshed = session.status === 'activated' ? session : await refreshSession(session);
        sendJson(response, 200, publicSession(refreshed));
      } catch (error) {
        sendError(response, 502, 'ACTIVATION_UPSTREAM_ERROR', error.message);
      }
      return;
    }

    if (request.method === 'POST' && match[2] === 'ticket') {
      if (session.status !== 'activated') {
        sendError(response, 409, 'NOT_ACTIVATED', 'The device is not activated yet.');
        return;
      }
      const ticket = store.issueTicket(session.id);
      sendJson(response, 200, ticket);
      return;
    }

    if (request.method === 'DELETE' && !match[2]) {
      store.deleteSession(session.id);
      response.writeHead(204, securityHeaders());
      response.end();
      return;
    }
  }

  sendError(response, 404, 'NOT_FOUND', 'API route not found.');
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || `${config.host}:${config.port}`}`);
    if (url.pathname === '/health' || url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
      sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are allowed for static files.');
      return;
    }
    serveStatic(request, response, url.pathname);
  } catch (error) {
    console.error('[ViPocket] HTTP error:', error);
    if (!response.headersSent) sendError(response, 500, 'SERVER_ERROR', 'Local server request failed.');
    else response.end();
  }
});

server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || `${config.host}:${config.port}`}`);
    if (url.pathname !== '/ws/xiaozhi') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ticket = url.searchParams.get('ticket');
    const session = ticket ? store.consumeTicket(ticket) : null;
    if (!session?.websocket?.url || !session?.websocket?.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (browserSocket) => {
      webSocketServer.emit('connection', browserSocket, request, session);
    });
  } catch {
    socket.destroy();
  }
});

webSocketServer.on('connection', (browserSocket, request, session) => {
  const upstream = new WebSocket(session.websocket.url, {
    perMessageDeflate: false,
    headers: {
      Authorization: `Bearer ${session.websocket.token}`,
      'Protocol-Version': String(session.websocket.version || 1),
      'Device-Id': session.deviceId,
      'Client-Id': session.clientId
    }
  });
  const pending = [];

  browserSocket.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 32) pending.push({ data, isBinary });
  });

  upstream.on('open', () => {
    for (const frame of pending.splice(0)) upstream.send(frame.data, { binary: frame.isBinary });
  });

  upstream.on('message', (data, isBinary) => {
    if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(data, { binary: isBinary });
  });

  browserSocket.on('close', (code, reason) => {
    if (upstream.readyState < WebSocket.CLOSING) upstream.close(code || 1000, reason.toString().slice(0, 120));
  });
  browserSocket.on('error', () => {
    if (upstream.readyState < WebSocket.CLOSING) upstream.close(1011, 'Browser socket error.');
  });
  upstream.on('close', (code, reason) => {
    if (browserSocket.readyState < WebSocket.CLOSING) browserSocket.close(code || 1011, reason.toString().slice(0, 120));
  });
  upstream.on('error', (error) => {
    console.error('[ViPocket] Upstream WebSocket error:', error.message);
    if (browserSocket.readyState < WebSocket.CLOSING) browserSocket.close(1011, 'Unable to connect to Xiaozhi upstream.');
  });
});

const cleanupTimer = setInterval(() => {
  store.cleanup();
  const now = Date.now();
  for (const [key, value] of requestCounters) {
    if (value.resetAt <= now) requestCounters.delete(key);
  }
}, 30000);
cleanupTimer.unref();

function shutdown(signal) {
  console.log(`[ViPocket] Received ${signal}; shutting down.`);
  clearInterval(cleanupTimer);
  for (const client of webSocketServer.clients) client.close(1001, 'Local server stopping.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[ViPocket] Port ${config.port} is already in use. Run STOP-VIPOCKET.cmd and try again.`);
  } else {
    console.error('[ViPocket] Server error:', error);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`[ViPocket] Website and gateway: http://${config.host}:${config.port}`);
  console.log(`[ViPocket] Health: http://${config.host}:${config.port}/health`);
  if (!config.otaUrl && !(config.fixedWsUrl && config.fixedAccessToken)) {
    console.log('[ViPocket] Local UI is ready. Configure .env before real Xiaozhi activation.');
  }
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
