import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.mjs';
import { SessionStore } from './session-store.mjs';
import { ActivationService } from './activation-service.mjs';

const VERSION = '2.3.0';
const store = new SessionStore(config);
const activationService = new ActivationService(config);
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
const rateBuckets = new Map();

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
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8']
]);

function log(level, message, details = {}) {
  const record = { time: new Date().toISOString(), level, message, ...details };
  const output = JSON.stringify(record);
  if (level === 'error' || level === 'warn') console.error(output);
  else console.log(output);
}

function originAllowed(origin) {
  return !origin || config.publicOrigins.includes(origin);
}

function applyHeaders(request, response) {
  const origin = request.headers.origin;
  if (origin && originAllowed(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
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

function validateActivationRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Request body must be a JSON object.');
  const deviceId = String(payload.deviceId || '');
  const clientId = String(payload.clientId || '');
  const language = String(payload.language || 'vi-VN');
  if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(deviceId)) throw new Error('deviceId is invalid.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) throw new Error('clientId must be a UUID.');
  if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(language)) throw new Error('language is invalid.');
  const systemInfo = payload.systemInfo && typeof payload.systemInfo === 'object' && !Array.isArray(payload.systemInfo)
    ? payload.systemInfo
    : {};
  return { deviceId, clientId, language, systemInfo };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > config.maxBodyBytes) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body is not valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function rateLimit(request, key, maximum = 120, windowMs = 60000) {
  const address = request.socket.remoteAddress || 'unknown';
  const bucketKey = `${address}:${key}`;
  const now = Date.now();
  const current = rateBuckets.get(bucketKey);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= maximum;
}

function safeStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const clean = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = resolve(config.webRoot, clean || 'index.html');
  if (candidate !== config.webRoot && !candidate.startsWith(`${config.webRoot}${sep}`)) return null;
  return candidate;
}

function staticCache(filePath) {
  const parts = filePath.split(/[\\/]/);
  const name = parts.at(-1) || '';
  if (name === 'index.html') return 'no-cache, no-store, must-revalidate';
  if (parts.includes('assets') || /\.[A-Za-z0-9_-]{8,}\./.test(name)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

function serveStatic(request, response, pathname) {
  if (!existsSync(join(config.webRoot, 'index.html'))) {
    json(response, 503, {
      error: 'WEB_BUILD_MISSING',
      message: 'Web production build is missing. Run REPAIR-VIPOCKET.cmd or npm run build.'
    });
    return;
  }

  let filePath = safeStaticPath(pathname);
  if (!filePath) {
    json(response, 400, { error: 'BAD_PATH', message: 'Invalid path.' });
    return;
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    if (extname(filePath)) {
      json(response, 404, { error: 'NOT_FOUND', message: 'Asset not found.' });
      return;
    }
    filePath = join(config.webRoot, 'index.html');
  }

  const stat = statSync(filePath);
  response.writeHead(200, {
    'Content-Type': mimeTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': staticCache(filePath)
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
}

async function handleHttp(request, response) {
  applyHeaders(request, response);
  if (!originAllowed(request.headers.origin)) {
    json(response, 403, { error: 'ORIGIN_DENIED', message: 'Origin is not allowed.' });
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${config.port}`}`);
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === '/health') {
    json(response, 200, {
      ok: true,
      service: 'vipocket-gateway',
      version: VERSION,
      website: `http://${config.host}:${config.port}/`,
      activationConfigured: Boolean(config.otaUrl || (config.fixedWsUrl && config.fixedAccessToken))
    });
    return;
  }

  if (pathname === '/api/v1/activation' && request.method === 'POST') {
    if (!rateLimit(request, 'activation-create', 12)) {
      json(response, 429, { error: 'RATE_LIMITED', message: 'Too many activation requests.' });
      return;
    }
    try {
      const input = validateActivationRequest(await readJsonBody(request));
      const session = store.createSession(input);
      const refreshed = await refreshSession(session);
      json(response, 201, publicSession(refreshed));
    } catch (error) {
      const upstream = !error.statusCode && !/invalid|must|body/i.test(error.message);
      log('warn', 'Activation request failed', { error: error.message });
      json(response, error.statusCode || (upstream ? 502 : 400), {
        error: upstream ? 'ACTIVATION_UPSTREAM_ERROR' : 'INVALID_REQUEST',
        message: error.message
      });
    }
    return;
  }

  const activationMatch = pathname.match(/^\/api\/v1\/activation\/([0-9a-f-]+)(?:\/(ticket))?$/i);
  if (activationMatch) {
    const sessionId = activationMatch[1];
    const action = activationMatch[2] || '';
    const session = store.getSession(sessionId);
    if (!session) {
      json(response, 404, { error: 'SESSION_NOT_FOUND', message: 'Activation session expired or does not exist.' });
      return;
    }

    if (request.method === 'GET' && !action) {
      try {
        const refreshed = session.status === 'activated' ? session : await refreshSession(session);
        json(response, 200, publicSession(refreshed));
      } catch (error) {
        log('warn', 'Activation polling failed', { sessionId, error: error.message });
        json(response, 502, {
          error: 'ACTIVATION_UPSTREAM_ERROR',
          message: error.message,
          session: publicSession(session)
        });
      }
      return;
    }

    if (request.method === 'POST' && action === 'ticket') {
      if (!rateLimit(request, 'ticket', 20)) {
        json(response, 429, { error: 'RATE_LIMITED', message: 'Too many ticket requests.' });
        return;
      }
      if (session.status !== 'activated') {
        json(response, 409, { error: 'NOT_ACTIVATED', message: 'The device is not activated yet.' });
        return;
      }
      const ticket = store.issueTicket(session.id);
      json(response, 200, { ticket: ticket.token, expiresAt: ticket.expiresAt });
      return;
    }

    if (request.method === 'DELETE' && !action) {
      store.deleteSession(session.id);
      response.writeHead(204);
      response.end();
      return;
    }
  }

  if (pathname.startsWith('/api/')) {
    json(response, 404, { error: 'NOT_FOUND', message: 'API route not found.' });
    return;
  }

  if (['GET', 'HEAD'].includes(request.method || '')) {
    serveStatic(request, response, pathname);
    return;
  }

  json(response, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
}

function proxyWebSocket(browserSocket, session, request) {
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
  let closed = false;

  function closeBoth(code = 1011, reason = 'Connection closed.') {
    if (closed) return;
    closed = true;
    if (browserSocket.readyState < WebSocket.CLOSING) browserSocket.close(code, reason.slice(0, 120));
    if (upstream.readyState < WebSocket.CLOSING) upstream.close(code, reason.slice(0, 120));
  }

  upstream.on('open', () => {
    log('info', 'Upstream Xiaozhi WebSocket connected', { sessionId: session.id });
    for (const frame of pending.splice(0)) upstream.send(frame.data, { binary: frame.isBinary });
  });
  browserSocket.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 32) pending.push({ data, isBinary });
  });
  upstream.on('message', (data, isBinary) => {
    if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(data, { binary: isBinary });
  });
  browserSocket.on('close', (code, reason) => closeBoth(code || 1000, reason.toString() || 'Browser closed.'));
  upstream.on('close', (code, reason) => closeBoth(code || 1011, reason.toString() || 'Upstream closed.'));
  browserSocket.on('error', (error) => {
    log('warn', 'Browser WebSocket error', { sessionId: session.id, error: error.message });
    closeBoth(1011, 'Browser WebSocket error.');
  });
  upstream.on('error', (error) => {
    log('warn', 'Upstream WebSocket error', { sessionId: session.id, error: error.message });
    closeBoth(1011, 'Unable to connect to Xiaozhi upstream.');
  });
  log('info', 'Browser WebSocket accepted', { sessionId: session.id, address: request.socket.remoteAddress });
}

const server = createServer((request, response) => {
  handleHttp(request, response).catch((error) => {
    log('error', 'Unhandled HTTP error', { error: error.message });
    if (!response.headersSent) {
      applyHeaders(request, response);
      json(response, 500, { error: 'GATEWAY_ERROR', message: 'Gateway request failed.' });
    } else response.destroy(error);
  });
});

server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${config.port}`}`);
    if (url.pathname !== '/ws/xiaozhi' || !originAllowed(request.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const session = store.consumeTicket(url.searchParams.get('ticket') || '');
    if (!session?.websocket?.url || !session?.websocket?.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (browserSocket) => {
      proxyWebSocket(browserSocket, session, request);
    });
  } catch (error) {
    log('warn', 'WebSocket upgrade rejected', { error: error.message });
    socket.destroy();
  }
});

const cleanupTimer = setInterval(() => {
  store.cleanup();
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
}, 60000);
cleanupTimer.unref();

function shutdown(signal) {
  log('info', 'Shutting down ViPocket', { signal });
  clearInterval(cleanupTimer);
  for (const client of websocketServer.clients) client.close(1001, 'Server shutdown.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

server.on('error', (error) => {
  log('error', 'Server startup error', { error: error.message, code: error.code });
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log('info', 'ViPocket website and gateway are ready', {
    url: `http://${config.host}:${config.port}/`,
    activationConfigured: Boolean(config.otaUrl || (config.fixedWsUrl && config.fixedAccessToken))
  });
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
