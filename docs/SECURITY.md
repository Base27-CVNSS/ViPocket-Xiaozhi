# Bảo mật / Security

## Mô hình đe dọa

ViPocket giả định trình duyệt không phải nơi thích hợp để giữ token upstream lâu dài. Mã JavaScript, extension và dữ liệu local storage có thể bị người dùng hoặc mã độc cùng origin đọc được.

## Biện pháp hiện có

- Token upstream chỉ nằm trong session object ở gateway.
- API REST không trả `websocket.token` về browser.
- Ticket WebSocket dùng `crypto.randomBytes(32)`, hết hạn ngắn và bị xóa ngay khi sử dụng.
- Gateway mặc định bind `127.0.0.1`.
- CORS chỉ cho các origin khai báo trong `PUBLIC_ORIGINS`.
- Rate limit áp dụng toàn cục và chặt hơn ở activation/ticket.
- Giới hạn kích thước body và WebSocket payload.
- Helmet thêm các security headers cơ bản.
- Logger redacts authorization và token fields.

## Không nên làm

- Không commit `.env`.
- Không đặt token vào web source, GitHub Actions log hoặc ảnh README.
- Không dùng `Access-Control-Allow-Origin: *` cùng gateway có quyền truy cập upstream.
- Không expose gateway ra Internet mà thiếu đăng nhập, authorization và TLS.
- Không chia sẻ `Device-Id`, `Client-Id`, activation code hoặc token trong issue công khai.

## Production hardening

- OAuth/OIDC phía gateway.
- Redis session store có encryption at rest.
- Per-user/device authorization.
- Reverse proxy TLS, HSTS và request logging có lọc dữ liệu.
- Secret manager thay cho file `.env`.
- Audit log cho MCP tool call.
- CSRF protection nếu bổ sung cookie session.
- Dependency scanning, lockfile và định kỳ cập nhật.
