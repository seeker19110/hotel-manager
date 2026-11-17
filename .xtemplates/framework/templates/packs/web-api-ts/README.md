---
title: Gói web-api-ts — API nhiều tenant trên Node 24 + Postgres
kind: index
updated: 2026-11-06
---

# Gói `web-api-ts`

> Stack lấy từ dự án đích hotel-manager (`seeker19110/hotel-manager@30492c9`, đọc 2026-11-05): Node 24, pnpm 12.16.1,
> TypeScript 7.0.2, `pg` 8.23.1 + `kysely` 0.29.6, `vitest` 5.0.3, `biome` 2.5.15, Postgres 17.11 (ghim digest). Không có
> UI (Next.js của hotel-manager không vào gói đầu — D-359). Hạn hỗ trợ: `pack.json` → `support_until`.

## Có gì (starter)

| Phần | File | Bảo đảm (test) |
|---|---|---|
| Cô lập tenant | `src/db.ts` `withTenant`, migration `0001`–`0003` | vai trò `app_rw` + `SET LOCAL app.tenant_id`; RLS `ENABLE` + `FORCE`; thiếu ngữ cảnh → lỗi (`slice.test.ts`) |
| Đăng nhập | `src/auth.ts` | scrypt N=2^17 r=8 p=1 (tham số ghi trong hash — tăng cost không phá hash cũ), token 32 byte chỉ lưu sha256, sai mật khẩu và email không tồn tại trả giống nhau; tối đa `LOGIN_CONCURRENCY` (mặc định 2) lần chạy scrypt cùng lúc, đầy → 503 `busy` + `retry-after`; phiên hết hạn của user dọn khi đăng nhập, `purgeExpiredSessions` dọn theo lịch (`slice.test.ts`) |
| API | `src/server.ts`, `contract/openapi.json` | phản hồi khớp contract; không đổi không tương thích so với `contract/baseline.json` (`contract.test.ts`); mọi phản hồi có `x-content-type-options: nosniff` |
| Kết nối DB | `src/db.ts` `createDb` | chờ kết nối (mở mới hoặc pool cạn) tối đa `PG_CONNECT_TIMEOUT_MS` (5 s), `statement_timeout` của phiên `PG_STATEMENT_TIMEOUT_MS` (15 s) — DB treo thì request lỗi nhanh (`db.test.ts`) |
| Migration | `src/migrate.ts` (`up`/`down`/`reset`) | lùi hết rồi tiến lại; lùi từng bước (`slice.test.ts`) |
| Sao lưu/khôi phục | `pg_dump`/`pg_restore` (hoặc `PG_TOOLS_CONTAINER`) | dữ liệu, đăng nhập, RLS còn đúng sau khôi phục (`restore.test.ts`) |
| Worker | `src/worker.ts` | khoá ý định chống trùng, lease hết hạn → lấy lại, mỗi lần claim một `lease_token` (lần chạy cũ — kể cả cùng workerId — không hoàn tất/reset được lần chạy mới), crash giữa chừng → bản ghi `job_effects` đúng một lần (tác dụng phụ ra ngoài DB là at-least-once — handler phải lũy đẳng phía nhận), chết ở lần thử cuối → `failed` (không kẹt `running`), `reconcile` (`worker.test.ts`) |
| Artifact | `scripts/build.ts` → `dist/app.tgz` + `.sha256` | cùng commit → cùng digest; `release_artifacts` của `xt.yaml` → hàng `artifacts` của `release-check` |

Chạy cục bộ: `DATABASE_URL=postgres://…/postgres pnpm test` (vai trò có quyền `CREATE DATABASE`; mỗi file test tạo cơ sở
riêng). Không có `DATABASE_URL` → test đỏ, không bỏ qua.

## Ca sai cố ý (`mutants.json`)

`tenant-leak` (policy RLS `true`) · `broken-down` (`down` không xoá bảng) · `contract-runtime` (phản hồi thiếu trường bắt buộc) ·
`contract-static` (contract bỏ trường bắt buộc) · `contract-request-type` (contract đổi kiểu trường request) — mỗi ca
phải làm đỏ đúng test ghi ở `expect_fail`.

## Giới hạn đã biết

- Kết nối ứng dụng dùng một vai trò có quyền `SET ROLE app_rw`; triển khai thật: vai trò đăng nhập riêng chỉ là thành viên
  `app_rw` + vai trò migration riêng (sở hữu bảng) — chưa có trong gói.
- Contract tĩnh: ở repo khung, CI `pack-web-api.yml` (job `contract-baseline`, `tests/pack_baseline.py`) chỉ cho
  `baseline.json` khác nhánh gốc khi PR tăng `VERSION` (AUD-SEC-502); ở dự án đích (starter đã là của dự án) baseline vẫn
  sửa được cùng PR — review xem diff `contract/`. `job_effects.job_id` có FK không kèm tenant (RLS vẫn lọc theo tenant).
- Contract so bằng tập con của OpenAPI (giới hạn ghi ở đầu `contract.test.ts`): không bắt đổi thuộc tính tuỳ chọn,
  `enum`, ràng buộc — cần bộ so chuyên dụng ở CI của dự án.
- Phiên đăng nhập không có thu hồi/giới hạn tần suất theo người dùng/IP (chỉ giới hạn số scrypt đồng thời của tiến trình);
  `purgeExpiredSessions` chưa được lên lịch sẵn; không có MFA; không UI; không staging/deploy thật (promote = digest +
  chữ ký GO-NO-GO §5 của khung).
