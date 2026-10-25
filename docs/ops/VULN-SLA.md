# Chính sách xử lý lỗ hổng phụ thuộc và image (SLA)

> OPS-MAINT-004, BASE-DEP-009, SEC-SUPPLY-006. Cơ chế quét: `.github/workflows/supply-chain.yml` (SBOM npm + 4 image, grype),
> `.github/workflows/dep-audit.yml` (`pnpm audit --prod`), `.github/workflows/eol-check.yml` (hết hạn hỗ trợ). Mọi workflow
> chạy mỗi PR/push `main` **và hằng tuần** (thứ Hai, quét lại với cơ sở dữ liệu lỗ hổng mới).

## SLA theo mức

Tính từ lúc lỗ hổng xuất hiện trên một lượt quét (CI đỏ hoặc báo cáo tuần), **chỉ với lỗ hổng đã có bản sửa** (`only-fixed`):

| Mức | CI | Thời hạn xử lý (nâng bản, thay gói, hoặc ngoại lệ có hạn) |
|---|---|---|
| Critical | đỏ, chặn merge | 7 ngày |
| High | đỏ, chặn merge | 14 ngày |
| Medium | `pnpm audit` đỏ từ mức moderate cho phụ thuộc production; image: báo cáo, không chặn | 60 ngày |
| Low | báo cáo | 180 ngày hoặc đợt nâng phụ thuộc kế tiếp |

- CI đỏ vì critical/high chặn merge ngay: nhánh tính năng không được vào `main` khi còn lỗ hổng high/critical có bản sửa. SLA 7/14 ngày áp cho
  lỗ hổng mới công bố ở **lượt quét tuần** trên `main` (không có PR nào để chặn): người trực mở PR nâng bản trong hạn.
- Lỗ hổng **chưa có bản sửa**: không chặn build; ghi vào mục "Theo dõi" dưới đây, kiểm lại mỗi tuần; có bản sửa thì SLA bắt đầu tính.
- **Ngoại lệ** (chưa nâng được): ghi `docs/autopilot/DECISIONS.md` (D-NNN) với lý do, biện pháp giảm nhẹ, ngày hết hạn ≤ 30 ngày; hết hạn thì xử lý lại.
  Với image dùng tệp bỏ qua của grype thì phải ghi cùng D-NNN ở comment dòng đó (không có ngoại lệ ngầm).
- Nâng bản do lỗ hổng không chờ nhịp Dependabot hằng tuần (cập nhật bảo mật của Dependabot không chịu `cooldown`).

## Review tháng

Đầu mỗi tháng người duyệt: (1) mở lượt chạy `Supply chain` mới nhất trên `main` và `Dependency audit`, tải artifact `sbom-*` (báo cáo `*.grype.json`);
(2) đếm số lỗ hổng đã có bản sửa **quá SLA**; (3) ghi một dòng vào bảng dưới. Mục tiêu: quá SLA = 0; khác 0 thì mở việc ngay và nêu trong báo cáo tháng.

| Tháng | Nguồn | Critical | High | Medium | Quá SLA | Ghi chú |
|---|---|---|---|---|---|---|
| 2026-10 | `pnpm audit` (cục bộ, 2026-10-18, mọi gói kể cả dev) | 0 | 0 | 0 | 0 | "No known vulnerabilities found". Quét image/SBOM bằng grype chạy lần đầu trên CI của PR T-802 — kết quả ghi bổ sung khi PR xanh |

## Theo dõi (lỗ hổng chưa có bản sửa)

_Không có lỗ hổng "chưa ai sửa"._ Dưới đây là ngoại lệ có hạn (`.grype.yaml`) cho lỗ hổng high/critical **đã có bản sửa ở thượng nguồn nhưng image
đang ghim chưa được dựng lại** (không có tag mới cùng dòng phiên bản; tra Docker Hub 2026-10-18, rà lại 2026-10-22 — D-094). Mỗi mã trong `.grype.yaml` phải có mặt ở bảng này
và `reason` ghi hạn rà lại; job `image-scan` (`scripts/grype-ignore-check.mjs`, mỗi PR + hằng tuần — khôi phục ở pha harden, D-091) đỏ khi quá hạn. Đến hạn: nâng image nếu đã có bản vá (gỡ luật), không thì quyết định lại.

2026-10-25 (D-110): caddy và SeaweedFS **tự dựng** từ mã nguồn (Caddy v2.11.7, SeaweedFS 4.48 commit `530be3e`) bằng Go 1.26.10 +
`golang.org/x/net` v0.61.0 trên Alpine 3.24.3 đã `apk upgrade` (`deploy/caddy/Dockerfile`, `deploy/seaweedfs/Dockerfile`) — gỡ 24 luật
(GO-2026-66xx, zlib CVE-2026-85091, brotli-libs CVE-2026-111497). Còn lại một Medium ở Caddy (`go-chi/chi` v5.3.2, GHSA-j6qf-3m9c-vwj3 —
dưới ngưỡng chặn, SLA 60 ngày; Dependabot `gomod` nâng).

| Image / gói | Mã (mức) | Sửa ở | Hạn rà lại | Giảm nhẹ / ghi chú |
|---|---|---|---|---|
| `node:24.22.0-trixie-slim` — npm đi kèm (`/usr/local/lib/node_modules/npm`): undici 6.28.0, brace-expansion 5.0.9 | GHSA-rfgv-xxqx-mfg5, GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7 (High) | undici 6.28.1, brace-expansion 5.0.11 | 2026-11-01 | Không phải phụ thuộc của dự án; stage runtime của web/worker xoá npm (`deploy/*.Dockerfile`) nên không có trong image chạy thật |
| `node:24.22.0-trixie-slim` — npm đi kèm: undici 6.28.0 | GHSA-xjj6-f33q-929c (High) | undici 6.29.1 | 2026-11-08 | Như dòng trên: stage runtime web/worker xoá npm; `node:24` mới nhất (rà 2026-10-25) vẫn kèm 6.28.0 |
| Phụ thuộc dev `zod` 3.25.76 (qua `@lhci/cli` → lighthouse → puppeteer-core → chromium-bidi) | GHSA-mrhx-c7xc-m3w5 (High) | zod 4.6.6 (đổi major) | 2026-11-08 | Chỉ chạy trong job `lighthouse` của CI, không vào bundle/production; zod 4.x của dự án đã ghim 4.6.7 (override). Gỡ khi lighthouse/chromium-bidi lên zod 4 |
