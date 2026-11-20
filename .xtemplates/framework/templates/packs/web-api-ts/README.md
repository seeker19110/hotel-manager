---
title: Gói web-api-ts — API nhiều tenant trên Node 24 + Postgres
kind: index
updated: 2026-11-20
---

# Gói `web-api-ts`

> Stack lấy từ dự án đích hotel-manager (`www-donghanhcungban-org/hotel-manager@30492c9`, đọc 2026-11-05): Node 24, pnpm,
> TypeScript, `pg` + `kysely`, `vitest`, `biome` và PostgreSQL. Giao diện ghi chú cho phép đăng nhập, ghi và xem lại theo tenant.
> Hạn hỗ trợ nằm ở `support_until` trong `pack.json`.

Phiên bản pnpm và các gói npm nằm trong `starter/package.json` ở cây nguồn của gói. Sau khi cài starter, xem
`package.json` ở gốc dự án. Image PostgreSQL của CI nghiệm thu được ghim theo digest trong
`managed/.github/workflows/pack-acceptance.yml` ở cây nguồn và `.github/workflows/pack-acceptance.yml` khi dự án nhận workflow.

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

Khi chạy cục bộ, đặt `DATABASE_URL=postgres://…/postgres` rồi chạy `pnpm test`. Tài khoản cần quyền
`CREATE DATABASE` vì mỗi file test dùng một cơ sở dữ liệu riêng. Trên GitHub Actions, dự án mới tự cài Node và pnpm
theo phiên bản đã ghim, cài phụ thuộc theo lockfile và dùng PostgreSQL 17. Nếu dự án chưa cấp `DATABASE_URL`,
bộ test tạo container tạm trên loopback rồi xóa khi kết thúc, kể cả khi test đỏ.

## Sửa và thử trong lúc viết mã

Từ repo sản phẩm, đặt `DATABASE_URL` tới PostgreSQL dành cho phát triển. Chạy `pnpm install --frozen-lockfile` lần đầu và `pnpm migrate up` khi có migration mới. Mở hai terminal trong cùng môi trường:

- `pnpm dev` phục vụ cây đang sửa ở <http://127.0.0.1:3000/> (đổi bằng `PORT`). Lưu TypeScript thì Node khởi động lại. Lưu HTML, CSS hoặc JavaScript của giao diện ghi chú rồi tải lại trang để thấy thay đổi.
- `pnpm test:watch` chạy bộ test lần đầu rồi chạy lại các test chịu ảnh hưởng theo đồ thị import. Dùng `pnpm test:watch test/slice.test.ts` để tập trung vào một file. Khi đổi migration hoặc tài sản đọc từ đĩa, chạy `pnpm test` trước khi trình.

Dùng tài khoản ứng dụng đã tạo trong DB phát triển để thử đăng nhập. Nếu DB mới, tạo riêng database `xt_preview` trên localhost, đặt `DATABASE_URL` tới đó và chạy migration. Đặt hai mật khẩu demo khác nhau (tối thiểu 20 ký tự) qua `XT_DEMO_OWNER_PASSWORD` và `XT_DEMO_GUEST_PASSWORD`, rồi chạy `XT_PREVIEW_BUILD=1 node ops/dev/seed.mjs`. Đăng nhập bằng `owner@example.test`. Khi trình MVP, dùng bản dev đã đóng gói và nghiệm thu dưới đây.

## Chạy thử bản dev

Trong repo sản phẩm mới, dùng Node 24, CPython 3.15 và Docker Engine cục bộ với Compose v2. Lần đầu dựng ảnh cần mạng. Mỗi dự án có hai tài khoản demo và một volume PostgreSQL riêng. Cổng 4317 trên loopback cần trống.

```bash
node scripts/build.ts
python3 .xtemplates/scripts/xt.py deploy run --env dev --json
node scripts/dev-preview.mjs credentials
```

Mở <http://127.0.0.1:4317/> trên máy chạy Docker. Lấy tài khoản `owner` từ đầu ra lệnh cuối để đăng nhập, tạo ghi chú rồi tải lại trang. Chỉ xem mật khẩu demo ở terminal riêng. Lệnh triển khai thử đăng nhập, ghi/đọc lại ghi chú, kiểm tenant thứ hai nhận 404 và so digest phục vụ với artifact. Bằng chứng được ghi vào `docs/ops/DEPLOYS.json`. Sau khi đổi mã, chạy lại hai lệnh đầu để cập nhật bản dùng thử.

`node scripts/dev-preview.mjs verify` dựng lại artifact trong thư mục tạm, so với receipt và `/healthz`, rồi kiểm trang HTML. `python3 .xtemplates/scripts/xt.py deploy rollback --env dev --json` nạp ảnh ứng dụng đã lưu của lần triển khai trước. Giữ migration tương thích ngược với ảnh cũ vì rollback ứng dụng dùng lại volume dữ liệu. `node scripts/dev-preview.mjs stop` dừng dịch vụ và giữ volume. Các bản ảnh dùng để quay lui được lưu cục bộ trong thư mục Git, cùng thông tin truy cập dev.

Để dựng và nghiệm thu bằng Chromium từ gốc repo sản phẩm, chạy `bash tests_e2e/preview.sh`. Kết quả ở `dist/preview-browser.json` sau khi một phiên mới đọc lại ghi chú đã tạo. Workflow `dev-preview` của starter chạy cùng lệnh trên PR và khi chọn **Run workflow**. Mã bài kiểm thuộc dự án. Xem hướng dẫn đổi đường dẫn bằng chứng trong `tests_e2e/README.md` của repo sản phẩm.

## Quét phụ thuộc

Workflow `pack-acceptance` quét `pnpm-lock.yaml` bằng `pnpm audit --audit-level moderate` rồi kiểm ngoại lệ bằng
`pnpm audit:exceptions` trước khi cài phụ thuộc.
Cảnh báo từ mức vừa hoặc lỗi truy cập registry làm job đỏ. Chạy cùng lệnh tại gốc dự án để kiểm tra cục bộ.

Để bật PR cập nhật tự động, kiểm tra phiên bản pnpm của dự án với bảng hỗ trợ của Dependabot. Nếu được hỗ trợ,
thêm một mục `package-ecosystem: npm`, `directory: /` và lịch vào `updates` trong `.github/dependabot.yml`.
Quét registry của workflow chạy độc lập với cấu hình Dependabot.

Ngoại lệ hẹp theo từng GHSA nằm ở `starter/pnpm-workspace.yaml` (`auditConfig.ignoreGhsas`) và phải có dòng cùng id trong
`starter/audit-exceptions.json` (`cve`, lý do, người duyệt, hạn). Hết hạn thì xét lại hoặc bỏ; không hạ `--audit-level`.
`pnpm audit:exceptions` (`scripts/check-audit-exceptions.ts`) đỏ khi ngoại lệ hết hạn, thiếu khoá, hay `ignoreGhsas`/
`ignoreCves` lệch với file ngoại lệ; workflow `pack-acceptance` chạy bước này ngay sau `pnpm audit`, trước khi cài phụ thuộc.
[Xem phiên bản được hỗ trợ](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories).

## Ca sai cố ý (`mutants.json`)

`tenant-leak` (policy RLS `true`) · `broken-down` (`down` không xoá bảng) · `contract-runtime` (phản hồi thiếu trường bắt buộc) ·
`contract-static` (contract bỏ trường bắt buộc) · `contract-request-type` (contract đổi kiểu trường request) — mỗi ca
phải làm đỏ đúng test ghi ở `expect_fail`.

## Giới hạn đã biết

- Lệnh `up` trong `src/migrate.ts` của starter dùng Kysely để áp dụng mọi migration còn thiếu trong cùng một giao dịch
  PostgreSQL (DB-MIG-006). Cổng từ chối `CREATE INDEX CONCURRENTLY` trong migration và index thường trên bảng có sẵn,
  kể cả `IF NOT EXISTS`. Ngoại lệ đã phát hành là `0005_sessions_expiry` với hai index trên `sessions` (AUD-DATA-011).
  Gói chưa có luồng dựng index ngoài giao dịch. Khi bổ sung luồng đó, kiểm định nghĩa và trạng thái hợp lệ của index trước
  khi tiếp tục migration (AUD-DATA-013).

- Kết nối ứng dụng dùng một vai trò có quyền `SET ROLE app_rw`; triển khai thật: vai trò đăng nhập riêng chỉ là thành viên
  `app_rw` + vai trò migration riêng (sở hữu bảng) — chưa có trong gói.
- Contract tĩnh: ở repo khung, CI `pack-web-api.yml` (job `contract-baseline`, `tests/pack_baseline.py`) chỉ cho
  `baseline.json` khác nhánh gốc khi PR tăng `VERSION` (AUD-SEC-502); ở dự án đích (starter đã là của dự án) baseline vẫn
  sửa được cùng PR — review xem diff `contract/`. `job_effects.job_id` có FK không kèm tenant (RLS vẫn lọc theo tenant).
- Contract so bằng tập con của OpenAPI (giới hạn ghi ở đầu `contract.test.ts`): không bắt đổi thuộc tính tuỳ chọn,
  `enum`, ràng buộc — cần bộ so chuyên dụng ở CI của dự án.
- Phiên đăng nhập không có thu hồi/giới hạn tần suất theo người dùng/IP (chỉ giới hạn số scrypt đồng thời của tiến trình);
  `purgeExpiredSessions` chưa được lên lịch sẵn; không có MFA. Bản Compose chỉ dành cho dev trên loopback. Staging và production cần đích triển khai riêng.
