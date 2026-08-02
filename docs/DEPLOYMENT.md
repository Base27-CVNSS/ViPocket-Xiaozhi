# Triển khai / Deployment

## 1. Local development

```bash
npm install
cp .env.example .env
npm run dev
```

Web: `http://127.0.0.1:5173`

Gateway: `http://127.0.0.1:8787`

## 2. Production build

```bash
npm install
npm run check
npm run build
NODE_ENV=production npm start
```

Serve `apps/web/dist` through Nginx, Caddy or another static server.

## 3. Reverse proxy example (Nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name vipocket.example.com;

    root /srv/vipocket/apps/web/dist;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /health {
        proxy_pass http://127.0.0.1:8787;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

Set browser gateway URL to `https://vipocket.example.com`.

## 4. Process supervision

Use systemd, Docker, PM2 or another supervisor. The gateway must restart on failure, but remember that version 2.0 keeps sessions in RAM.

## 5. Scale-out requirements

Before running more than one gateway instance:

- Replace `SessionStore` with Redis.
- Store tickets atomically with consume-once semantics.
- Share activation sessions across instances.
- Enable sticky WebSocket routing or shared ticket validation.
- Add user identity and tenant boundaries.
