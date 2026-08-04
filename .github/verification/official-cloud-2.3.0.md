# ViPocket-Xiaozhi 2.3.0 — Final verification report

## Selected production architecture

- One local Node.js process serves the production website, REST API, and WebSocket proxy on `127.0.0.1:8787`.
- `XIAOZHI_MODE=auto` is the zero-configuration default.
- Auto mode prefers explicitly supplied fixed WebSocket credentials, then a custom OTA endpoint, and otherwise uses the official OTA endpoint configured by `78/xiaozhi-esp32`.
- The browser uses a stable locally administered unicast MAC address plus a UUID client identifier.
- The OTA request includes firmware-compatible activation headers and a `Board::GetSystemInfoJson()`-shaped payload.
- Upstream WebSocket credentials remain inside the local gateway; the browser receives only a short-lived, single-use ticket.

## Automated verification

### Pull request #3 — complete 2.3 feature verification

Workflow run: `30879605909`

Passed:

- JavaScript syntax checks.
- Six gateway unit tests.
- Official Cloud zero-configuration default test.
- Activation headers, activation code, fixed transport, and post-pair WebSocket configuration tests.
- Vite production build.
- Linux website and gateway smoke test.
- PowerShell syntax validation.
- Self-contained Windows x64 package assembly.
- Execution of the exact packaged `windows-one-click.ps1` launcher.
- Website and `/health` checks.
- ZIP creation and workflow artifact upload.

### Pull request #4 — final version synchronization

Workflow run: `30879983445`

Passed:

- Complete Linux verification job.
- Complete Windows x64 packaging job.
- Exact assembled one-click launcher smoke test.
- Website, gateway, production build, and `activationConfigured=true` checks.
- Final ZIP creation and artifact upload.

## Final verified artifact

- Artifact ID: `8880924006`
- GitHub artifact digest: `sha256:ed1f835abad1a8e5bf2aa9fe73f69a5e28a9431e80f91c9f9691ba6d8c1ebfa7`
- Inner Windows release ZIP SHA-256: `a266b531d1e401ed689d000fbad87533c5d3ebc976464faaafb5e0bcc4cea12e`

The final package was downloaded and inspected after CI. It contains:

- `START-VIPOCKET.cmd`
- `STOP-VIPOCKET.cmd`
- `REPAIR-VIPOCKET.cmd`
- `CONFIGURE-XIAOZHI.cmd`
- bundled `runtime/node.exe`
- production `node_modules/ws`
- built `apps/web/dist/index.html`
- gateway version `2.3.0`
- web bootstrap marker `2.3.0`
- `XIAOZHI_MODE=auto` in `.env.example`

The archive does not contain a committed `.env`, private token, PEM file, or private key.

## Confidence boundary

Within the controlled repository and package scope, the release has passed all defined syntax, unit, build, health, packaging, and exact Windows launcher checks.

No repository can guarantee the future uptime, account eligibility, pairing policy, or protocol behavior of an external hosted Xiaozhi service. Those external conditions remain outside ViPocket's control and are reported as runtime errors rather than simulated as success.
