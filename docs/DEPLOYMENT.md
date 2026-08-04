# Triển khai / Deployment

## 1. Windows Portable

Bản artifact Windows đã chứa Node.js x64 portable và dependency production.

```text
Giải nén ZIP
→ START-VIPOCKET.cmd
→ http://127.0.0.1:5173
```

Health endpoint:

```text
http://127.0.0.1:5173/health
```

Bản artifact không cần Git, cài Node.js, Vite hoặc `npm install`.

## 2. Chạy từ mã nguồn

```bash
npm install --omit=dev
cp .env.example .env
npm run check
npm start
```

Một tiến trình phục vụ web, API và WebSocket trên cùng cổng `5173`.

Chế độ theo dõi thay đổi:

```bash
npm run dev
```

## 3. Cấu hình local-first

```dotenv
HOST=127.0.0.1
PORT=5173
XIAOZHI_OTA_URL=
XIAOZHI_WS_URL=
XIAOZHI_ACCESS_TOKEN=
ACTIVATION_POLL_MS=2500
SESSION_TTL_MS=1800000
TICKET_TTL_MS=60000
MAX_BODY_BYTES=65536
```

Giữ `HOST=127.0.0.1` cho máy cá nhân. Khi bind địa chỉ LAN hoặc public, phải bổ sung TLS, đăng nhập người dùng và phân quyền.

## 4. Reverse proxy Nginx

Standalone server vẫn nên bind loopback; Nginx chịu trách nhiệm TLS.

```nginx
server {
    listen 443 ssl http2;
    server_name vipocket.example.com;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}

map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
```

Không cần cấu hình root static riêng hoặc proxy sang cổng thứ hai.

## 5. Process supervision

Có thể dùng systemd, Docker, PM2 hoặc Windows Task Scheduler. Lệnh tiến trình:

```bash
node apps/gateway/src/standalone.mjs
```

Ví dụ systemd:

```ini
[Unit]
Description=ViPocket-Xiaozhi standalone
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/vipocket
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /srv/vipocket/apps/gateway/src/standalone.mjs
Restart=on-failure
RestartSec=3
User=vipocket

[Install]
WantedBy=multi-user.target
```

## 6. Scale-out

Phiên bản 2.2 giữ session và ticket trong RAM. Trước khi chạy nhiều instance:

- Thay `SessionStore` bằng Redis hoặc kho chia sẻ.
- Consume ticket bằng thao tác nguyên tử.
- Chia sẻ activation sessions.
- Thiết lập sticky WebSocket routing hoặc shared ticket validation.
- Thêm user identity và tenant boundaries.
- Thêm distributed rate limiting.

## 7. Cache và cập nhật

Standalone server trả:

- `index.html`: `no-cache, no-store`.
- Các module/asset khác: cache ngắn.

Bản Portable không đăng ký service worker nên tránh được trạng thái HTML mới nhưng bundle cũ.
