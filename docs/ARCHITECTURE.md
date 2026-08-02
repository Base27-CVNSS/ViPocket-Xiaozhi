# Kiến trúc / Architecture

## 1. Mục tiêu thiết kế

ViPocket tách trình duyệt khỏi bí mật upstream. Browser chịu trách nhiệm UI và media. Gateway chịu trách nhiệm định danh thiết bị, activation, token và WebSocket handshake headers.

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

  subgraph Gateway
    HTTP[Activation REST API]
    STORE[Ephemeral Session & Ticket Store]
    PROXY[Authenticated WebSocket Proxy]
    HTTP <--> STORE
    STORE <--> PROXY
  end

  subgraph Upstream
    OTA[OTA / Activation]
    WS[Xiaozhi WebSocket]
    CONSOLE[Xiaozhi Console]
    CONSOLE --> OTA
  end

  Browser <--> HTTP
  Browser <--> PROXY
  HTTP <--> OTA
  PROXY <--> WS
```

## 3. Activation sequence

```mermaid
sequenceDiagram
  participant B as Browser
  participant G as Gateway
  participant O as OTA Endpoint
  participant C as Xiaozhi Console

  B->>G: POST /api/v1/activation
  G->>O: POST + Activation-Version/Device-Id/Client-Id
  O-->>G: activation.code
  G-->>B: code + session id
  B-->>C: User enters code
  loop Poll
    B->>G: GET /api/v1/activation/:id
    G->>O: Repeat OTA check
    O-->>G: activation or websocket config
  end
  G-->>B: status=activated
```

## 4. Voice sequence

```mermaid
sequenceDiagram
  participant B as Browser
  participant G as Gateway
  participant X as Xiaozhi

  B->>G: Request one-time ticket
  G-->>B: ticket (short TTL)
  B->>G: WS /ws/xiaozhi?ticket=...
  G->>X: WS + Authorization/Device-Id/Client-Id
  B->>X: hello (proxied)
  X-->>B: hello + session_id
  B->>X: listen/start
  loop 60 ms
    B->>X: Binary Opus frame
  end
  B->>X: listen/stop
  X-->>B: stt / llm / tts JSON
  X-->>B: Binary Opus audio
```

## 5. Trách nhiệm từng thành phần

### Browser

- Không lưu access token.
- Sinh và giữ định danh browser device.
- Kiểm tra khả năng Secure Context, AudioWorklet và WebCodecs Opus.
- Encode/decode audio.
- Chuyển đổi message protocol thành trạng thái UI.

### Gateway

- Gọi OTA bằng header thiết bị.
- Không trả upstream token về browser.
- Cấp ticket WebSocket dùng một lần.
- Mở upstream WebSocket với header tùy chỉnh.
- Chuyển tiếp text/binary không biến đổi.

### Upstream

- Cấp activation code.
- Gắn thiết bị với tài khoản/agent.
- Cấp WebSocket URL/token.
- Thực hiện ASR, LLM, TTS và MCP tùy cấu hình server.
