---
status: Approved
approved_by: "phiên chính (D-139, AGENTS §5)"
approved_at: "2026-11-01"
---

# Cấu hình tiến trình và CLI migration (T-2504)

## 1. User story

Người vận hành cần tiến trình từ chối cấu hình sai trước khi phục vụ hoặc thay schema, giữ bí mật ngoài bundle/log và tách quyền migration khỏi tài khoản ứng dụng. Việc build không cần khoá runtime; proxy vẫn kiểm nguồn yêu cầu theo địa chỉ chuẩn của môi trường.

## 2. Tiêu chí chấp nhận

### S-001 — Khởi động server kiểm cấu hình
- Given server Node được khởi động với cấu hình runtime.
- When một biến bắt buộc thiếu/sai kiểu, hoặc cấu hình hợp lệ được nạp.
- Then thiếu/sai gây `ConfigError` nêu tên biến, không in giá trị; cấu hình hợp lệ được đông cứng và bản in được che bí mật. Instrumentation kiểm trước request; runtime edge không nạp schema Node/credential.

### S-002 — Tách cấu hình edge, build và client
- Given proxy, trình dựng service worker và mã client cần các giá trị khác nhau.
- When proxy chạy production, build chọn revision, hoặc client đọc cờ production.
- Then proxy bắt buộc `APP_BASE_URL` hợp lệ và dùng nguồn chuẩn đó thay nguồn request; chỉ ngoài production được fallback. Build chỉ kiểm `HM_BUILD_ID` tuỳ chọn, không cần URL CSDL/khoá auth. Entry client chỉ có cờ `NODE_ENV` đã thay lúc build, không import schema server hoặc mang tên/giá trị bí mật vào bundle.

### S-003 — Ngữ cảnh tiến trình có schema và một nơi đọc env
- Given logging, auth, analytics và ngữ cảnh server dùng cờ tiến trình.
- When đọc NODE_ENV/LOG_LEVEL/NEXT_RUNTIME/APP_VERSION/telemetry hoặc thêm code đọc env.
- Then cờ bootstrap đi qua schema nhỏ, giá trị sai bị từ chối mà không lộ giá trị; mã app ngoài config không đọc trực tiếp `process.env`. Công cụ/test và entry config build có phạm vi riêng. Telemetry Better Auth được yêu cầu bật vẫn làm auth từ chối khởi tạo như trước.

### S-004 — URL migration riêng, được kiểm và che
- Given người vận hành gọi CLI trên môi trường có thể chứa URL runtime/worker.
- When thiếu `MIGRATION_DATABASE_URL`, URL sai/đích mơ hồ, hoặc production tới máy khác thiếu TLS xác minh.
- Then CLI từ chối trước kết nối/DDL; không fallback sang URL ứng dụng. URL hợp lệ được giữ cho kết nối riêng, bản JSON/String/inspect không in URL hay mật khẩu; production remote yêu cầu đúng một `sslmode=verify-full`, loopback/socket được miễn.

### S-005 — Quyền migration kiểm trước DDL
- Given owner riêng hoặc tài khoản runtime/worker gọi CLI, kể cả khi chưa có bảng metadata.
- When thực hiện preflight.
- Then `app_runtime`/`app_worker`, transaction bao ngoài, owner thiếu BYPASSRLS/quyền sở hữu/CREATE/SET ROLE cần thiết bị từ chối trước DDL. Owner không superuser đủ quyền có thể áp từ schema rỗng và tạo `pgboss` thuộc `app_worker`. CLI không tự cấp quyền production hoặc sửa danh tính runtime.

### S-006 — Trạng thái, áp lại và down có ý định rõ
- Given CLI có mã nguồn chứa registry migration và schema đã áp.
- When gọi `status`, `up` nhiều lần hoặc `down --to <bản đã áp> --confirm-down`.
- Then trạng thái chỉ báo tên/bản đã áp, up khi đủ không chạy lại; down chỉ nhận đích đã áp đứng trước bản hiện tại. Thiếu xác nhận, đích lạ, đích chưa áp hoặc bản hiện tại bị từ chối; down thành công có thể up lại. Không có down mặc định hoặc down-all trong CLI.

### S-007 — Mã thoát và chẩn đoán an toàn
- Given tham số/cấu hình sai, tài khoản thiếu quyền, lỗi kết nối hoặc lệnh thành công.
- When CLI kết thúc.
- Then thành công trả exit 0 với JSON `ok: true`; thất bại trả exit 1 với JSON `ok: false` và code an toàn, không URL/mật khẩu/thông điệp DB thô. Thất bại không được ghi thành đã promote hoặc tự cấp quyền rồi chạy lại.

## 3. Đối chiếu test

| Scenario | Bằng chứng tự động |
|---|---|
| S-001 | `packages/app/src/config/schema.test.ts`, `instrumentation.test.ts`, `secure-defaults.test.ts` |
| S-002 | `packages/app/src/config/runtime-env.test.ts`, `client-bundle.test.ts`, `secure-defaults-bundle.test.ts` (bundle cần build trước) |
| S-003 | `packages/app/src/config/runtime-env.test.ts`, `packages/app/src/auth/password-hash.db.test.ts` (telemetry giữ rào cũ) |
| S-004 | `packages/db/src/migration-cli.test.ts` |
| S-005 | `packages/app/src/config/migration-cli.db.test.ts` (PostgreSQL thật, role riêng và catalog trước/sau) |
| S-006 | `packages/db/src/migration-cli.test.ts`, `packages/app/src/config/migration-cli.db.test.ts` |
| S-007 | `packages/db/src/migration-cli.test.ts`, `packages/app/src/config/migration-cli.db.test.ts` |

## 4. Giới hạn và vận hành

Mẫu `.env*` đang được guard bảo vệ; khai báo tên biến ở runbook không thay quyền sửa mẫu hay đọc secret thật. Build không yêu cầu cấu hình runtime: không tick FE-BUILD-005 chỉ vì schema build đã tách. Kiểm cục bộ không chứng minh role, TLS, quyền deploy hoặc diễn tập trên production. [Runbook migration](../ops/runbooks/database-migrations.md) quy định backup, ownership, rollback ứng dụng và guard 0074/0076; không xoá claim/audit để down. Production purge tiếp tục giữ tắt theo D-125.
