# Final OTP and PWA shell verification

The full CI pipeline must verify the current main implementation:

- real six-digit OTP normalization and formatting;
- fixed OTP expiry that polling cannot extend;
- explicit confirmation after entering OTP in Xiaozhi Console;
- local-first Web/PWA shell and JSON manifest;
- production build and gateway smoke test;
- exact assembled Windows one-click launcher smoke test.
