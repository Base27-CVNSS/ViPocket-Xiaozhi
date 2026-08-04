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

test('normalizes and formats only a six-digit OTP', () => {
  assert.equal(normalizeOtp(' 123-456 '), '123456');
  assert.equal(formatOtp('123456'), '123 456');
  assert.equal(isValidOtp('123456'), true);
  assert.equal(isValidOtp('12345'), false);
  assert.equal(isValidOtp('ABC123'), false);
});

test('stores a fixed OTP expiry instead of extending it during polling', () => {
  const session = withOtpExpiry({
    id: 'session-1',
    code: '123456',
    updatedAt: 1_000,
    timeoutMs: 300_000
  }, 1_000);

  assert.equal(session.otpExpiresAt, 301_000);
  assert.equal(activationExpiry(session, 20_000), 301_000);
  assert.equal(remainingOtpSeconds(session, 300_500), 1);
  assert.equal(isOtpExpired(session, 301_000), true);
});
