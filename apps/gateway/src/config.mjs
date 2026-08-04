import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(currentDir, '..', '..', '..');

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, 'utf8');
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(join(rootDir, '.env'));

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function optionalUrl(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) return '';
  const parsed = new URL(value);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error(`${name} uses an unsupported protocol.`);
  }
  return parsed.toString();
}

const port = integer('PORT', 8787, 1, 65535);
const defaultOrigins = [
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  'http://127.0.0.1:5173',
  'http://localhost:5173'
];

export const config = Object.freeze({
  host: String(process.env.HOST || '127.0.0.1'),
  port,
  logLevel: String(process.env.LOG_LEVEL || 'info'),
  publicOrigins: String(process.env.PUBLIC_ORIGINS || defaultOrigins.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  otaUrl: optionalUrl('XIAOZHI_OTA_URL'),
  fixedWsUrl: optionalUrl('XIAOZHI_WS_URL'),
  fixedAccessToken: String(process.env.XIAOZHI_ACCESS_TOKEN || '').trim(),
  activationPollMs: integer('ACTIVATION_POLL_MS', 2500, 1000, 30000),
  sessionTtlMs: integer('SESSION_TTL_MS', 1800000, 60000, 86400000),
  ticketTtlMs: integer('TICKET_TTL_MS', 60000, 10000, 300000),
  maxBodyBytes: integer('MAX_BODY_BYTES', 65536, 1024, 1048576),
  webRoot: resolve(process.env.WEB_ROOT || join(rootDir, 'apps', 'web', 'dist'))
});
