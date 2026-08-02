import 'dotenv/config';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const webRoot = resolve(process.env.WEB_ROOT || join(rootDir, 'apps', 'web', 'dist'));
const webHost = process.env.WEB_HOST || '127.0.0.1';
const webPort = Number(process.env.WEB_PORT || 5173);
const gatewayEntry = join(rootDir, 'apps', 'gateway', 'src', 'index.mjs');

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8']
]);

function fail(message) {
  console.error(`[ViPocket] ${message}`);
  process.exit(1);
}

if (!existsSync(join(webRoot, 'index.html'))) {
  fail(`Khong tim thay web build tai ${webRoot}. Hay chay npm run build hoac REPAIR-VIPOCKET.cmd.`);
}
if (!existsSync(gatewayEntry)) {
  fail(`Khong tim thay gateway entry tai ${gatewayEntry}.`);
}

function safeFilePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const clean = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = resolve(webRoot, clean || 'index.html');
  if (!candidate.startsWith(webRoot)) return null;
  return candidate;
}

function cacheHeader(filePath) {
  const fileName = filePath.split(/[\\/]/).pop() || '';
  if (fileName === 'index.html') return 'no-cache, no-store, must-revalidate';
  if (/\.[A-Za-z0-9_-]{8,}\./.test(fileName) || filePath.includes(`${join('assets')}${process.platform === 'win32' ? '\\' : '/'}`)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

function sendFile(request, response, filePath) {
  const extension = extname(filePath).toLowerCase();
  const stat = statSync(filePath);
  response.writeHead(200, {
    'Content-Type': mimeTypes.get(extension) || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheHeader(filePath),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin'
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

const webServer = createServer((request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Method Not Allowed');
      return;
    }

    let filePath = safeFilePath(request.url || '/');
    if (!filePath) {
      response.writeHead(400);
      response.end('Bad Request');
      return;
    }

    if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      const extension = extname(filePath);
      if (extension) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
        return;
      }
      filePath = join(webRoot, 'index.html');
    }

    sendFile(request, response, filePath);
  } catch (error) {
    console.error('[ViPocket] Static server error:', error);
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Internal Server Error');
  }
});

webServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE') fail(`Cong giao dien ${webPort} dang duoc su dung. Chay STOP-VIPOCKET.cmd roi thu lai.`);
  fail(`Khong the khoi dong web server: ${error.message}`);
});

const gateway = spawn(process.execPath, [gatewayEntry], {
  cwd: rootDir,
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: 'inherit',
  windowsHide: true
});

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  webServer.close(() => {});
  if (!gateway.killed) gateway.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (!gateway.killed) gateway.kill('SIGKILL');
    process.exit(exitCode);
  }, 3000);
  timer.unref();
}

gateway.on('error', (error) => {
  console.error('[ViPocket] Gateway process error:', error);
  shutdown(1);
});

gateway.on('exit', (code, signal) => {
  if (shuttingDown) return;
  console.error(`[ViPocket] Gateway da dung (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`);
  shutdown(code || 1);
});

webServer.listen(webPort, webHost, () => {
  console.log(`[ViPocket] Website: http://${webHost}:${webPort}`);
  console.log(`[ViPocket] Gateway dang khoi dong tai http://127.0.0.1:${process.env.PORT || 8787}`);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (error) => {
  console.error('[ViPocket] Uncaught exception:', error);
  shutdown(1);
});
process.on('unhandledRejection', (error) => {
  console.error('[ViPocket] Unhandled rejection:', error);
  shutdown(1);
});
