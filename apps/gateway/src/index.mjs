import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocketPlugin from '@fastify/websocket';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { config } from './config.mjs';
import { SessionStore } from './session-store.mjs';
import { ActivationService } from './activation-service.mjs';

const app = Fastify({
  logger: {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        '*.token',
        '*.accessToken',
        '*.websocket.token'
      ],
      censor: '[REDACTED]'
    }
  },
  bodyLimit: config.maxBodyBytes
});

const store = new SessionStore(config);
const activationService = new ActivationService(config);

const activationRequestSchema = z.object({
  deviceId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9:_-]+$/),
  clientId: z.string().uuid(),
  language: z.string().min(2).max(16).default('vi-VN'),
  systemInfo: z.record(z.unknown()).default({})
});

await app.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
});

await app.register(cors, {
  origin(origin, callback) {
    if (!origin || config.publicOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed.'), false);
  },
  methods: ['GET', 'POST', 'DELETE'],
  credentials: false
});

await app.register(rateLimit, {
  max: 120,
  timeWindow: '1 minute'
});

await app.register(websocketPlugin, {
  options: {
    maxPayload: 1024 * 1024,
    perMessageDeflate: false
  }
});

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

app.get('/health', async () => ({
  ok: true,
  service: 'vipocket-gateway',
  version: '2.0.0',
  activationConfigured: Boolean(config.otaUrl || (config.fixedWsUrl && config.fixedAccessToken))
}));

app.post('/api/v1/activation', {
  config: { rateLimit: { max: 12, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const parsed = activationRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'INVALID_REQUEST',
      message: parsed.error.issues.map((issue) => issue.message).join('; ')
    });
  }

  try {
    const session = store.createSession(parsed.data);
    const refreshed = await refreshSession(session);
    return reply.code(201).send(publicSession(refreshed));
  } catch (error) {
    request.log.warn({ err: error }, 'Activation request failed');
    return reply.code(502).send({
      error: 'ACTIVATION_UPSTREAM_ERROR',
      message: error.message
    });
  }
});

app.get('/api/v1/activation/:id', async (request, reply) => {
  const session = store.getSession(request.params.id);
  if (!session) {
    return reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: 'Activation session expired or does not exist.' });
  }

  try {
    const refreshed = session.status === 'activated' ? session : await refreshSession(session);
    return publicSession(refreshed);
  } catch (error) {
    request.log.warn({ err: error, sessionId: session.id }, 'Activation polling failed');
    return reply.code(502).send({
      error: 'ACTIVATION_UPSTREAM_ERROR',
      message: error.message,
      session: publicSession(session)
    });
  }
});

app.post('/api/v1/activation/:id/ticket', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const session = store.getSession(request.params.id);
  if (!session) {
    return reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: 'Activation session expired or does not exist.' });
  }
  if (session.status !== 'activated') {
    return reply.code(409).send({ error: 'NOT_ACTIVATED', message: 'The device is not activated yet.' });
  }

  const ticket = store.issueTicket(session.id);
  return {
    ticket: ticket.token,
    expiresAt: ticket.expiresAt
  };
});

app.delete('/api/v1/activation/:id', async (request, reply) => {
  store.deleteSession(request.params.id);
  return reply.code(204).send();
});

app.get('/ws/xiaozhi', { websocket: true }, (browserSocket, request) => {
  const ticket = request.query?.ticket;
  const session = typeof ticket === 'string' ? store.consumeTicket(ticket) : null;

  if (!session?.websocket?.url || !session?.websocket?.token) {
    browserSocket.close(1008, 'Invalid or expired ticket.');
    return;
  }

  const upstream = new WebSocket(session.websocket.url, {
    perMessageDeflate: false,
    headers: {
      Authorization: `Bearer ${session.websocket.token}`,
      'Protocol-Version': String(session.websocket.version || 1),
      'Device-Id': session.deviceId,
      'Client-Id': session.clientId
    }
  });

  let browserClosed = false;
  let upstreamClosed = false;
  const pendingBrowserFrames = [];

  const closeBrowser = (code = 1011, reason = 'Upstream connection closed.') => {
    if (browserClosed || browserSocket.readyState > 1) return;
    browserClosed = true;
    browserSocket.close(code, reason.slice(0, 120));
  };

  const closeUpstream = (code = 1000, reason = 'Browser connection closed.') => {
    if (upstreamClosed || upstream.readyState > 1) return;
    upstreamClosed = true;
    upstream.close(code, reason.slice(0, 120));
  };

  upstream.on('open', () => {
    request.log.info({ sessionId: session.id }, 'Upstream Xiaozhi WebSocket connected');
    for (const frame of pendingBrowserFrames.splice(0)) {
      upstream.send(frame.data, { binary: frame.isBinary });
    }
  });

  browserSocket.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    if (upstream.readyState === WebSocket.CONNECTING && pendingBrowserFrames.length < 32) {
      pendingBrowserFrames.push({ data, isBinary });
    }
  });

  upstream.on('message', (data, isBinary) => {
    if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(data, { binary: isBinary });
  });

  browserSocket.on('close', (code, reason) => {
    browserClosed = true;
    closeUpstream(code || 1000, reason?.toString() || 'Browser closed.');
  });

  browserSocket.on('error', (error) => {
    request.log.warn({ err: error, sessionId: session.id }, 'Browser WebSocket error');
    closeUpstream(1011, 'Browser WebSocket error.');
  });

  upstream.on('close', (code, reason) => {
    upstreamClosed = true;
    closeBrowser(code || 1011, reason?.toString() || 'Upstream closed.');
  });

  upstream.on('error', (error) => {
    request.log.warn({ err: error, sessionId: session.id }, 'Upstream Xiaozhi WebSocket error');
    closeBrowser(1011, 'Unable to connect to Xiaozhi upstream.');
  });
});

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, 'Unhandled request error');
  reply.code(error.statusCode || 500).send({
    error: 'GATEWAY_ERROR',
    message: error.statusCode && error.statusCode < 500 ? error.message : 'Gateway request failed.'
  });
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
