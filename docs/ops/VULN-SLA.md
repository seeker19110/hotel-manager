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
| 2026-11 | `pnpm audit --prod --json` và toàn workspace, cục bộ 2026-11-01 (D-139/D-142) | 0 | 3 (dev) | 1 (dev) | 0 | Production sạch sau vá glob/minimatch và fast-uri. Dev còn hai advisory extract-zip chưa có bản sửa, zod 3 và minimatch 3 của công cụ cũ; không ép qua major thiếu kiểm chứng. |

2026-11-01 (D-139/D-142): `@serwist/build` 9.5.13 vẫn ghim glob 13.0.6. Override chỉ cây này sang glob 14.0.2 + minimatch 11.0.1;
fast-uri 3.x lên 3.1.9. Build Serwist tạo manifest thành công; không đổi minimatch 3.x của Spectral/rimraf vì API khác.
Nguồn: [glob cancellation](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4),
[minimatch amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249),
[fast-uri scheme](https://github.com/advisories/GHSA-w74x-v6f9-j3xg),
[fast-uri host](https://github.com/advisories/GHSA-wjr9-j795-jxcr).
Node 24.22.2 ghim lại digest theo [chỉ mục phát hành Node](https://nodejs.org/dist/index.json); pnpm 12.16.1 cùng major vá undici bootstrap 6.29.1
(đối chiếu tarball chính thức của registry npm). `pnpm audit` gồm dev vẫn đỏ, ghi rõ phạm vi thay vì khai toàn bộ phụ thuộc sạch.

## Theo dõi (lỗ hổng chưa có bản sửa)

2026-11-01 (D-150): [GHSA-mgcc-cww5-fp2q](https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q) có bản vá go-jose/v4 v4.1.6; Caddy/SeaweedFS pin lại module từ4.1.5/4.1.4 mà giữ tag/commit upstream và Go compiler. Caddy còn liên kết go-jose/v3 v3.0.5 qua caddypki/smallstep/go.step.sm/crypto/jose; advisory ghi v3 chưa có patch. Full scan còn GHSA-mgcc-cww5-fp2q (High), [GHSA-4w3g-jfj2-cw2q](https://github.com/go-jose/go-jose/security/advisories/GHSA-4w3g-jfj2-cw2q) và [GHSA-vvm8-gf78-28g4](https://github.com/go-jose/go-jose/security/advisories/GHSA-vvm8-gf78-28g4) (đều Medium) ởv3.0.5, đều not-fixed. Theo dõi mỗi tuần, rà lại2026-11-08, không thêm ignore. Đây là phát hiện mức module; chưa chứng minh đường khai thác trên cấu hình deploy và không khai toàn bộ runtime sạch.

2026-11-01 (D-151): full scan phát hiện x/net0.61.0 có GO-2026-6866/GO-2026-6860 (severity Unknown, vá0.62.0) và chi5.3.2 có GHSA-j6qf-3m9c-vwj3 (Medium, vá5.4.0). Đã pin các bản vá tương ứng cho hai image, giữ compiler/service pins, chạy module tests và dựng/quét lại; không chờ ngưỡng High mới xử lý.

2026-11-06 (#152, AUD-DOC-007): DB grype 2026-11-06 thêm GO-2026-6865 (High, `klauspost/compress`, vá 1.20.2) và GO-2026-6888 (Critical, KEV — CVE-2026-111497 bản **Go** `andybalholm/brotli`, vá 1.2.7; bản C `brotli-libs` đã xử lý trước đó). Caddy: compress 1.20.1 → 1.20.2 (gián tiếp, go.mod). SeaweedFS (weed): compress là phụ thuộc **trực tiếp** 1.19.2 → 1.20.2 (nâng minor) và brotli 1.2.2 → 1.2.7, ghim ở bước `go get` của Dockerfile. Không đổi tag/commit dịch vụ hay Go, không thêm ignore; image-scan cả hai xanh trên cùng DB.

Bằng chứng hai image Go mới: [go-images-2026-11-01.json](evidence/go-images-2026-11-01.json). Cả hai còn ba match Medium CVE-2025-60876 ở busybox/busybox-binsh/ssl_client chưa có fixed version trong DB hiện tại; Caddy còn1High+2Medium v3 nêu trên. Không có ignore mới và không khai toàn bộ image sạch.

Hai advisory `extract-zip` (`GHSA-jmr9-qjv8-65gv`, `GHSA-7pqw-9j4j-h8q3`) qua LHCI chưa có bản sửa tại lượt rà 2026-11-01;
chỉ dùng trong công cụ CI, theo dõi khi nâng LHCI. Ngoại lệ có hạn (`.grype.yaml`) dưới đây áp dụng cho gói **đã có bản sửa
nhưng chưa nâng tương thích được**; không dùng ngoại lệ cho toàn bộ package hoặc dải phiên bản. Mỗi mã trong `.grype.yaml` phải có mặt ở bảng này
và `reason` ghi hạn rà lại; job `image-scan` (`scripts/grype-ignore-check.mjs`, mỗi PR + hằng tuần — khôi phục ở pha harden, D-091) đỏ khi quá hạn. Đến hạn: nâng image nếu đã có bản vá (gỡ luật), không thì quyết định lại.

2026-10-25 (D-110): caddy và SeaweedFS **tự dựng** từ mã nguồn (Caddy v2.11.7, SeaweedFS 4.48 commit `530be3e`) bằng Go 1.26.10 +
`golang.org/x/net` v0.61.0 trên Alpine 3.24.3 đã `apk upgrade` (`deploy/caddy/Dockerfile`, `deploy/seaweedfs/Dockerfile`) — gỡ 24 luật
(GO-2026-66xx, zlib CVE-2026-85091, brotli-libs CVE-2026-111497). Còn lại một Medium ở Caddy (`go-chi/chi` v5.3.2, GHSA-j6qf-3m9c-vwj3 —
dưới ngưỡng chặn, SLA 60 ngày; Dependabot `gomod` nâng).

2026-11-01 (D-140/D-142): web/worker chuẩn bị pnpm 12.16.1 qua Corepack rồi **xoá npm ngay ở base**, trước mọi stage build/runtime.
`node-base` của Supply chain và SBOM Release dựng đúng `deploy/web.Dockerfile --target base`; regression so base của worker giống hệt.
Grype 0.121.0 với DB v6.1.10 dựng 2026-10-31T06:18:17Z, ngưỡng high + only-fixed như CI, exit 0: base không có phát hiện đã có bản vá,
không dùng luật ignore tùy chỉnh; 159 phát hiện OS chưa có bản vá/không sửa vẫn nằm trong báo cáo. Gỡ bốn luật npm; không gia hạn.
Syft 1.55.0 nhận 105 thành phần, giấy phép 99,0%. D-148: inspect local109,6MB là số nén; CI đo tổng layer chưa nén298,5MB vượt285MB. Base nay flatten filesystem sau xoá npm, còn282678047byte (282,7MB) theo cùng số đo chưa nén; giữ native pnpm/headers, OS và ngân sách285MB. Không lấy số nén để kết luận cổng kích thước.
SBOM npm: 653 thành phần giấy phép 100%, Grype exit 0, còn một Medium minimatch 3.x và ngoại lệ zod dưới đây.
Bằng chứng và giới hạn: [supply-chain-2026-11-01.json](evidence/supply-chain-2026-11-01.json).

2026-11-01 (D-144): quét image web chứa nguyên cây builder tìm thấy compiler TypeScript 7.0.2 dùng Go 1.26.4/x/text 0.38.0,
18 High + 2 Critical có bản vá theo Grype (mức module; chưa chứng minh đường gọi khai thác). Đây là rủi ro **còn mở ở công cụ build**;
không đổi compiler, không thêm ignore, không khai builder sạch. Web chuyển sang Next standalone với tracing root của monorepo,
chỉ phân phối closure runtime và asset PWA; giữ LICENSE/notices cùng LICENSE thật của các thư viện Next đóng gói sẵn.
Image runtime web: 205 thành phần, giấy phép 99,51%; worker: 330 thành phần, 99,09%. Cả hai Grype exit 0, không có phát hiện đã có bản vá
hoặc custom ignore. Cùng đúng hai image ID đã qua startup/readiness, asset PWA, worker.started và SIGTERM exit 0 trong
[harness cục bộ dùng dữ liệu giả](evidence/local-images-2026-11-01.json); không suy diễn thành kiểm chứng production.
Nguồn cấu hình artifact: [Next standalone](https://nextjs.org/docs/app/api-reference/config/next-config-js/output).


| Image / gói | Mã (mức) | Sửa ở | Hạn rà lại | Giảm nhẹ / ghi chú |
|---|---|---|---|---|
| Phụ thuộc dev `zod` 3.25.76 (qua `@lhci/cli` → lighthouse → puppeteer-core → chromium-bidi) | GHSA-mrhx-c7xc-m3w5 (High) | zod 4.6.6 (đổi major) | 2026-11-17 | Chỉ chạy trong job `lighthouse` của CI, không vào bundle/production; zod 4.x của dự án đã ghim 4.6.7 (override). D-167 (rà 2026-11-07): `@lhci/cli` 0.16.0 (phát hành 2026-11-02) → chromium-bidi 157 khai zod ^4.6.5 (phân giải ≥ 4.6.7 nhờ override) — D-169: nâng ngày 2026-11-17 rồi gỡ luật |
