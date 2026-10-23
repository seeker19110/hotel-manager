# docs/autopilot/PLAN.md — Hotel Manager · Đợt 20: chuyển chuỗi i18n theo màn (XC-I18N-001, nhịp D-097)

> **Cổng duyệt: phiên chính tự duyệt 2026-10-23** (AGENTS §5; D-100 ở `docs/autopilot/DECISIONS.md`). Đợt 19 đã merge (#127).

## Tóm tắt cổng duyệt (≤ 30 dòng)
- **Mục tiêu:** tiếp XC-I18N-001 theo nhịp D-097 (từng lô màn ngoài `merge_risk_paths`): 5 trang server + 8 client component, ≈ 173 chuỗi.
- **Không làm:** `apps/web/lib/format.ts` (74 chuỗi — được client component import nên không dùng `t()` được; cần tách nhãn ra module server/truyền qua `m`, đợt riêng có thiết kế), `components/command/use-photo-upload.ts` (hook), màn trong `merge_risk_paths`, `packages/app` (D-097).
- **Ràng buộc từ D-098:** client component KHÔNG import catalog — nhận `m = messagesFor(…)` từ server cha, dùng `tm()`; `i18n-check` chặn vi phạm; `pnpm size` ≤ 300 kB.
- **Stack:** giữ nguyên; không thêm phụ thuộc; không migration.
- **Task:** 3 (T-2001…T-2003), một lát.
- **Rủi ro:** (R1) đổi chữ — giữ nguyên từng ký tự, reviewer đối chiếu; (R2) bundle — đo `pnpm size`.
- **Điểm dừng:** không có ngoại lệ cứng.
- **Ngân sách:** `--single-session` · 1800 s/lệnh · 24 giờ.

## Mục tiêu của kế hoạch này
Khi xong: 13 tệp dưới đây hết chuỗi viết thẳng; baseline ≈ 1726; bundle client vẫn ≤ 300 kB.

## Ngân sách (4 con số)
- Số vòng tối đa: bỏ trống (`--single-session`)
- Ngân sách: ≤ 30 USD token
- Timeout mỗi lệnh Gate: 1800 s
- Hạn chót: 24 giờ kể từ `loop init` (`--hours 24`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | 2026-10-24 | nội bộ | cắt T-2002 |

## Ủy quyền production
- grant: payments | mode=sandbox | max_per_txn=0 | refund=false
- grant: data_delete | hard_delete=false | max_rows=100
- grant: data_export | pii=false | max_rows=10000
- grant: outbound_messages | live=false | max_per_hour=0
- grant: auth_crypto | custom_crypto=false
- grant: secrets | read_values=false

## Điểm dừng bắt buộc về hành động
- Không có trong đợt này.

## Thứ tự & lý do
1. T-2001 rồi T-2002 (chung `vi.json`/baseline ⇒ tuần tự, một executor). 2. T-2003 rà cuối.

## Task

### Lát 1 — i18n theo màn
- [x] `T-2001` XC-I18N-001 (phần): trang server `apps/web/app/thong-bao-luu-tru/page.tsx` (14), `apps/web/app/portal/phieu/[id]/page.tsx` (12), `apps/web/app/phong/page.tsx` (11), `apps/web/app/dat-phong/page.tsx` (11), `apps/web/app/portal/yeu-cau/page.tsx` (9) sang `t()`; client `apps/web/components/hotel/notice-actions.tsx` (9), `apps/web/components/hotel/guests-form.tsx` (19), `apps/web/components/portal/request-form.tsx` (17) sang `tm(m, …)` (files: apps/web/app/thong-bao-luu-tru/, apps/web/app/portal/, apps/web/app/phong/page.tsx, apps/web/app/dat-phong/, apps/web/app/luu-tru/, apps/web/components/hotel/, apps/web/components/portal/, apps/web/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit scripts/i18n.test && pnpm --filter @hm/web exec tsc -p tsconfig.json`
- [x] `T-2002` XC-I18N-001 (phần): client `apps/web/app/bao-mat/mfa-enroll.tsx` (21), `apps/web/components/pwa/install-app.tsx` (14), `apps/web/app/dang-nhap/nguoi-thue/tenant-login-form.tsx` (12), `apps/web/app/huy-dang-ky/unsubscribe-confirm.tsx` (11), `apps/web/app/dang-nhap/login-form.tsx` (11), `apps/web/app/dang-ky/register-form.tsx` (11) sang `tm(m, …)` với `m` từ server cha (D-098); hạ baseline `--write` (sau: T-2001; files: apps/web/app/bao-mat/, apps/web/components/pwa/, apps/web/app/dang-nhap/, apps/web/app/huy-dang-ky/, apps/web/app/dang-ky/, apps/web/app/layout.tsx, apps/web/lib/page.tsx, apps/web/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit scripts/i18n.test apps/web && pnpm --filter @hm/web exec tsc -p tsconfig.json`
- [x] `T-2003` Rà đợt 20: PROGRESS, BLUEPRINT-GAPS, audit delta (sau: T-2001, T-2002; files: PROGRESS.md, docs/autopilot/BLUEPRINT-GAPS.md, docs/ops/AUDIT-STATUS.md) — Gate: `python3 .xtemplates/scripts/xt.py progress-check && python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| 89 MUST còn lại (trừ XC-I18N-001) | chủ dự án | `loop defer` |
