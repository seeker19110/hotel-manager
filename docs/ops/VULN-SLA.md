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

| Image / gói | Mã (mức) | Sửa ở | Hạn rà lại | Giảm nhẹ / ghi chú |
|---|---|---|---|---|
| `caddy:2.11.7-alpine` — Go stdlib 1.26.8, `golang.org/x/net` v0.59.0 trong `/usr/bin/caddy` | GO-2026-6612 (Critical), GO-2026-6604 (Critical) | Go 1.26.9, x/net 0.60.0 | 2026-10-29 | Rà 2026-10-22 (D-094): Caddy mới nhất v2.11.7 — image `2.11.7-alpine` dựng lại 2026-10-21 vẫn tải nhị phân phát hành v2.11.7 (Go 1.26.8); Go 1.26.10 đã có. GO-2026-6612 = hoàn tín dụng luồng HTTP/2 hai lần ở server; GO-2026-6604 chỉ Windows (không áp dụng). Chưa có triển khai production; trước khi lên production phải có image vá hoặc tự dựng (đề xuất "Khi chạy thật" D-094). Rà 2026-10-23: Caddy chưa có bản sau v2.11.7 (master đã lên x/net 0.60.0); image `2.11.7-alpine` dựng lại 2026-10-22 vẫn tải nhị phân cũ |
| `caddy:2.11.7-alpine` — như trên | GO-2026-6603, 6605, 6607, 6608, 6609, 6610, 6611, 6613, 6617 (High) | Go 1.26.9, x/net 0.60.0 | 2026-11-01 | như trên |
| `chrislusf/seaweedfs:4.48` — Go stdlib 1.26.8, `golang.org/x/net` v0.58.0 trong `/usr/bin/weed` | GO-2026-6612 (Critical) | Go 1.26.9, x/net 0.60.0 | 2026-10-29 | S3 chỉ qua mạng nội bộ compose, không công bố cổng ra ngoài; rà 2026-10-22 (D-094): tag mới nhất vẫn 4.48 — chờ 4.49+. Rà 2026-10-23: thượng nguồn đã gắn tag `4.49` (go.mod `golang.org/x/net v0.61.0`, dựng bằng `golang:1.26-alpine`) nhưng image `chrislusf/seaweedfs:4.49` chưa có trên Docker Hub — có image thì nâng digest và gỡ các luật SeaweedFS |
| `chrislusf/seaweedfs:4.48` — như trên | GO-2026-6603, 6605, 6607, 6608, 6609, 6610, 6611, 6613, 6617 (High) | Go 1.26.9, x/net 0.60.0 | 2026-11-01 | như trên |
| `caddy:2.11.7-alpine`, `chrislusf/seaweedfs:4.48` — zlib 1.3.2-r0 (Alpine 3.23) | CVE-2026-85091 (High) | zlib 1.3.2-r1 | 2026-11-01 | Có thể sửa bằng image dẫn xuất `apk upgrade zlib`; chưa làm vì đổi cách triển khai (câu hỏi mở của PR) |
| `node:24.22.0-trixie-slim` — npm đi kèm (`/usr/local/lib/node_modules/npm`): undici 6.28.0, brace-expansion 5.0.9 | GHSA-rfgv-xxqx-mfg5, GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7 (High) | undici 6.28.1, brace-expansion 5.0.11 | 2026-11-01 | Không phải phụ thuộc của dự án; stage runtime của web/worker xoá npm (`deploy/*.Dockerfile`) nên không có trong image chạy thật |
