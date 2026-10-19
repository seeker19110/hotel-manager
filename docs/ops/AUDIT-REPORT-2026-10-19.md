# AUDIT-REPORT — 2026-10-19

Kho `seeker19110/hotel-manager` @ `12f55e5` (sau #98). Sổ máy đọc: `docs/ops/AUDIT-STATUS.md`. Chế độ: `full` lần đầu (chưa có sổ).

## Tóm tắt

| Mức | Mở |
|---|---|
| 🔴 | 1 |
| 🟠 | 4 |
| 🟢 | 22 (gồm 11 mục báo là 🟡; khung chỉ có ba mức) |

Nhóm: đã quét 4 (ARCH, CI, DOC, HAR) · rút gọn 8 (SEC, CODE, TEST, PERF, DEP, DATA, CFG, XFEAT) · **chưa quét 1 (A11Y)**. Chưa đạt Definition of Complete (còn 🔴/🟠 mở, còn nhóm chưa quét).

## Phạm vi và công cụ

`audit plan`: 1085 file, 13 nhóm áp dụng. Công cụ **không có**: osv-scanner, zizmor, actionlint, shellcheck, lychee, k6, lighthouse, axe, knip — các phần phụ thuộc chúng ghi `chưa biết:`.

| Lệnh | Kết quả |
|---|---|
| `xt.py doctor --json` | ok, 0 phát hiện |
| `gitleaks detect --log-opts=--all` (547 commit) | no leaks, exit 0 |
| `.xtemplates/scripts/dev-task.sh gate` | XANH, 3783 test |
| `xt.py loop verify` (trên `12f55e5`) | XANH, 91 Gate + 15 lệnh kiểm blueprint |
| `xt.py ci-check .github/workflows` | đạt (18 workflow) |
| semgrep (p/typescript, nodejs, github-actions, secrets) | 3 kết quả, đều dương tính giả/fixture |
| `grype-ignore-check.mjs` | 25 luật còn hạn (sớm nhất 2026-10-25) |
| `progress-check`, `check-blueprint-evidence.py`, `check-erd.py`, link ngoài | đạt |

Quét bởi bốn subagent chỉ đọc (cụm SEC/CFG/DEP/CI, ARCH/CODE/TEST/PERF, DOC/HAR/XFEAT, DATA/A11Y); 3/4 cụm chạm trần 40 lượt và nộp phần đã có, nên phần "chưa quét" của từng nhóm ghi ở cột Ghi chú của sổ.

## 🔴 AUD-SEC-001 — chiếm trước email người thuê (đã xác minh đối kháng)

Đăng ký mật khẩu không đòi xác minh email (`auth.ts:144-150`); `portal.inviteTenant` dùng lại `auth.user` có sẵn theo email và đặt membership `tenant` `active` ngay (`access.ts:65-92`), không kiểm `emailVerified`, không cần token mời. Gốc: D-016 giả định email chỉ được chứng minh bằng OTP.

Tái hiện (một reviewer khác, test DB tạm đi qua `auth.handler` thật, đã xoá sau khi chạy):
1. `POST /sign-up/email` với email nạn nhân → 200, `emailVerified=false`.
2. Chủ trọ chạy `inviteTenant` cùng email → membership `tenant` active, `sameUser=true`.
3. Kẻ gian `POST /sign-in/email` bằng mật khẩu của mình → 200; `resolveActor` = tenant với `personId` nạn nhân; `getMyLease` trả hợp đồng, tiền thuê, cọc 3.000.000. `submitPaymentClaim`, `createRequest` cũng mở.

Không lớp nào chặn (đã tìm: `requireEmailVerification`, `disableSignUp` chỉ cho emailOTP, hook `before`, `OTP_BLOCKED_PATHS`, MFA tenant, `databaseHooks`). Hướng sửa: (a) `inviteTenant` không gắn vào user chưa xác minh có credential mật khẩu; (b) tenant chỉ đăng nhập OTP và OTP đặt `emailVerified`; (c) `requireEmailVerification`. Gate: thêm đúng kịch bản trên vào `portal-access.db.test.ts` (hiện qua = đỏ). Chạm auth + dữ liệu thật ⇒ ngoại lệ cứng, người merge.

## 🟠 AUD-DATA-001 / AUD-DATA-002 — RLS bảng danh mục (phiên chính tự tái hiện)

Postgres 17 tạm, 60 migration, `SET ROLE app_runtime` + `app.actor_id`:
- Tenant không hợp đồng: `count(*)` units/floors/room_types/properties = 2 (cả hai cơ sở). Policy duy nhất là `tenant_isolation` theo `organization_id`; `DENY_READ` của 0039 thiếu các bảng này.
- Front_desk gán cơ sở A: thấy units của B; `UPDATE units … WHERE property_id=B` → 1 dòng; INSERT vào B được. RLS các bảng này không gọi `actor_can_see_property`.

Chưa xác minh app có chặn ở tầng command hay không (nếu có, đây là thiếu phòng thủ chiều sâu theo AGENTS §9). Script: scratch `aud4/repro.ts` (ngoài repo).

## 🟠 AUD-CI-001 và AUD-HAR-001

- **CI-001** (`suy luận`, đo được một phần): `coverage` bị `skipped` ở run `edited` đè lên run đỏ cùng SHA; thấy trên #94/#95 các run `skipped` sau `success`. Chưa biết GitHub lấy run mới nhất cho required check hay không — cần thử PR đỏ thật.
- **HAR-001** (đo được): MUST `XC-OSS-007` miễn với lý do "không có phát hành công khai", nhưng repo public, Release v0.2.0 có tarball + SBOM + SHA256SUMS, tag `v0.2.0` lightweight chưa ký. Cần chủ dự án quyết (mở lại hoặc sửa lý do miễn).

## Kế hoạch sửa theo đợt (đề xuất, chờ duyệt)

| Đợt | Nội dung | Ghi chú |
|---|---|---|
| 1 | SEC-001: test DB đỏ trước, rồi sửa | 🔴 trước; PR do người merge (auth/dữ liệu thật) |
| 2 | DATA-001, DATA-002: test DB đỏ trước, migration mới policy RESTRICTIVE/`actor_can_see_property` | chạm `packages/db` ⇒ người merge; xác minh trước phần app đã chặn chưa |
| 3 | CI-001 (bỏ `if` job `coverage`) + `commit-lint` CI-002 | cấu hình cổng ⇒ nêu lý do trong PR |
| — | HAR-001 | việc người: quyết mở lại/sửa lý do miễn |
| 4 | Nợ 🟢: tài liệu (DOC-001/002/003/004, HAR-002, ARCH-001), XFEAT-001…005, CFG-001 (cấm `fake://` ở production), PERF-001/002 (đo trước) | gom theo module |
| 5 | Quét A11Y + phần "chưa quét" của các nhóm rút gọn, rồi `audit plan` quét lại nhóm đổi | cần axe/trình duyệt |

## Nợ 🟢 còn lại

22 mục `mở` trong sổ, chưa gán chủ/hạn (cần chủ dự án chỉ định; đề xuất chủ mặc định: phiên chính cho DOC/XFEAT/CFG, người cho HAR-001).
