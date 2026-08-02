# Giao thức tương thích Xiaozhi / Xiaozhi-compatible protocol

## 1. Handshake

Browser gửi qua gateway:

```json
{
  "type": "hello",
  "version": 1,
  "features": {
    "mcp": true,
    "aec": true,
    "barge_in_v2": true,
    "audio_pts": true
  },
  "transport": "websocket",
  "audio_params": {
    "format": "opus",
    "sample_rate": 16000,
    "channels": 1,
    "frame_duration": 60
  }
}
```

Server cần trả tối thiểu:

```json
{
  "type": "hello",
  "transport": "websocket",
  "session_id": "session-id",
  "audio_params": {
    "format": "opus",
    "sample_rate": 24000,
    "channels": 1,
    "frame_duration": 60
  }
}
```

## 2. Device → Server

### Start listening

```json
{
  "session_id": "session-id",
  "type": "listen",
  "state": "start",
  "mode": "manual"
}
```

### Stop listening

```json
{
  "session_id": "session-id",
  "type": "listen",
  "state": "stop",
  "mode": "manual"
}
```

### Abort / barge-in

```json
{
  "session_id": "session-id",
  "type": "abort",
  "reason": "user_interruption"
}
```

### Audio

Mỗi binary WebSocket frame là một Opus packet protocol v1, đầu vào 16 kHz mono, frame 60 ms.

## 3. Server → Device

ViPocket xử lý:

- `hello`: xác nhận transport và lưu `session_id`.
- `stt`: transcript của người dùng.
- `llm`: emotion/text state.
- `tts/start`: chuyển UI sang speaking.
- `tts/sentence_start`: hiển thị câu trả lời.
- `tts/stop`: kết thúc speaking.
- `alert`: cảnh báo hệ thống.
- `mcp`: ghi nhận message MCP trong event log.
- Binary frame: Opus audio để giải mã/phát.

## 4. Gateway headers

Gateway mở upstream WebSocket với:

```http
Authorization: Bearer <token>
Protocol-Version: 1
Device-Id: <stable browser device id>
Client-Id: <uuid>
```

## 5. Khả năng mở rộng

Protocol v2/v3, timestamp/AEC wrapper, `turn_id`, `utterance_id`, viseme và avatar state chưa được đóng gói trong binary transport 2.0.0. Các trường feature hiện có là capability advertisement để chuẩn bị tích hợp; server có thể bỏ qua.
