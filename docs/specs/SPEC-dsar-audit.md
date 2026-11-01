---
status: Approved
approved_by: "phiên chính (D-139, D-141, D-143; AGENTS §5)"
approved_at: "2026-11-01"
---

# Nhật ký quyền chủ thể và hạn giữ vận hành

## 1. User story

Người có tài khoản cần kiểm chứng yêu cầu về dữ liệu của mình đã được tiếp nhận, xử lý và cấp URL tải khi nào, kể cả khi chưa tham gia tổ chức nào. Người vận hành cần dọn lời mời và bucket xác thực đã hết hiệu lực mà vẫn giữ khóa đang dùng và mốc hoạt động của hồ sơ liên kết.

## 2. Tiêu chí chấp nhận

### S-001 — Tạo yêu cầu có bằng chứng nguyên tử

- Given tài khoản đã đăng nhập, có hoặc không có tổ chức.
- When tạo yêu cầu access/delete/restrict hoặc gửi lại cùng yêu cầu đang hiệu lực.
- Then tạo một sự kiện `dsar.requested`; restrict hoàn tất ngay có thêm `dsar.completed`. Gửi lại, kể cả đồng thời, không tạo thêm sự kiện vòng đời. Lỗi ghi cờ hạn chế làm rollback cả yêu cầu và bằng chứng.

### S-002 — Chuyển trạng thái và thử lại

- Given worker nhận yêu cầu đã xác minh.
- When chuyển sang processing/completed/rejected, nhận lại việc treo hoặc xoá tài khoản.
- Then mỗi thay đổi trạng thái thật có một sự kiện worker trong cùng transaction; nhận lại processing không ghi trùng. Ghi audit lỗi làm rollback chuyển trạng thái. Xoá tài khoản giữ bằng chứng và ghi việc từ chối yêu cầu khác bị đóng.

### S-003 — Chỉ chính chủ đọc, không sửa bằng chứng

- Given hai tài khoản A/B và các kết nối runtime/worker.
- When đọc hoặc thử ghi thẳng `dsar_audit_events`.
- Then A chỉ đọc của A; B không thấy của A; thiếu ngữ cảnh trả lỗi 42501. Runtime/worker không có INSERT/UPDATE/DELETE/TRUNCATE trực tiếp. Trigger append-only chặn UPDATE/DELETE/TRUNCATE kể cả bằng kết nối sở hữu bảng.

### S-004 — Ghi đúng việc cấp URL

- Given yêu cầu access của chính chủ đã completed và còn hạn tải.
- When ký URL tải rồi kiểm lại quyền, trạng thái và hạn theo đồng hồ CSDL.
- Then chỉ trả URL sau khi ghi `dsar.url_issued` thành công; tên sự kiện không khẳng định đã tải file. Ký lỗi, ghi audit lỗi hoặc hết hạn trong khi ký không tạo phản hồi cấp URL thành công. Không lưu URL, storage key, token, email, IP, user-agent hay nội dung gói trong audit.

### S-005 — Giới hạn chi phí cấp URL

- Given tài khoản có nhiều gói access còn hạn.
- When thử cấp URL tải.
- Then dùng chung hạn 30 lần thử/giờ/tài khoản (`DSAR_DOWNLOADS_PER_HOUR`, scope `dsar.download`); kiểm sau quyền/trạng thái/hạn và trước signer. Lần 31 trả 429 RATE_LIMITED có Retry-After, không gọi signer và không ghi `url_issued`. Tài khoản khác có hạn mức riêng; lỗi signer vẫn tiêu thụ lần thử.

### S-006 — Mang theo bằng chứng của mình

- Given chính chủ yêu cầu bản sao dữ liệu.
- When worker dựng gói access.
- Then `audit_events` trong JSON chỉ chứa lịch sử DSAR của chủ thể, với các trường đóng id/request_id/action/actor_type/request_type/request_status/occurred_at/correlation_id; không có sự kiện tài khoản khác. Gói phản ánh snapshot lúc dựng, chưa gồm sự kiện completed/cấp URL xảy ra sau đó.

### S-007 — Đường lùi giữ bằng chứng

- Given migration 0076 đã áp.
- When down/up trên schema chưa có audit hoặc down sau khi đã có bằng chứng.
- Then schema trống có thể down/up; schema có bằng chứng từ chối down với 55000 DSAR_AUDIT_EVIDENCE_EXISTS. Guard giữ khóa bảng theo thứ tự request rồi audit trước kiểm rỗng, không để bản ghi mới lọt giữa kiểm và DROP. Rollback ứng dụng giữ schema bổ sung và bằng chứng; không xoá audit để vượt guard.

### S-008 — Hạn giữ không phá trạng thái còn dùng

- Given lời mời không liên kết và bucket auth hết hiệu lực.
- When job `privacy.retention` chạy migration 0078.
- Then lời mời chỉ xoá sau 90 ngày từ mốc muộn nhất expires_at/updated_at/accepted_at và phải không có person_id/membership_id. Giữ mọi lời mời liên kết để không mất mốc hoạt động. Login throttle xoá sau 7 ngày từ mốc muộn nhất window_started_at/locked_until; giữ khóa còn hiệu lực. RateLimit xoá sau 7 ngày từ lastRequest tính bằng milliseconds; giá trị bigint tương lai không làm tràn timestamp. Giữ hàng đúng biên; chặn thời gian người gọi bởi đồng hồ CSDL; ngày tối thiểu 90/7/7, lô 1…5000, SKIP LOCKED, rollback/retry và lỗi từng bảng độc lập.

## 3. Dữ liệu và bằng chứng

`dsar_audit_events` có chín cột NOT NULL, theo tài khoản, FK request ON DELETE RESTRICT; không FK sang auth.user. Trigger ghi vòng đời; hàm SECURITY DEFINER chỉ runtime gọi ghi cấp URL. Các hàm dọn vận hành chỉ worker gọi, không cấp DELETE bảng trực tiếp.

Cổng: `pnpm vitest run --project db dsar retention && pnpm typecheck`. Hồi quy tại `packages/app/src/privacy/dsar-audit.db.test.ts` và `packages/app/src/retention/operational.db.test.ts`.

## 4. Giới hạn

Chưa backfill audit cho yêu cầu trước migration 0076. Audit giữ cả sau ẩn danh tài khoản, chỉ còn id bí danh; chưa có job xoá và chưa chốt thời hạn pháp lý. Chưa bổ sung quyền chỉnh sửa/phản đối/tự gỡ hạn chế. NTP, deploy audit, kho log thật và pháp lý vẫn là phần còn thiếu của CMP-AUDIT-002/CMP-VN-007.

Hạn vận hành D-141 là đề xuất kỹ thuật, chờ DPIA/pháp lý; lời mời liên kết, inbox, bank_transactions, consent/DSAR/audit không nằm trong ba hàm dọn mới. Không bật purge tổ chức production (D-125).
