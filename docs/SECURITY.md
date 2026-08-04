# Bảo mật / Security

## Mô hình đe dọa

ViPocket giả định trình duyệt không phải nơi thích hợp để giữ token upstream lâu dài. JavaScript phía client, extension và dữ liệu local storage có thể bị đọc bởi mã độc cùng origin hoặc người có quyền truy cập máy.

Phiên bản 2.2 dùng cùng origin cho website, REST API và WebSocket gateway nhằm loại bỏ CORS nội bộ và giảm số tiến trình/cổng phải bảo vệ.

## Biện pháp hiện có

- Server mặc định bind `127.0.0.1:5173`.
- Token upstream chỉ nằm trong `.env`, kết quả OTA nội bộ và bộ nhớ server.
- Public activation API không trả `websocket.token` về browser.
- Ticket WebSocket dùng `crypto.randomBytes(32)`, có TTL ngắn và bị xóa ngay khi sử dụng.
- Giới hạn kích thước JSON body.
- Giới hạn WebSocket payload.
- Rate limit theo địa chỉ và route cho API cục bộ.
- Static path được chuẩn hóa và kiểm tra nằm trong `apps/web` để chống path traversal.
- MIME type được đặt rõ; có `X-Content-Type-Options: nosniff`.
- Thêm `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` và `Cross-Origin-Resource-Policy`.
- `index.html` không được cache lâu.
- Launcher chỉ dừng tiến trình có command line thuộc thư mục ViPocket; không tự ý kill ứng dụng khác đang dùng cổng.
- CI không đóng gói `.env` hoặc log runtime vào artifact.

## Dữ liệu phía browser

Local storage chỉ giữ:

- Ngôn ngữ.
- Cấu hình UI.
- `Device-Id` và `Client-Id`.
- Trạng thái activation công khai.

Không lưu access token upstream trong local storage hoặc source JavaScript.

## Không nên làm

- Không commit `.env`.
- Không đặt token vào source, screenshot, README, issue hoặc GitHub Actions log.
- Không bind `0.0.0.0` trên máy cá nhân khi chưa có nhu cầu LAN rõ ràng.
- Không expose server ra Internet mà thiếu TLS, xác thực và phân quyền.
- Không chia sẻ activation code, `Device-Id`, `Client-Id` hoặc token trong issue công khai.
- Không đóng gói token dùng chung vào bản Portable công khai.

## Production hardening

Trước khi triển khai nhiều người dùng hoặc public:

- OAuth/OIDC phía server.
- Per-user và per-device authorization.
- Redis session store với consume-ticket nguyên tử.
- TLS reverse proxy, HSTS và request logging có lọc dữ liệu nhạy cảm.
- Secret manager thay cho file `.env`.
- Audit log cho MCP tool calls.
- CSRF protection nếu bổ sung cookie session.
- Distributed rate limiting.
- Dependency scanning, lockfile và định kỳ cập nhật.
- Content Security Policy phù hợp với WebCodecs/AudioWorklet.

## Báo cáo lỗ hổng

Không đăng token hoặc chi tiết khai thác có thể tái hiện vào issue công khai. Hãy liên hệ riêng với maintainer và chỉ công bố sau khi có bản sửa.
