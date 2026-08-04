import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activationExpiry,
  formatOtp,
  isOtpExpired,
  isValidOtp,
  normalizeOtp,
  remainingOtpSeconds,
  withOtpExpiry
} from '../../web/src/core/otp.js';

test('normalizes and formats only an exact six-digit OTP', () => {
  assert.equal(normalizeOtp(' 123-456 '), '123456');
  assert.equal(formatOtp('123456'), '123 456');
  assert.equal(isValidOtp('123456'), true);
  assert.equal(isValidOtp('12345'), false);
  assert.equal(isValidOtp('1234567'), false);
  assert.equal(isValidOtp('ABC123'), false);
  assert.equal(formatOtp('1234567'), '——— ———');
  assert.equal(formatOtp('ABC123'), '——— ———');
});

test('stores a fixed OTP expiry instead of extending it during polling', () => {
  const issued = withOtpExpiry({
    id: 'session-1',
    code: '123456',
    createdAt: 1_000,
    updatedAt: 1_000,
    timeoutMs: 300_000
  }, 1_000);

  const polled = withOtpExpiry({
    id: 'session-1',
    code: '123456',
    createdAt: 1_000,
    updatedAt: 120_000,
    timeoutMs: 300_000
  }, 120_000);

  assert.equal(issued.otpExpiresAt, 301_000);
  assert.equal(polled.otpExpiresAt, 301_000);
  assert.equal(activationExpiry(polled, 200_000), 301_000);
  assert.equal(remainingOtpSeconds(polled, 300_500), 1);
  assert.equal(isOtpExpired(polled, 301_000), true);
});
