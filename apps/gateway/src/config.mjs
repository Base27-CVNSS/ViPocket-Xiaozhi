import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173,http://localhost:8787,http://127.0.0.1:8787'),
  XIAOZHI_OTA_URL: z.string().url().optional().or(z.literal('')),
  XIAOZHI_WS_URL: z.string().url().optional().or(z.literal('')),
  XIAOZHI_ACCESS_TOKEN: z.string().optional().default(''),
  ACTIVATION_POLL_MS: z.coerce.number().int().min(1000).max(30000).default(2500),
  SESSION_TTL_MS: z.coerce.number().int().min(60000).max(86400000).default(1800000),
  TICKET_TTL_MS: z.coerce.number().int().min(10000).max(300000).default(60000),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(1048576).default(65536)
});

const env = envSchema.parse(process.env);

export const config = Object.freeze({
  host: env.HOST,
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  publicOrigins: env.PUBLIC_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean),
  otaUrl: env.XIAOZHI_OTA_URL || '',
  fixedWsUrl: env.XIAOZHI_WS_URL || '',
  fixedAccessToken: env.XIAOZHI_ACCESS_TOKEN,
  activationPollMs: env.ACTIVATION_POLL_MS,
  sessionTtlMs: env.SESSION_TTL_MS,
  ticketTtlMs: env.TICKET_TTL_MS,
  maxBodyBytes: env.MAX_BODY_BYTES
});
