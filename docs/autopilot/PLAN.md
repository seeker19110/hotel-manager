# Hotel Manager · Đợt 25: hoàn tất mã và công cụ vận hành còn thiếu

> Phiên chính tự duyệt 2026-11-01, D-139. Đã fetch: `main` vẫn `3e41782`; PR #140 ở `81d1c3b` chưa merge. Nhánh con giữ mã đợt 24, checkout gốc và dữ liệu người dùng.

## Tóm tắt cổng duyệt
- Xử lý phần mã cụ thể trong 75 MUST còn mở; pháp lý, thiết bị, tài khoản và bằng chứng production tiếp tục mở.
- Vá advisory có bản sửa, kiểm build PWA; không nới cổng hoặc ngoại lệ để làm xanh.
- DSAR có audit tài khoản kể cả không thuộc tổ chức: append-only, RLS, dữ liệu tối thiểu, cùng transaction; tải ghi việc cấp URL thành công.
- Thu hẹp bootstrap persons sau test tái hiện; migration mới, không sửa bản đã áp.
- Dọn dữ liệu vận hành hết hiệu lực theo lô; không tự xoá inbox/ngân hàng/chứng từ hoặc chốt hạn pháp lý.
- Gom cấu hình và thêm CLI migration riêng có kiểm quyền; không đọc secret thật.
- Công cụ backup/promote/smoke/rollback kiểm được cục bộ; dựng/chạy image bằng dữ liệu giả.
- Mỗi lát một PR; nhánh phụ thuộc dùng base PR trước. Auth/dữ liệu do người merge, production purge vẫn tắt.
- Tối đa ba subagent, không lồng; phiên chính giữ registry migration, snapshot, tài liệu và GitHub.

## Ngân sách
- Một phiên, hạn 24 giờ; timeout Gate 1800 giây; không đặt ngân sách token. Vòng đợt 24 đã hết hạn; vòng mới tạo bằng `loop init --force`.

## Ủy quyền production
- grant: payments | mode=sandbox | max_per_txn=0 | refund=false
- grant: data_delete | hard_delete=false | max_rows=100
- grant: data_export | pii=false | max_rows=10000
- grant: outbound_messages | live=false | max_per_hour=0
- grant: auth_crypto | custom_crypto=false
- grant: secrets | read_values=false

## Task
- [x] `T-2602` So sánh hình dạng env theo tên key và dịch vụ, không nhận giá trị secret; kiểm đầu vào và chênh lệch bằng dữ liệu giả (files: scripts/compare-env-keys*, docs/ops/runbooks/) — Gate: `pnpm vitest run --project unit scripts/compare-env-keys.test.mjs && pnpm typecheck`
- [x] `T-2601` Bổ sung provenance IP/UA tối thiểu cho sự kiện DSAR có nguồn HTTP, giữ RLS và append-only; worker không giả định nguồn (exec: deep; files: packages/app/src/privacy/, packages/app/src/http/data-requests.ts, packages/db/src/migrations/) — Gate: `pnpm vitest run --project db dsar && pnpm typecheck`
- [x] `T-2509` Sửa CI cho PR xếp chồng: mọi workflow PR chạy trên mọi base, giữ events/permissions/jobs và guard không filter; ổn định test cửa sổ hạn mức và đóng backend worker (files: .github/workflows/, scripts/ci-gates.test.mjs, scripts/pr-policy-ci.test.mjs, scripts/test-quality.test.mjs, scripts/api-ops.test.mjs, packages/app/src/http/*rate-limit.db.test.ts, packages/app/src/testing/rate-limit-window.ts, apps/worker/src/worker-runtime.db.test.ts) — Gate: `pnpm vitest run --project unit ci-gates api-ops pr-policy-ci test-quality && pnpm vitest run --project db files-rate-limit webhook-rate-limit worker-runtime && python3 .xtemplates/scripts/xt.py ci-check .github/workflows`
- [x] `T-2501` Vá dependency theo advisory hiện tại, kiểm build PWA và ngoại lệ image (files: package.json, pnpm-lock.yaml, security/, deploy/) — Gate: `pnpm audit --prod && pnpm licenses:check && pnpm build && node scripts/grype-ignore-check.mjs`
- [x] `T-2502` Audit DSAR tài khoản: tạo/trạng thái/cấp URL, RLS/append-only, retry/rollback và migration 0076 (exec: deep; files: packages/app/src/privacy/dsar.ts, packages/app/src/privacy/dsar-audit.db.test.ts, packages/db/src/migrations/0076_dsar_audit_events.ts) — Gate: `pnpm vitest run --project db dsar && pnpm typecheck`
- [x] `T-2503` Đóng bypass bootstrap UPDATE persons, giữ bootstrap hợp lệ, migration 0077 (exec: deep; files: packages/db/src/migrations/0077_persons_bootstrap_scope.ts, packages/app/src/access/persons-bootstrap.db.test.ts) — Gate: `pnpm vitest run --project db persons-bootstrap organizations invitations`
- [x] `T-2504` Gom config và CLI migration dùng quyền owner riêng, kiểm fail closed trước migration (sau: T-2501; exec: deep; files: packages/app/src/config/, packages/db/src/, apps/web/, apps/worker/, scripts/) — Gate: `pnpm vitest run --project unit config env migration-cli && pnpm vitest run --project db migration-cli && pnpm typecheck`
- [x] `T-2505` Retention vận hành hết hiệu lực: lời mời/lockout/bucket auth, theo lô, giữ cửa sổ còn dùng, down/up 0078 (exec: deep; files: packages/app/src/retention/, packages/db/src/migrations/0078_operational_retention.ts) — Gate: `pnpm vitest run --project db retention && pnpm typecheck`
- [x] `T-2506` Lịch backup/báo lỗi/metric và manifest digest/smoke/rollback, kiểm local (files: deploy/, scripts/ops/, scripts/ops.test.mjs, docs/ops/runbooks/) — Gate: `pnpm vitest run --project unit scripts/ops.test.mjs observability && pnpm typecheck && bash scripts/ops-tools.sh run promtool test rules deploy/prometheus/host-operations.test.yml`
- [x] `T-2507` Dựng/chạy image web/worker với dữ liệu giả; startup/health/shutdown và bằng chứng digest (sau: T-2501, T-2504, T-2506; files: deploy/, docs/ops/evidence/, scripts/) — Gate: `node scripts/ops/local-images-check.mjs`
- [x] `T-2508` Đồng bộ schema/spec/audit/progress, phân loại MUST và xác minh đầy đủ (sau: T-2501, T-2502, T-2503, T-2504, T-2505, T-2506, T-2507; files: BLUEPRINT.md, docs/, PROGRESS.md, packages/db/src/migrations/index.ts, packages/testkit/src/) — Gate: `python3 scripts/check-blueprint-evidence.py BLUEPRINT.md && python3 .xtemplates/scripts/xt.py progress-check && python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md && pnpm vitest run --project db schema-drift schema-guards`

## Điểm dừng
- PR #140 và PR ngoại lệ cứng mới do người merge theo AGENTS §7. Không triển khai dữ liệu thật/bật purge, không ghi đạt diễn tập/pháp lý/thiết bị chưa xảy ra.
