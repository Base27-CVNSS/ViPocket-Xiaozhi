# Strict six-digit OTP verification

The complete CI pipeline must verify the current production implementation:

- only an exact six-digit OTP is accepted;
- overlong, short, and malformed codes are rejected without truncation;
- polling cannot extend the original OTP expiry;
- production Web/PWA build and local gateway smoke test pass;
- the exact assembled Windows one-click launcher passes its smoke test.
