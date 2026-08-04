import test from 'node:test';
import assert from 'node:assert/strict';

for (const key of [
  'XIAOZHI_MODE',
  'XIAOZHI_OTA_URL',
  'XIAOZHI_WS_URL',
  'XIAOZHI_ACCESS_TOKEN'
]) {
  delete process.env[key];
}

const { config, OFFICIAL_OTA_URL } = await import('../src/config.mjs');

test('uses the official Xiaozhi OTA endpoint with no user configuration', () => {
  assert.equal(config.connectionMode, 'official');
  assert.equal(config.otaUrl, OFFICIAL_OTA_URL);
  assert.equal(OFFICIAL_OTA_URL, 'https://api.tenclass.net/xiaozhi/ota/');
});
