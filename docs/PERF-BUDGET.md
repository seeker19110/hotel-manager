---
title: Ngân sách bundle JS (Hotel Manager)
kind: perf
updated: 2026-10-18
---

# Ngân sách bundle JS

> Mục blueprint: `FE-PERF-004`, `XC-GREEN-002`. Cấu hình máy đọc: `.size-limit.json` (size-limit 14.1.0, `@size-limit/file`, đo gzip trên
> kết quả `next build`). Chạy: `pnpm build && pnpm size`. CI: job `bundle-size` trong `.github/workflows/frontend-quality.yml` (đỏ khi vượt).

## Số đo thật (2026-10-18, `next build` production, Next 16.4.1 Turbopack)

| Phạm vi | Đo | Ngân sách | Dư |
|---|---|---|---|
| Toàn bộ JS client `apps/web/.next/static/chunks/**/*.js` (41 chunk), gzip | 271,24 kB | **300 kB** | ~10,6% |
| Chunk lớn nhất (React/Next runtime), gzip | 71,8 kB | (nằm trong tổng) | — |
| JS khởi động của mọi trang công khai (7 chunk: `/dang-nhap`, `/offline`…), chưa nén | 477 194 B | (tổng ở trên) | — |

## Lý do chọn ngưỡng
- Ngưỡng = số đo hiện tại làm tròn lên mức dư ~10%: đủ chỗ cho thêm một màn nhỏ, chặn một thư viện nặng lọt vào (vd thêm ~30 kB gzip là đỏ).
  Nới ngưỡng phải ghi lý do ở đây (bảng "Lịch sử") và trong PR; không nới để cho xanh.
- Ngân sách theo từng trang/route (trọng lượng truyền tải và số request, đã gồm JS của route đó) nằm ở `perf/budgets.json`, chặn trong
  E2E `perf-baseline.spec.ts` (job `e2e`) — đây là "trần chunk route". Tên chunk Next có băm theo nội dung nên không ghim từng tệp ở size-limit.
- Ứng dụng nhân viên dùng trên điện thoại/mạng chậm (PROJECT.md §5); mục tiêu LCP ≤ 2,5 s ở `lighthouserc.json`.

## Lịch sử
| Ngày | Thay đổi | Lý do |
|---|---|---|
| 2026-10-18 | Lập ngân sách 300 kB (đo 271,24 kB) | T-804, FE-PERF-004 |

## Ngân sách tài nguyên (XC-GREEN-002)

Số liệu và trần ở [`perf/resource-budgets.json`](../perf/resource-budgets.json); vượt là đỏ.

| Tài nguyên | Trần | Số đo (2026-10-18) | Máy kiểm |
|---|---|---|---|
| Image `postgres` (+ pgBackRest) | 550 MB | 455,8 MB | job `image-scan` → `scripts/check-image-size.mjs` |
| Image nền web/worker `node-base` | 285 MB | 234,7 MB | như trên |
| Image `seaweedfs` | 640 MB | 529,2 MB | như trên |
| Image `caddy` | 80 MB | 66,3 MB | như trên |
| Số job CI mỗi PR (tính cả matrix) | 40 | 34 | `scripts/perf-budget-resources.test.mjs` |
| Timeout một job | 45 phút | lớn nhất 40 | như trên |
| Tổng timeout các job mỗi PR | 600 phút | 535 | như trên |
| JS client (gzip), trang | xem các mục trên | — | `bundle-size`, `lighthouse`, `perf/budgets.json` |

Số đo image là `imageSize` trong báo cáo grype của CI trên `main` 251f605; trần = số đo × 1,2 làm tròn lên. Nới trần phải ghi lý do trong PR và cập nhật bảng này. Chi phí hạ tầng theo đơn vị chức năng (chi phí/kWh) cần nhà cung cấp hạ tầng thật — hiện chỉ có ngân sách email (OPS-COST-004); cảnh báo chi phí hosting là việc khi có VPS.
