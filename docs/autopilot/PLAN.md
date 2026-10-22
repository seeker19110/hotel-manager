# docs/autopilot/PLAN.md — Hotel Manager · Đợt 18: chuyển chuỗi i18n theo màn (XC-I18N-001)

> **Cổng duyệt: phiên chính tự duyệt 2026-10-22** (AGENTS §5; D-096 ở `docs/autopilot/DECISIONS.md`). Đợt 17 đã merge (#122).

## Tóm tắt cổng duyệt (≤ 30 dòng)
- **Mục tiêu:** tiến tiếp XC-I18N-001 — MUST duy nhất máy tự làm được (98 MUST mở còn lại cần người, PROGRESS *Tiếp theo*). Chuyển 5 màn có nhiều chuỗi nhất NGOÀI `merge_risk_paths` (202 chuỗi) sang `t()`, và hạ baseline về đúng số đếm hiện tại (đang dư 6 do các đợt trước không hạ).
- **Không làm:** màn trong `merge_risk_paths` (`hop-dong`, `ky-thu`, `thu-tien`, `chi-so`, `doi-soat` — PR sẽ cần người merge); chuỗi ở `packages/app` (thông báo lỗi/xuất file — đổi API, đợt riêng).
- **Stack:** giữ nguyên; không thêm phụ thuộc; không migration.
- **Task:** 3 (T-1801…T-1803), một lát.
- **Rủi ro:** (R1) đổi chữ hiển thị — giữ nguyên từng ký tự, reviewer đối chiếu; (R2) E2E so chữ — chạy E2E các màn chạm tới.
- **Điểm dừng:** không có ngoại lệ cứng.
- **Ngân sách:** `--single-session` · 1800 s/lệnh · 24 giờ.

## Mục tiêu của kế hoạch này
Khi xong: `luu-tru/[id]`, `dat-phong/[id]`, `loi-moi`, `buong-phong/[id]`, `khach/luot-o/[id]` không còn chuỗi viết thẳng; baseline = số đếm thật (≈ 2078).

## Ngân sách (4 con số)
- Số vòng tối đa: bỏ trống (`--single-session`)
- Ngân sách: ≤ 30 USD token
- Timeout mỗi lệnh Gate: 1800 s
- Hạn chót: 24 giờ kể từ `loop init` (`--hours 24`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | 2026-10-23 | nội bộ | cắt T-1802 |

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
1. T-1801 rồi T-1802 (chung `vi.json` và baseline ⇒ tuần tự, một executor).
2. T-1803 rà cuối.

## Task

### Lát 1 — i18n theo màn
- [x] `T-1801` XC-I18N-001 (phần): `apps/web/app/luu-tru/[id]/page.tsx` (57), `apps/web/app/dat-phong/[id]/page.tsx` (43) sang `t()`, văn bản giữ nguyên; hạ baseline bằng `node scripts/i18n-literals.mjs --write` (cũng thu 6 chuỗi dư của các đợt trước) (files: apps/web/app/luu-tru/, apps/web/app/dat-phong/, apps/web/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit scripts/i18n.test && pnpm --filter @hm/web exec tsc -p tsconfig.json`
- [x] `T-1802` XC-I18N-001 (phần): `apps/web/app/loi-moi/accept-invitation.tsx` (40), `apps/web/app/buong-phong/[id]/page.tsx` (31), `apps/web/app/khach/luot-o/[id]/guest-stay.tsx` (31) sang `t()`, văn bản giữ nguyên; hạ baseline (sau: T-1801; files: apps/web/app/loi-moi/, apps/web/app/buong-phong/, apps/web/app/khach/, apps/web/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit scripts/i18n.test apps/web && pnpm --filter @hm/web exec tsc -p tsconfig.json`
- [ ] `T-1803` Rà đợt 18: PROGRESS, BLUEPRINT-GAPS (sau: T-1801, T-1802; files: PROGRESS.md, docs/autopilot/BLUEPRINT-GAPS.md) — Gate: `python3 .xtemplates/scripts/xt.py progress-check`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| 98 MUST còn lại | chủ dự án | `loop defer` |
