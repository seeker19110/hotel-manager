---
title: Runbook — migration CSDL bằng vai trò riêng
kind: runbook
updated: 2026-11-01
last_drilled: local-only — PostgreSQL 17 tạm, dữ liệu giả; chưa diễn tập staging/production
owner: (chưa gán — Tech Lead)
---

# Migration CSDL

CLI của `@hm/db` dùng một kết nối migration riêng, kiểm quyền trước khi tạo bảng khoá/metadata hoặc chạy DDL. Bằng chứng cục bộ gồm khởi tạo schema bằng owner không phải superuser, từ chối runtime/worker, xem trạng thái và down/up. Đây chưa phải diễn tập trên bản sao production, chưa chứng minh thời gian khoá bảng hay đường khôi phục dữ liệu thật.

## Điều kiện trước

- Dùng mã nguồn/lockfile của phiên bản đã qua CI và đọc migration mới. Giữ ứng dụng tương thích N−1; ưu tiên rollback ứng dụng rồi giữ schema mới.
- Các role `app_runtime`, `app_worker` đã được người vận hành tạo theo [`bootstrap-roles.sql`](../../../packages/db/sql/bootstrap-roles.sql). CLI không tự tạo role hoặc cấp quyền production.
- Owner chạy migration có `SUPERUSER` **hoặc** `BYPASSRLS`; có quyền `CREATE` trên CSDL và schema `public`, `app`, `auth` nếu chúng tồn tại; có quyền chủ sở hữu hữu hiệu trên bảng/hàm dự án hiện có. Hàm `SECURITY DEFINER` do owner này tạo cần vượt `FORCE ROW LEVEL SECURITY`; không cấp `BYPASSRLS` cho runtime/worker.
- Owner không phải superuser cần quyền `SET ROLE app_worker`: migration 0047 tạo schema `pgboss AUTHORIZATION app_worker`. Việc cấp quyền là thao tác riêng của người quản trị, không có trong CLI. `current_user` là `app_runtime` hoặc `app_worker` luôn bị từ chối, kể cả URL có quyền khác ngoài dự kiến.
- Với dữ liệu thật: có backup đã kiểm, nhãn backup và restore point; đã xem giao dịch dài/khả năng khoá bảng theo [deploy/rollback](deploy-rollback.md). Chưa có quyền thao tác production thì chỉ dùng cluster tạm/dữ liệu giả.

## Nạp cấu hình

Kho bí mật của môi trường nạp `MIGRATION_DATABASE_URL` vào tiến trình; production đặt `NODE_ENV=production`. Không ghi giá trị URL vào lệnh, log, lịch sử shell, manifest phát hành hoặc git. Không dùng `DATABASE_URL`/`WORKER_DATABASE_URL` thay thế: CLI không có fallback sang hai biến này. `.env.example` chưa có biến mới vì guard hiện bảo vệ `.env*`; tài liệu này chỉ ghi tên và hợp đồng, không sửa file đó.

URL phải dùng `postgres://` hoặc `postgresql://`, có tên CSDL và máy chủ rõ ràng, hoặc socket Unix tuyệt đối. Production tới máy khác cần đúng một `sslmode=verify-full`; hostname trong chứng chỉ phải khớp và CA phải được tiến trình tin cậy. Loopback/socket cục bộ được miễn TLS. `hostaddr`, `host` lặp hoặc `host` ghi đè máy chủ trong URL bị từ chối để không khác cách driver chọn đích.

## Xem trạng thái và áp migration

Chạy từ gốc repo, sau khi môi trường đã nạp cấu hình:

```bash
pnpm --filter @hm/db migrate status
pnpm --filter @hm/db migrate up
pnpm --filter @hm/db migrate status
```

`status` chỉ báo tên migration và trạng thái đã áp. `up` áp các bản còn thiếu tới bản cuối trong mã nguồn hiện tại; chạy lại khi đã đủ trả danh sách rỗng. Không chạy CLI trong transaction bao ngoài. Khi một lệnh trả exit khác 0 thì dừng promote, đối chiếu backup và quyền/schema trước khi thử lại.

## Lùi schema có chủ đích

Ưu tiên ứng dụng bản trước chạy với schema mới. Nếu cần down, đọc toàn bộ migration nằm **sau** đích; đích là bản sẽ được giữ lại, không phải bản cần gỡ. Ví dụ trên schema 0078, lệnh sau chỉ gỡ 0078 và giữ 0077:

```bash
pnpm --filter @hm/db migrate down --to 0077_persons_bootstrap_scope --confirm-down
pnpm --filter @hm/db migrate status
```

Đích phải là migration có trong mã nguồn, đã áp và đứng trước bản đang chạy. Không có lệnh down mặc định, không có đích xoá hết schema; thiếu `--confirm-down` hoặc dùng đích không hợp lệ đều thất bại. Đích cách nhiều phiên bản sẽ chạy down nhiều migration, nên phải xem và phê duyệt cả khoảng đó. Quyền `SET ROLE app_worker` không thay quyền chủ sở hữu hữu hiệu khi một down cần sửa/xoá schema do role khác sở hữu; lỗi quyền vẫn phải được người vận hành xử lý.

Hai guard dữ liệu bắt buộc:

- **0074:** còn `organizations.purge_started_at` thì down bị chặn. Khôi phục kho file và hoàn tất purge theo quy trình đã duyệt; không xoá cờ để mở lại cửa huỷ. Khi chưa được phép hoàn tất purge production, giữ schema và rollback ứng dụng tương thích.
- **0076:** còn bất kỳ `dsar_audit_events` thì down bị chặn với `DSAR_AUDIT_EVIDENCE_EXISTS`. Giữ schema/bằng chứng và rollback ứng dụng; không xoá audit để vượt guard.

Down có thể xoá dữ liệu ở bảng/cột mới, và không khôi phục object đã xoá. Không dùng `migrateDownAll` ngoài test. Nếu cần PITR, theo [restore](restore.md) với người duyệt và đánh giá phần dữ liệu ghi sau restore point.

## Lỗi và xác minh

CLI xuất JSON an toàn, không in URL, mật khẩu hoặc thông điệp DB thô. `ok: false` đi cùng exit 1; trường `code` phân biệt cấu hình, ý định down, quyền và lỗi migration/kết nối. `MIGRATION_DATABASE_URL_REQUIRED` không được xử lý bằng cách dùng URL runtime. `MIGRATION_OWNER_WITH_BYPASSRLS_REQUIRED` yêu cầu người vận hành kiểm danh tính, ownership, CREATE và SET ROLE; không tự nâng quyền cho ứng dụng. `MIGRATION_FAILED` cần đối chiếu migration/guard và nhật ký CSDL theo quyền vận hành, không thử down thêm khi chưa hiểu nguyên nhân.

Sau thành công: `status` khớp phiên bản mong muốn; kiểm `/api/ready`, smoke phiên bản và worker; ghi commit, mốc UTC, tên migration, backup/restore point và kết quả an toàn vào biên bản deploy. Không dùng báo cáo test cục bộ làm bằng chứng đã deploy.

Kiểm lại bằng `pnpm vitest run --project unit migration-cli` và `pnpm vitest run --project db migration-cli`; hợp đồng config ở [SPEC-runtime-configuration](../../specs/SPEC-runtime-configuration.md).
