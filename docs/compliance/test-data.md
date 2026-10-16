# Dữ liệu test — chính sách và danh sách số/mail mẫu

Áp dụng cho fixture, seed, test (đơn vị, DB, E2E) và tài liệu mẫu (QA-DATA-001/002, BASE-DATA-005 của blueprint).
Rào máy: `packages/app/src/units-guards.test.ts` (chạy trong `pnpm test`).

## Quy tắc
1. **Cấm** dump/export dữ liệu production (hoặc dữ liệu thật của khách) trong repo, CI, staging và máy dev. Dữ liệu thật chỉ ở production, sau DPIA (`PROJECT.md` §6).
2. Fixture không chứa dữ liệu cá nhân thật: tên ghi rõ giả ("(giả)" hoặc tên chung), email dùng domain dành riêng, SĐT dùng dải mẫu bên dưới.
3. Không commit file `.sql/.csv/.json/.xlsx/.tsv` > 1 MB (script quét trong rào máy).
4. Bí mật/khoá thật không bao giờ nằm trong fixture (xem gitleaks của `docs/security`).

## Domain email cho phép
`example.com`, `example.org`, `example.net`, `example.test`, `hotel-manager.invalid`, `evil.test` (ca tấn công giả), `localhost`.

## Dải SĐT mẫu
- **Dải giả:** `0100000NNN` (10 chữ số, đầu số `01` — không phải đầu số di động/cố định đang cấp ở Việt Nam). Hợp lệ với validate hiện có (`/^\+?[0-9 .()-]{6,20}$/` ở `lease.ts`, `reservations.ts`, `import.ts`, `booking-form.tsx`) và bị bộ che SĐT của logger (`VN_PHONE`) nhận dạng như số thật. Mọi fixture mới PHẢI dùng dải này.
- Rào máy: mọi chuỗi giống SĐT Việt Nam thật (`0[35789]xxxxxxxx`, `+84…`) trong mã nguồn phải nằm trong danh sách dưới đây; ngoài danh sách → test đỏ.
- Nếu sau này validate chặt theo đầu số di động Việt Nam, dải giả phải đổi (ghi vào đây và đổi cùng lúc); khi đó chưa có dải giả chính thức do Bộ quản lý công bố (chưa xác minh).

## Số mẫu đã khai (được phép xuất hiện ở dạng thật)
Danh sách máy đọc: mỗi dòng bắt đầu bằng "- `số`".

- `0912345678` — ví dụ phổ biến trong tài liệu, chỉ dùng trong `logging/logger.test.ts` để kiểm bộ che SĐT dạng thật (dạng `0xx`, `+84xx`).
- `+84912345678` — cùng mục đích, dạng quốc tế.
- `0900000001` — ví dụ hiển thị cho người dùng trong mẫu nhập hợp đồng (`import.ts`, dãy gần như toàn số 0; không phải số của ai).

## Còn treo (không thuộc rào hiện có)
- Số CCCD mẫu trong fixture (`001…`, `079…`, 12 chữ số) là chuỗi tự đặt, chưa có rào quét riêng; việc quét CCCD/CMND cần quy ước kiểm tra chữ số tỉnh (chưa làm).
