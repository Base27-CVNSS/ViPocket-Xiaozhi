# Kiến trúc / Architecture

## 1. Nguyên tắc thiết kế

ViPocket 2.2 tách bí mật upstream khỏi trình duyệt nhưng **không tách website và gateway thành hai dịch vụ**. Một tiến trình Node.js tại `127.0.0.1:5173` phục vụ đồng thời:

- HTML, CSS và ES modules của web client.
- REST API activation.
- Health API.
- WebSocket proxy Xiaozhi.
- Bộ nhớ session và ticket ngắn hạn.

Điều này loại bỏ CORS nội bộ, cổng `8787`, Vite runtime và việc phối hợp hai tiến trình.

## 2. Các lớp chính

```mermaid
flowchart TB
  subgraph Browser
    UI[Wizard + Transcript + Diagnostics]
    FSM[UI / Conversation State Machine]
    AUDIO[AudioWorklet + WebCodecs Opus]
    PROTO[Xiaozhi JSON Protocol Adapter]
    UI --> FSM
    FSM --> PROTO
    AUDIO <--> PROTO
  end

  subgraph Standalone[Standalone Node.js :5173]
    STATIC[Static ES-module server]
    HTTP[Activation REST API]
    STORE[Ephemeral Session and Ticket Store]
    PROXY[Authenticated WebSocket Proxy]
    STATIC --- HTTP
    HTTP <--> STORE
    STORE <--> PROXY
  end

  subgraph Upstream
    OTA[OTA / Activation]
    WS[Xiaozhi WebSocket]
    CONSOLE[Xiaozhi Console]
    CONSOLE --> OTA
  end

  Browser <--> STATIC
  Browser <--> HTTP
  Browser <--> PROXY
  HTTP <--> OTA
  PROXY <--> WS
```

## 3. Khởi động Windows

```mermaid
sequenceDiagram
  participant U as User
  participant L as START-VIPOCKET
  participant N as Portable Node.js
  participant S as Standalone server
  participant B as Browser

  U->>L: Double-click
  L->>L: Create .env when missing
  L->>N: Select bundled runtime
  L->>L: Verify node_modules/ws
  L->>S: Run standalone.mjs
  L->>S: GET /health
  S-->>L: ok=true
  L->>B: Open http://127.0.0.1:5173
```

## 4. Activation sequence

```mermaid
sequenceDiagram
  participant B as Browser
  participant S as Standalone server
  participant O as OTA endpoint
  participant C as Xiaozhi Console

  B->>S: POST /api/v1/activation
  S->>O: POST + Activation-Version/Device-Id/Client-Id
  O-->>S: activation.code
  S-->>B: Public code + local session id
  B-->>C: User enters code
  loop Poll
    B->>S: GET /api/v1/activation/:id
    S->>O: Repeat OTA check
    O-->>S: activation or websocket config
  end
  S-->>B: status=activated
```

## 5. Voice sequence

```mermaid
sequenceDiagram
  participant B as Browser
  participant S as Standalone server
  participant X as Xiaozhi

  B->>S: Request one-time ticket
  S-->>B: Short-lived ticket
  B->>S: WS /ws/xiaozhi?ticket=...
  S->>X: WS + Authorization/Device-Id/Client-Id
  B->>X: hello, proxied
  X-->>B: hello + session_id
  B->>X: listen/start
  loop Every 60 ms
    B->>X: Binary Opus packet
  end
  B->>X: listen/stop
  X-->>B: stt / llm / tts JSON
  X-->>B: Binary Opus audio
```

## 6. Trách nhiệm

### Browser

- Không nhận hoặc lưu upstream access token.
- Giữ `Device-Id` và `Client-Id` ổn định trong local storage.
- Thu microphone bằng `getUserMedia` và AudioWorklet.
- Mã hóa/giải mã Opus bằng WebCodecs.
- Hiển thị STT, trạng thái TTS, cảm xúc và chẩn đoán.
- Gửi `abort` khi barge-in.

### Standalone server

- Phục vụ web cùng origin.
- Đọc `.env` mà không cần thư viện dotenv.
- Gọi OTA bằng header thiết bị.
- Không trả upstream token về browser.
- Cấp ticket WebSocket ngẫu nhiên, ngắn hạn, dùng một lần.
- Mở upstream WebSocket với header tùy chỉnh.
- Chuyển tiếp text/binary không biến đổi.
- Giới hạn body, WebSocket payload và tần suất API.

### Upstream

- Cấp activation code thật.
- Liên kết thiết bị với tài khoản hoặc agent.
- Cấp WebSocket URL/token.
- Thực hiện ASR, LLM, TTS và MCP theo cấu hình máy chủ.

## 7. Trạng thái được giữ trong RAM

`SessionStore` hiện là bộ nhớ tiến trình:

- Restart làm mất activation session và ticket.
- Ticket bị xóa ngay sau lần sử dụng đầu tiên.
- Session tự hết hạn.

Khi scale nhiều instance, cần Redis hoặc kho dữ liệu chia sẻ có thao tác consume-ticket nguyên tử.
