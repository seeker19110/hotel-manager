# docs/autopilot/PLAN.md — Hotel Manager · Đợt 23: làm hết phần máy làm được của 89 MUST còn mở

> **Cổng duyệt: phiên chính tự duyệt 2026-10-25** (AGENTS §5). Chủ dự án yêu cầu "làm hết" (2026-10-25) ⇒ mọi phần trong repo của
> 89 MUST mở (khảo sát hiện trạng 2026-10-25); phần chỉ người làm được (tài khoản/tiền/VPS/ký pháp lý/diễn tập/thiết bị thật) → `loop defer`
> kèm cách làm ở `docs/autopilot/HUONG-DAN-VIEC-CUA-NGUOI.md`.

## Tóm tắt cổng duyệt (≤ 30 dòng)
- **Mục tiêu:** tick mọi MUST mà Kiểm thoả được bằng mã/tài liệu/CI trong repo; với MUST cần người, làm sẵn toàn bộ phần repo để người chỉ còn bước của người.
- **Lát A (L3) — repo & phát hành:** LICENSE Proprietary + THIRD_PARTY_NOTICES (D-111), SECURITY.md/security.txt/CONTRIBUTING/CoC/SUPPORT (D-112), annotated tag + đồng bộ phiên bản (D-113), CMP-LIC-004 (D-114).
- **Lát B (L3) — hồ sơ tuân thủ có rào CI:** data map `legal_basis` lint, CHANGELOG `docs/privacy/` + nhắc quá hạn, `vendors.yaml` + chặn SDK mới, sổ sự cố + mẫu, runbook vi phạm dữ liệu (bảng vùng, Mẫu 08), DPA + sub-processor, RUNBOOK `last_drilled` lint, `renewals.md` + nhắc hạn, danh sách luật (researcher, nguồn sống) + DPIA nháp.
- **Lát C (người merge — dữ liệu) — retention + analytics:** job dọn bảng còn thiếu + ẩn danh `persons`/`identity_documents` theo hạn; `track()` tự host có schema, cấm PII, cần đồng ý, hạn lưu, ngắt liên kết khi xoá tài khoản.
- **Lát D (người merge — dữ liệu/auth) — quyền chủ thể:** bản ghi đồng ý append-only theo mục đích + rút; DSAR (truy cập/xuất, xoá có xác thực lại, hạn chế), hạn theo vùng + metric quá hạn; xoá tài khoản lan mọi kho; vòng đời xoá tổ chức (xoá mềm → xuất → purge → chứng nhận); E2E `rights-access`/`rights-delete`/`rights-withdraw-consent`.
- **Lát E (người merge — auth) — audit & đa tenant:** màn xem/xuất audit cho admin tổ chức; truy cập hỗ trợ có lý do + TTL + hiển thị cho tenant; fair-share worker theo tổ chức + hạn mức theo gói (cấu hình).
- **Quyết định:** D-111…D-114 đã ghi; D-116…D-123 đã ghi (D-117 = ẩn danh inbox T-2308) (mục đích đồng ý, DSAR/xoá, vòng đời tổ chức, analytics, hạn lưu, hỗ trợ, gói).
- **Không làm được trong repo (defer):** `.env.example` (settings chặn agent) ⇒ BASE-CFG-002/FE-BUILD-005/DB-SEC-002; hook `guard.py` ⇒ ARC-ADR-004/XC-DOCAI-005; miễn trừ cần `Duyệt:` của chủ dự án (D-060); VPS/staging/backup/giám sát; diễn tập; thiết bị thật; ký pháp lý.
- **Stack:** giữ nguyên; migration mới có đường lùi; không thêm phụ thuộc runtime trừ khi ghi D-NNN.
- **Rủi ro:** (R1) xoá dữ liệu sai phạm vi — test DB thật mỗi kho, `grant data_delete hard_delete=false` cho production; (R2) chặn xử lý khi thiếu đồng ý làm gãy luồng cũ — mục đích "dịch vụ" theo hợp đồng không cần đồng ý; (R3) PR lớn — mỗi lát một PR, task ≤ 1 ngày.
- **Ngân sách:** `--single-session` · 1800 s/lệnh · 72 giờ.

## Mục tiêu của kế hoạch này
Khi xong: mọi MUST còn mở hoặc đã `[x]` kèm Kiểm/Bằng chứng, hoặc đã `loop defer` với lý do "chỉ người" và phần repo đã làm sẵn.

## Ngân sách (4 con số)
- Số vòng tối đa: bỏ trống (`--single-session`)
- Ngân sách: ≤ 250 USD token
- Timeout mỗi lệnh Gate: 1800 s
- Hạn chót: 72 giờ kể từ `loop init` (`--hours 72`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | 2026-11-01 | luật grype high (npm của node) hết hạn | task kiểm image node / gia hạn có lý do (D-067) |
| Hạn mong muốn | 2026-10-28 | nội bộ | dừng ở lát đã merge |

## Ủy quyền production
- grant: payments | mode=sandbox | max_per_txn=0 | refund=false
- grant: data_delete | hard_delete=false | max_rows=100
- grant: data_export | pii=false | max_rows=10000
- grant: outbound_messages | live=false | max_per_hour=0
- grant: auth_crypto | custom_crypto=false
- grant: secrets | read_values=false

## Điểm dừng bắt buộc về hành động
- Merge PR Lát C, D, E (dữ liệu người dùng, auth, `merge_risk_paths`): người merge.

## Thứ tự & lý do
1. Lát A, B (độc lập, L3). 2. Lát C (nền retention/analytics). 3. Lát D (cần bản ghi đồng ý trước DSAR/xoá). 4. Lát E. Lát C–E chung migration ⇒ tuần tự.

## Task

### Lát A — repo & phát hành (L3)
- [x] `T-2301` D-111: `LICENSE` Proprietary (chủ sở hữu seeker19110) + `license: UNLICENSED` mọi package.json; `scripts/third-party-notices.mjs` sinh `THIRD_PARTY_NOTICES.md` từ phụ thuộc production (`--check` so khác) + test + bước CI (files: LICENSE, THIRD_PARTY_NOTICES.md, scripts/third-party-notices.mjs, scripts/third-party-notices.test.mjs, package.json, apps/*/package.json, packages/*/package.json, .github/workflows/supply-chain.yml) — Gate: `node scripts/third-party-notices.mjs --check && pnpm vitest run --project unit scripts/third-party-notices.test`
- [x] `T-2302` D-112: `SECURITY.md` (phiên bản hỗ trợ, PVR, SLA ≤ 7 ngày, công bố phối hợp), `apps/web/public/.well-known/security.txt` (RFC 9116, Expires ≤ 1 năm) + test hạn, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md` + test cấu trúc (sau: T-2301; files: SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SUPPORT.md, apps/web/public/.well-known/security.txt, scripts/community-files.test.mjs) — Gate: `pnpm vitest run --project unit scripts/community-files.test`
- [x] `T-2303` D-113: `release.yml` job `assets` tạo annotated tag trên `RELEASE_SHA` trước khi công khai; `release-please-config.json` `extra-files` cập nhật `apps/web/package.json`; đồng bộ `apps/web/package.json` version = manifest; test (sau: T-2302; files: .github/workflows/release.yml, release-please-config.json, apps/web/package.json, scripts/release-config.test.mjs) — Gate: `pnpm vitest run --project unit scripts/release-config.test`
- [x] `T-2304` D-114: CMP-LIC-004 tick theo D-114 (ngoại lệ có lý do + hạn); rà BASE-DEP-007 (PR Dependabot thật) (sau: T-2303; files: BLUEPRINT.md, license-policy.json) — Gate: `node scripts/sbom.mjs --out /tmp/hm-sbom.cdx.json --timestamp 2026-10-25T00:00:00Z && node scripts/sbom-check.mjs --policy license-policy.json /tmp/hm-sbom.cdx.json`

### Lát B — hồ sơ tuân thủ có rào CI (L3)
- [x] `T-2305` CMP-INTL-002, CMP-AUDIT-003, CMP-AUDIT-007: lint `docs/privacy/data-map.yaml` bắt buộc `legal_basis` (+ Art. 9 cho dữ liệu nhạy cảm); `docs/privacy/CHANGELOG.md` + nhắc quá hạn 6 tháng; `docs/compliance/vendors.yaml` + `new-deps` chặn SDK/dịch vụ mới thiếu dòng (sau: T-2304; files: scripts/privacy-docs.mjs, scripts/privacy-docs.test.mjs, docs/privacy/, docs/compliance/vendors.yaml, .github/workflows/pr-deps.yml) — Gate: `node scripts/privacy-docs.mjs && pnpm vitest run --project unit scripts/privacy-docs.test`
- [x] `T-2306` CMP-INTL-006, CMP-VN-006, CMP-AUDIT-010, OPS-IR-010, IND-SAAS-010, WF-DOC-008, PM-HANDOVER-009: `docs/ops/runbooks/data-breach.md` (bảng thời hạn theo vùng, Mẫu 08, mẫu thông báo), `docs/ops/incidents/` + mẫu, `docs/legal/DPA.md` + `docs/legal/subprocessors.md` có phiên bản, `docs/ops/RUNBOOK.md` có `last_drilled` + lint quá hạn, `docs/handover/renewals.md` + nhắc ≥ 30 ngày (sau: T-2305; files: docs/ops/, docs/legal/, docs/handover/, scripts/ops-registers.mjs, scripts/ops-registers.test.mjs) — Gate: `node scripts/ops-registers.mjs && pnpm vitest run --project unit scripts/ops-registers.test`
- [x] `T-2307` PM-RISK-007: danh sách luật áp dụng (số hiệu, ngày hiệu lực, URL, ngày kiểm) từ nguồn sống (researcher) vào `PROJECT.md` §Khung pháp lý + `docs/DPIA.md` nháp theo mẫu khung (sau: T-2306; files: PROJECT.md, docs/DPIA.md, scripts/process-docs.test.mjs) — Gate: `pnpm vitest run --project unit scripts/process-docs.test`

### Lát C — retention + analytics (người merge)
- [x] `T-2308` STD-PRIV-005, XC-GREEN-007: job dọn `notifications`, inbox, `worker_heartbeats`, phiên/liên kết khách hết hạn; ẩn danh `persons`/`identity_documents` hết hạn lưu (D-116 hạn mặc định) + test DB seed quá hạn (sau: T-2307; files: packages/app/src/retention/, packages/db/src/migrations/, apps/worker/src/runtime.ts, docs/ops/retention-policy.md) — Gate: `pnpm vitest run --project db packages/app/src/retention && pnpm -r exec tsc --noEmit -p tsconfig.json`
- [x] `T-2309` PM-METRIC-003/005/006 (D-118): `track()` một điểm, schema sự kiện allowlist, cấm PII (test regex), bảng `product_events` + hạn lưu + ngắt liên kết khi xoá tài khoản; rào cấm SDK analytics ngoài `track` (sau: T-2308; files: packages/app/src/analytics/, packages/db/src/migrations/, scripts/) — Gate: `pnpm vitest run --project unit packages/app/src/analytics && pnpm vitest run --project db packages/app/src/analytics`

### Lát D — quyền chủ thể (người merge)
- [ ] `T-2310` CMP-RIGHTS-001, CMP-VN-001, CMP-RIGHTS-004 (D-119): `consent_records` append-only (subject, purpose, policy_version, granted_at, channel, ui_snapshot_hash, withdrawn_at), danh mục mục đích, thu đồng ý ở đăng ký/lời mời/portal, rút cùng số bước, xử lý theo mục đích kiểm đồng ý (sau: T-2309; files: packages/db/src/migrations/, packages/app/src/privacy/, apps/web/app/) — Gate: `pnpm vitest run --project db packages/app/src/privacy && pnpm --filter @hm/web exec playwright test e2e/rights-withdraw-consent.spec.ts`
- [ ] `T-2311` STD-PRIV-004, CMP-VN-007, CMP-INTL-007, CMP-RIGHTS-007, CMP-PRIV-005 (D-120): DSAR (xuất dữ liệu cá nhân, xoá tài khoản có xác thực lại, hạn chế xử lý), `dsar_days` theo vùng + metric quá hạn, xoá lan mọi kho (DB, file, phiên, analytics) giữ phần nghĩa vụ pháp lý có lý do (sau: T-2310; files: packages/app/src/privacy/, packages/db/src/migrations/, apps/web/app/, apps/web/e2e/) — Gate: `pnpm vitest run --project db packages/app/src/privacy && pnpm --filter @hm/web exec playwright test e2e/rights-access.spec.ts e2e/rights-delete.spec.ts`
- [ ] `T-2312` IND-SAAS-006, UX-CONTENT-005 (D-121): vòng đời xoá tổ chức (yêu cầu → giữ N ngày có xuất → purge mọi kho → chứng nhận xoá), luồng huỷ ≤ số bước đăng ký, checklist dark pattern trong PR template (sau: T-2311; files: packages/app/src/tenancy/, packages/db/src/migrations/, apps/worker/src/, apps/web/app/, .github/pull_request_template.md) — Gate: `pnpm vitest run --project db packages/app/src/tenancy && pnpm --filter @hm/web exec playwright test e2e/org-delete.spec.ts`

### Lát E — audit & đa tenant (người merge)
- [ ] `T-2313` IND-SAAS-009, CMP-AUDIT-002 (D-122): màn nhật ký hoạt động cho admin tổ chức (lọc, xuất), truy cập hỗ trợ có lý do + TTL + hiển thị cho tenant, test mỗi hành động nhạy cảm sinh sự kiện đủ trường (sau: T-2312; files: packages/app/src/audit/, packages/app/src/access/, apps/web/app/) — Gate: `pnpm vitest run --project db packages/app/src/audit packages/app/src/access && pnpm --filter @hm/web exec playwright test e2e/audit-log.spec.ts`
- [x] `T-2314` IND-SAAS-008 (D-123): hạn mức theo gói (cấu hình trong repo), fair-share worker theo tổ chức, test tải tenant A bão hoà không làm chậm tenant B (sau: T-2308; files: packages/app/src/pipeline/, apps/worker/src/, packages/app/src/plans/) — Gate: `pnpm vitest run --project db packages/app/src/plans apps/worker/src`

### Lát F — tick và rà
- [ ] `T-2315` Tick MUST đạt kèm Kiểm/Bằng chứng; defer phần chỉ người; PROGRESS, BLUEPRINT-GAPS, AUDIT-STATUS, hướng dẫn (sau: T-2314; files: BLUEPRINT.md, PROGRESS.md, docs/autopilot/BLUEPRINT-GAPS.md, docs/ops/AUDIT-STATUS.md, docs/autopilot/HUONG-DAN-VIEC-CUA-NGUOI.md) — Gate: `python3 scripts/check-blueprint-evidence.py BLUEPRINT.md && python3 .xtemplates/scripts/xt.py progress-check && python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| Merge PR Lát C–E | chủ dự án | để PR mở, báo người |
| Bật PVR, nhãn `major`, `.env.example`, hook, VPS, pháp lý, diễn tập, thiết bị | chủ dự án | `loop defer` + hướng dẫn |
