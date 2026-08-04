const OTP_PATTERN = /^\d{6}$/;
const expiryBySession = new Map();

export function normalizeOtp(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function isValidOtp(value) {
  return OTP_PATTERN.test(normalizeOtp(value));
}

export function formatOtp(value) {
  const otp = normalizeOtp(value);
  if (!OTP_PATTERN.test(otp)) return '——— ———';
  return `${otp.slice(0, 3)} ${otp.slice(3)}`;
}

export function activationExpiry(session, now = Date.now()) {
  const stored = Number(session?.otpExpiresAt || 0);
  if (Number.isFinite(stored) && stored > 0) return stored;

  const cached = session?.id ? Number(expiryBySession.get(session.id) || 0) : 0;
  if (Number.isFinite(cached) && cached > 0) return cached;

  const timeoutMs = Number(session?.timeoutMs || 0);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 0;
  const issuedAt = Number(session?.createdAt || session?.updatedAt || now);
  return issuedAt + timeoutMs;
}

export function remainingOtpSeconds(session, now = Date.now()) {
  const expiresAt = activationExpiry(session, now);
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function isOtpExpired(session, now = Date.now()) {
  const remaining = remainingOtpSeconds(session, now);
  return remaining === 0;
}

export function withOtpExpiry(session, now = Date.now()) {
  if (!session || typeof session !== 'object') return session;
  const expiresAt = activationExpiry(session, now);
  if (session.id && expiresAt) expiryBySession.set(session.id, expiresAt);
  return expiresAt ? { ...session, otpExpiresAt: expiresAt } : { ...session };
}

export function forgetOtpExpiry(sessionId) {
  if (sessionId) expiryBySession.delete(sessionId);
}
