# docs/autopilot/PLAN.md — Hotel Manager · Đợt 19: chuyển chuỗi i18n theo màn (XC-I18N-001, nhịp D-097)

> **Cổng duyệt: phiên chính tự duyệt 2026-10-23** (AGENTS §5; D-099 ở `docs/autopilot/DECISIONS.md`). Đợt 18 đã merge (#123); #124–#126 merge 2026-10-23.

## Tóm tắt cổng duyệt (≤ 30 dòng)
- **Mục tiêu:** tiếp XC-I18N-001 theo nhịp D-097 (từng lô màn ngoài `merge_risk_paths`): 7 trang server + 2 client component, ≈ 179 chuỗi.
- **Không làm:** `apps/web/lib/format.ts` (74 chuỗi — helper định dạng dùng chung, đợt riêng), màn trong `merge_risk_paths`, `packages/app` (D-097).
- **Ràng buộc từ D-098:** client component KHÔNG import catalog — nhận `m = messagesFor(…)` từ server cha, dùng `tm()`; `i18n-check` chặn vi phạm; `pnpm size` ≤ 300 kB.
- **Stack:** giữ nguyên; không thêm phụ thuộc; không migration.
- **Task:** 3 (T-1901…T-1903), một lát.
- **Rủi ro:** (R1) đổi chữ — giữ nguyên từng ký tự, reviewer đối chiếu; (R2) bundle — đo `pnpm size`.
- **Điểm dừng:** không có ngoại lệ cứng.
- **Ngân sách:** `--single-session` · 1800 s/lệnh · 24 giờ.

## Mục tiêu của kế hoạch này
Khi xong: 9 tệp dưới đây hết chuỗi viết thẳng; baseline ≈ 1899; bundle client vẫn ≤ 300 kB.

## Ngân sách (4 con số)
- Số vòng tối đa: bỏ trống (`--single-session`)
- Ngân sách: ≤ 30 USD token
- Timeout mỗi lệnh Gate: 1800 s
- Hạn chót: 24 giờ kể từ `loop init` (`--hours 24`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | 2026-10-24 | nội bộ | cắt T-1902 |

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
1. T-1901 rồi T-1902 (chung `vi.json`/baseline ⇒ tuần tự, một executor). 2. T-1903 rà cuối.

## Task

### Lát 1 — i18n theo màn
- [x] `T-1901` XC-I18N-001 (phần): trang server `apps/web/app/su-co/page.tsx` (26), `apps/web/app/buong-phong/page.tsx` (24), `apps/web/app/portal/thanh-toan/[id]/page.tsx` (20), `apps/web/app/thong-bao/page.tsx` (17) sang `t()`, văn bản giữ nguyên (files: apps/web/app/su-co/, apps/web/app/buong-phong/page.tsx, apps/web/app/portal/thanh-toan/, apps/web/app/thong-bao/, apps/web/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit scripts/i18n.test && pnpm --filter @hm/web exec tsc -p tsconfig.json`
- [x] `T-1902` XC-I18N-001 (phần): `apps/web/app/page.tsx` (17), `apps/web/app/lich-phong/page.tsx` (17), `apps/web/app/hom-nay/[card]/page.tsx` (16) sang `t()`; client `apps/web/components/hotel/booking-form.tsx` (25), `apps/web/components/hotel/incident-form.tsx` (17) sang `tm(m, …)` với `m` từ server cha (D-098); hạ baseline `--write` (sau: T-1901; files: apps/web/app/page.tsx, apps/web/app/lich-phong/, apps/web/app/hom-nay/, apps/web/components/hotel/, apps/web/app/su-co/, apps/web/app/dat-phong/, apps/web/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit scripts/i18n.test apps/web && pnpm --filter @hm/web exec tsc -p tsconfig.json`
- [x] `T-1903` Rà đợt 19: PROGRESS, BLUEPRINT-GAPS, audit delta (sau: T-1901, T-1902; files: PROGRESS.md, docs/autopilot/BLUEPRINT-GAPS.md, docs/ops/AUDIT-STATUS.md) — Gate: `python3 .xtemplates/scripts/xt.py progress-check && python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| 90 MUST còn lại (trừ XC-I18N-001) | chủ dự án | `loop defer` |
