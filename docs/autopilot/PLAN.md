# Hotel Manager · Đợt 24: khép lỗi sau đợt 23

> Phiên chính tự duyệt 2026-10-26 theo AGENTS §5. Tiếp tục từ `origin/main` `3e41782` (#137–#139 đã merge), giữ nguyên audit chưa commit ở checkout cũ.

## Tóm tắt cổng duyệt
- Mục tiêu: sửa lỗi có đường tái hiện ở MFA, thu hồi quyền tổ chức và hai cuộc đua có thể làm mất dữ liệu khi retention/purge chạy.
- Giữ stack, không thêm phụ thuộc; PostgreSQL 17 cục bộ với dữ liệu giả; migration mới có down, không sửa bản đã áp.
- Claim purge phải bền qua lỗi kho file: khi bắt đầu xoá object thì không còn huỷ yêu cầu; lỗi giữa chừng được thử lại.
- Khách ở kèm cần khoá người như FK trước khi công bố lượt lưu trú để worker không ẩn danh hồ sơ đang dùng.
- Tổ chức chỉ cho active, hoặc pending_deletion khi đường xuất/huỷ cho phép; suspended không được tiếp tục bằng cookie cũ.
- Rà IP qua Caddy theo nguồn chính thức; chỉ kết luận sau kiểm mã dependency và cấu hình triển khai.
- Mỗi lỗi có test tái hiện trước sửa và cổng hành vi sau sửa; không nới test/coverage/cấu hình cổng.
- Rủi ro auth/dữ liệu: PR cần người merge theo AGENTS §7; hoàn tất mã, test và PR trước bàn giao.
- Giới hạn điều phối: tối đa 3 subagent, không lồng; migration index/snapshot/tài liệu do phiên chính cập nhật tuần tự.

## Ngân sách
- Một phiên (`--single-session`), hạn 24 giờ; timeout cổng 1800 giây; không đặt ngân sách token.

## Ủy quyền production
- grant: payments | mode=sandbox | max_per_txn=0 | refund=false
- grant: data_delete | hard_delete=false | max_rows=100
- grant: data_export | pii=false | max_rows=10000
- grant: outbound_messages | live=false | max_per_hour=0
- grant: auth_crypto | custom_crypto=false
- grant: secrets | read_values=false

## Task
- [x] `T-2401` Sửa AUD-A11Y-001: MFA 429 báo đúng giới hạn tần suất, giữ phase và cho thử lại; cả password/TOTP có regression (files: apps/web/app/bao-mat/mfa-enroll.tsx, apps/web/components/auth/mfa-enroll.test.tsx, apps/web/messages/vi.json) — Gate: `pnpm vitest run --project unit mfa-enroll && pnpm --filter @hm/web typecheck`
- [x] `T-2402` Từ chối cookie tổ chức suspended, cả đường allowPendingDeletion; giữ 423 pending và quyền active (exec: deep; files: packages/app/src/access/actor.ts, packages/app/src/access/auth.db.test.ts) — Gate: `pnpm vitest run --project db packages/app/src/access/auth.db.test.ts`
- [x] `T-2403` Claim purge bền trước xoá object; huỷ trước claim thắng thì không xoá; lỗi object không mở lại cửa huỷ, retry được; migration 0074 (exec: deep; files: packages/app/src/tenancy/org-deletion.ts, packages/app/src/tenancy/org-deletion.db.test.ts, packages/app/src/exports/exports.ts, packages/app/src/exports/exports.db.test.ts, packages/app/src/files/, packages/db/src/migrations/0074_org_purge_claim.ts, apps/web/components/tenancy/org-deletion.tsx, apps/web/components/tenancy/org-deletion.test.tsx, apps/web/messages/vi.json) — Gate: `pnpm vitest run --project db packages/app/src/tenancy packages/app/src/exports && pnpm vitest run --project unit org-deletion`
- [x] `T-2404` Khoá người ở kèm trước ghi stays, chặn race retention; kiểm tenant/UUID không tồn tại và down/up migration 0075 (exec: deep; files: packages/app/src/retention/, packages/app/src/identity/identity.ts, packages/db/src/migrations/0075_additional_guest_retention_lock.ts) — Gate: `pnpm vitest run --project db packages/app/src/retention`
- [x] `T-2405` Kiểm ranh giới IP Caddy/Better Auth và sửa Retry-After vô lý của database rate limiter, có regression (files: packages/app/src/http/retry-after.ts, packages/app/src/http/retry-after.test.ts, apps/web/app/api/auth/[...all]/route.ts, docs/ops/runbooks/auth-proxy.md) — Gate: `pnpm vitest run --project unit retry-after && pnpm typecheck`
- [x] `T-2406` Đồng bộ migration index/snapshot, audit/progress/blueprint gaps; ghi bằng chứng kiểm cuối và việc người merge/hạ tầng (sau: T-2401, T-2402, T-2403, T-2404, T-2405; files: BLUEPRINT.md, docs/specs/SPEC-lifecycle-race-hardening.md, packages/testkit/src/migration-0073.db.test.ts, packages/db/src/migrations/index.ts, packages/testkit/src/schema-guards.baseline.json, docs/design/ERD.md, PROGRESS.md, docs/ops/AUDIT-STATUS.md, docs/autopilot/BLUEPRINT-GAPS.md, docs/autopilot/HUONG-DAN-VIEC-CUA-NGUOI.md) — Gate: `python3 scripts/check-blueprint-evidence.py BLUEPRINT.md && python3 .xtemplates/scripts/xt.py progress-check && python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md && pnpm vitest run --project db schema-drift schema-guards`

## Điểm dừng
- Merge PR auth/dữ liệu do người; production purge giữ tắt như D-125. Các MUST cần hạ tầng/thiết bị/pháp lý tiếp tục theo hướng dẫn hiện có, không khai đạt.
