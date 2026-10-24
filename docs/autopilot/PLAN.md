# docs/autopilot/PLAN.md — Hotel Manager · Đợt 21: chuyển chuỗi i18n theo màn (XC-I18N-001, nhịp D-097)

> **Cổng duyệt: phiên chính tự duyệt 2026-10-24** (AGENTS §5; D-102 ở `docs/autopilot/DECISIONS.md`). Đợt 20 đã merge (#128); #129 vá zod.

## Tóm tắt cổng duyệt (≤ 30 dòng)
- **Mục tiêu:** tiếp XC-I18N-001 (nhịp D-097) cho phần đuôi ngoài `merge_risk_paths` (≈ 165 chuỗi / ~55 tệp), trừ `apps/web/lib/format.ts`.
- **Thiết kế (D-101):** hạ tầng client dùng chung (`command-form`, `command-status`, `use-command`, `use-photo-upload`, `reauth-dialog`, `route-state`, `pwa-shell`, `logout-button`, `portal-nav`) được render từ rất nhiều trang ⇒ không truyền `m` qua prop từng trang. Thêm `MessagesProvider` (client context) bọc ở `app/layout.tsx` với `messagesFor("common.")` + hook `useMessages()`; client gọi `tm(useMessages(), "common.…")`. Vẫn đúng D-098: catalog không vào bundle (chỉ payload RSC của các khoá `common.`); `i18n-check` kiểm `tm()` như cũ.
- **Không làm:** `apps/web/lib/format.ts` (74; được cả server lẫn client import — đợt riêng), `merge_risk_paths`, `packages/app` (D-097).
- **Stack:** giữ nguyên; không thêm phụ thuộc; không migration.
- **Task:** 3 (T-2101…T-2103), một lát.
- **Rủi ro:** (R1) đổi chữ — giữ nguyên từng ký tự, reviewer đối chiếu; (R2) bundle/payload — đo `pnpm size`; (R3) context thiếu provider (test/Storybook) — hook ném lỗi rõ ràng, test unit bọc provider.
- **Điểm dừng:** PR chạm `dang-nhap` (auth) ⇒ người merge nếu `merge-check` báo ngoại lệ cứng.
- **Ngân sách:** `--single-session` · 1800 s/lệnh · 24 giờ.

## Mục tiêu của kế hoạch này
Khi xong: baseline ngoài `merge_risk_paths` của `apps/web` chỉ còn `lib/format.ts`; bundle ≤ 300 kB.

## Ngân sách (4 con số)
- Số vòng tối đa: bỏ trống (`--single-session`)
- Ngân sách: ≤ 30 USD token
- Timeout mỗi lệnh Gate: 1800 s
- Hạn chót: 24 giờ kể từ `loop init` (`--hours 24`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | chưa có | — | — |
| Hạn mong muốn | 2026-10-25 | nội bộ | cắt T-2102 |

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
1. T-2101 (thiết kế, executor-deep) rồi T-2102 (cơ học, executor) — chung `vi.json`/baseline ⇒ tuần tự. 2. T-2103 rà cuối.

## Task

### Lát 1 — i18n phần đuôi
- [x] `T-2101` D-101: `apps/web/lib/i18n-context.tsx` (`MessagesProvider`, `useMessages()` — ném lỗi khi thiếu provider), bọc ở `app/layout.tsx` với `messagesFor("common.")`; chuyển hạ tầng client `components/command/{command-form,command-status,use-command,use-photo-upload,reauth-dialog}.ts(x)`, `components/ui/route-state.tsx`, `components/pwa/{pwa-shell,logout-button}.tsx`, `components/portal/portal-nav.tsx` sang `tm(useMessages(), "common.…")`; test unit bọc provider; `scripts/i18n-check.mjs` + test: `useMessages` không phải import giá trị catalog (exec: deep; files: apps/web/lib/, apps/web/app/layout.tsx, apps/web/components/command/, apps/web/components/ui/, apps/web/components/pwa/, apps/web/components/portal/, apps/web/messages/vi.json, scripts/i18n-check.mjs, scripts/i18n.test.mjs, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit scripts/i18n.test apps/web && pnpm --filter @hm/web exec tsc -p tsconfig.json`
- [x] `T-2102` XC-I18N-001: mọi tệp `apps/web` còn lại trong baseline ngoài `merge_risk_paths`, trừ `lib/format.ts` (trang server `t()`, client `tm` qua `m` hoặc `useMessages()`); hạ baseline `--write` (sau: T-2101; files: apps/web/app/, apps/web/components/, apps/web/lib/page.tsx, apps/web/lib/portal-page.tsx, apps/web/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && node scripts/i18n-literals.mjs && pnpm vitest run --project unit scripts/i18n.test apps/web && pnpm --filter @hm/web exec tsc -p tsconfig.json`
- [ ] `T-2103` Rà đợt 21: PROGRESS, BLUEPRINT-GAPS, audit delta (sau: T-2101, T-2102; files: PROGRESS.md, docs/autopilot/BLUEPRINT-GAPS.md, docs/ops/AUDIT-STATUS.md) — Gate: `python3 .xtemplates/scripts/xt.py progress-check && python3 .xtemplates/scripts/xt.py audit check docs/ops/AUDIT-STATUS.md`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| 89 MUST còn lại (trừ XC-I18N-001) | chủ dự án | `loop defer` |
