# docs/autopilot/PLAN.md — Hotel Manager · Đợt 17: hạn ngoại lệ grype + chuyển chuỗi i18n

> **Cổng duyệt: phiên chính tự duyệt 2026-10-22** (AGENTS §5; D-093/D-094 ở `docs/autopilot/DECISIONS.md`). Đợt 16 đã merge (#118); khung 3.15.1 (#121).

## Tóm tắt cổng duyệt (≤ 30 dòng)
- **Mục tiêu:** (1) 4 luật critical trong `.grype.yaml` hết hạn 2026-10-25 — rà lại 2026-10-22: Caddy chưa ra bản sau 2.11.7 (image 2.11.7-alpine dựng lại 2026-10-21 vẫn tải cùng nhị phân phát hành, Go 1.26.8), SeaweedFS chưa có 4.49 ⇒ chưa gỡ được; quyết lại theo D-067 trước khi job `image-scan` đỏ. (2) Tiến dần XC-I18N-001: chuyển chuỗi viết thẳng của hai màn quản trị (`/co-so`, `/thanh-vien`, 77 chuỗi) sang `t()`, baseline chỉ giảm.
- **Không làm:** tự dựng image Caddy/SeaweedFS bằng Go 1.26.10 (đổi cách triển khai, chưa có production — D-094); 91 MUST còn mở đều cần người (PROGRESS *Tiếp theo*).
- **Stack:** giữ nguyên; không thêm phụ thuộc; không migration.
- **Task:** 3 (T-1701…T-1703), 2 lát độc lập file.
- **Rủi ro:** (R1) gia hạn che lỗ hổng thật — chỉ gia hạn ≤ 7 ngày cho critical, ghi giảm nhẹ; (R2) chuyển chuỗi làm đổi chữ trên giao diện — E2E/unit hiện có bắt chữ, khoá dịch giữ nguyên văn bản.
- **Điểm dừng:** không có ngoại lệ cứng (không chạm tiền/CSDL/auth).
- **Ngân sách:** `--single-session` · 1800 s/lệnh · 24 giờ.

## Mục tiêu của kế hoạch này
Khi xong: `image-scan` không đỏ vì quá hạn trước khi thượng nguồn có bản vá, mọi luật có hạn ≤ 7 ngày (critical) kèm lý do đã rà; `/co-so` và `/thanh-vien` không còn chuỗi viết thẳng (baseline giảm 77).

## Ngân sách (4 con số)
- Số vòng tối đa: bỏ trống (`--single-session`)
- Ngân sách: ≤ 30 USD token
- Timeout mỗi lệnh Gate: 1800 s
- Hạn chót: 24 giờ kể từ `loop init` (`--hours 24`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | 2026-10-25 | `image-scan` (required) đỏ trên mọi PR | T-1701 làm trước |
| Hạn mong muốn | 2026-10-22 | nội bộ | cắt T-1702 |

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
1. **Lát 1 — hạn ngoại lệ grype** (T-1701): có hạn thật 2026-10-25.
2. **Lát 2 — i18n** (T-1702, T-1703): độc lập file với lát 1.

## Task

### Lát 1 — Hạn ngoại lệ grype
- [x] `T-1701` Rà lại 4 luật critical hạn 2026-10-25 (D-094): GO-2026-6604 chỉ ảnh hưởng Windows (`os.Root` qua junction) — giữ luật, ghi "không áp dụng Linux"; GO-2026-6612 (HTTP/2 server, sửa Go 1.26.9 / x/net 0.60.0) — chưa có image vá ⇒ gia hạn ≤ 7 ngày (2026-10-29), cập nhật bảng "Theo dõi" của `docs/ops/VULN-SLA.md` (ngày tra, bằng chứng tag/nhị phân) và đề xuất "Khi chạy thật" (tắt h2 ở Caddy hoặc tự dựng image nếu thượng nguồn vẫn chưa vá khi lên production) (files: .grype.yaml, docs/ops/VULN-SLA.md, docs/autopilot/DECISIONS.md) — Gate: `node scripts/grype-ignore-check.mjs && pnpm vitest run --project unit scripts/supply-chain`

### Lát 2 — i18n
- [x] `T-1702` XC-I18N-001 (phần): chuyển mọi chuỗi viết thẳng của `apps/web/app/co-so/page.tsx` và `apps/web/app/thanh-vien/page.tsx` sang `t()` với khoá mới trong `apps/web/messages/vi.json` (giữ nguyên văn bản hiển thị), hạ baseline đúng số đếm mới (files: apps/web/app/co-so/, apps/web/app/thanh-vien/, apps/web/messages/vi.json, scripts/i18n-literal-baseline.json) — Gate: `node scripts/i18n-check.mjs && pnpm vitest run --project unit scripts/i18n.test && pnpm --filter @hm/web exec tsc -p tsconfig.json`
- [ ] `T-1703` Rà đợt 17: PROGRESS, BLUEPRINT-GAPS (sau: T-1701, T-1702; files: PROGRESS.md, docs/autopilot/BLUEPRINT-GAPS.md) — Gate: `python3 .xtemplates/scripts/xt.py progress-check`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| Image Caddy/SeaweedFS dựng bằng Go ≥ 1.26.9 | thượng nguồn | gia hạn ≤ 7 ngày mỗi lần, tự dựng image trước khi lên production |
