import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivationService } from '../src/activation-service.mjs';

const device = {
  deviceId: '02:11:22:33:44:55',
  clientId: '123e4567-e89b-42d3-a456-426614174000',
  language: 'vi-VN',
  systemInfo: { client: 'ViPocket-Xiaozhi', version: '2.3.0' }
};

test('requests a real activation code with firmware-compatible headers', async () => {
  let captured;
  const service = new ActivationService({
    otaUrl: 'https://api.tenclass.net/xiaozhi/ota/',
    fixedWsUrl: '',
    fixedAccessToken: '',
    connectionMode: 'official',
    otaTimeoutMs: 5000,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        activation: { code: 668673, message: 'Enter this code', timeout_ms: 300000 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await service.check(device);
  assert.equal(result.status, 'pending');
  assert.equal(result.activation.code, '668673');
  assert.equal(result.source, 'official');
  assert.equal(captured.url, 'https://api.tenclass.net/xiaozhi/ota/');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['Activation-Version'], '1');
  assert.equal(captured.options.headers['Device-Id'], device.deviceId);
  assert.equal(captured.options.headers['Client-Id'], device.clientId);
  assert.equal(captured.options.headers['Accept-Language'], 'vi-VN');
  assert.deepEqual(JSON.parse(captured.options.body), device.systemInfo);
});

test('accepts websocket configuration returned after pairing', async () => {
  const service = new ActivationService({
    otaUrl: 'https://example.test/ota/',
    fixedWsUrl: '',
    fixedAccessToken: '',
    connectionMode: 'custom',
    otaTimeoutMs: 5000,
    fetchImpl: async () => new Response(JSON.stringify({
      websocket: {
        url: 'wss://example.test/xiaozhi/v1/',
        token: 'Bearer secret-token',
        version: 1
      }
    }), { status: 200 })
  });

  const result = await service.check(device);
  assert.equal(result.status, 'activated');
  assert.equal(result.websocket.url, 'wss://example.test/xiaozhi/v1/');
  assert.equal(result.websocket.token, 'secret-token');
});

test('uses fixed websocket credentials without an OTA request', async () => {
  const service = new ActivationService({
    otaUrl: '',
    fixedWsUrl: 'wss://example.test/xiaozhi/v1/',
    fixedAccessToken: 'fixed-token',
    connectionMode: 'fixed',
    otaTimeoutMs: 5000,
    fetchImpl: async () => { throw new Error('fetch must not run'); }
  });

  const result = await service.check(device);
  assert.equal(result.status, 'activated');
  assert.equal(result.websocket.token, 'fixed-token');
});
