---
title: License mã nguồn mở, IP, dữ liệu huấn luyện, thương hiệu, điều khoản dịch vụ
kind: module
prefix: CMP-LIC
applies_to: [all]
updated: 2026-10-16
---

# License mã nguồn mở, IP, dữ liệu huấn luyện, thương hiệu, điều khoản dịch vụ

> Mọi dòng code, model, dataset, font, icon, ảnh trong sản phẩm đều có **chủ sở hữu và điều kiện sử dụng**. Module này
> là "nhà" của license/IP trong khung: chính sách license cho phụ thuộc, SBOM + cổng license, license cho model/dữ
> liệu AI, bản quyền đầu ra AI, thương hiệu, điều khoản dịch vụ, và license của chính sản phẩm. Quy trình mở nguồn
> (đóng góp, cộng đồng) ở [`../18-cross-cutting/open-source-and-community.md`](../18-cross-cutting/open-source-and-community.md);
> chuỗi cung ứng/SBOM kỹ thuật ở [`../12-security/supply-chain.md`](../12-security/supply-chain.md).

## Nguyên tắc

1. **Không có LICENSE = không có quyền dùng.** Repo/model/dataset không ghi license → mặc định "all rights reserved";
   không đưa vào sản phẩm (bài học catalog: nhiều repo "awesome" không có LICENSE).
2. **Chính sách license là file, cổng máy chặn:** allow/deny list theo SPDX id, ngoại lệ có `approved_by` và `expires`.
3. **Copyleft mạnh (GPL/AGPL) không tự động xấu** — nhưng phải quyết định có ý thức: AGPL trên dịch vụ mạng kéo theo
   nghĩa vụ mở mã nguồn phía server; "source-available" (BSL, SSPL, ELv2) **không phải OSS** theo OSI.
4. **Model và dữ liệu có license riêng:** license code (Apache-2.0) ≠ license trọng số (vd Llama Community License,
   OpenRAIL) ≠ license dataset (CC BY-NC cấm thương mại); huấn luyện trên tác phẩm có bản quyền ở VN được phép có
   điều kiện từ 01/04/2026 (Luật 131/2025) nhưng vẫn phải tôn trọng EU (AI Act Art. 53(1)(c), opt-out TDM).
5. **Đầu ra AI chưa chắc có bản quyền** và có thể trùng tác phẩm có bản quyền — không dùng làm tài sản cốt lõi mà
   không rà.
6. **Điều khoản dịch vụ là hợp đồng:** phải khớp với luật người tiêu dùng (VN Luật 19/2023; NĐ 55/2024 về hợp đồng mẫu)
   và không mâu thuẫn privacy notice.

## Quyết định

| Tình huống | Quyết định mặc định | Khi nào khác |
|---|---|---|
| License của chính sản phẩm (mở nguồn) | **Apache-2.0** (có grant bằng sáng chế) hoặc MIT khi muốn tối giản | Muốn chống "cloud lấy không": AGPL-3.0 (OSI) — **không** chọn BSL/SSPL nếu muốn được gọi là OSS |
| Phụ thuộc trong dịch vụ web/SaaS (không phân phối) | Cho phép: MIT, BSD, Apache-2.0, ISC, MPL-2.0, LGPL (dynamic), CC0; **xem xét**: GPL (nếu không phân phối thì ok, nhưng ràng buộc tương lai); **cấm mặc định**: AGPL, SSPL, BSL, "no license", CC BY-NC | Có luật sư duyệt → ngoại lệ có hạn |
| Phụ thuộc trong app phân phối (mobile/desktop/SDK/embedded) | Như trên nhưng **GPL/LGPL static** → cấm mặc định (kéo theo mở mã) | Mở nguồn toàn bộ app |
| Model trọng số | Chỉ model có license ghi rõ dùng thương mại (Apache-2.0, MIT, OpenRAIL-M có điều kiện, Llama Community với điều kiện quy mô) | Nghiên cứu nội bộ: NC được, nhưng không lọt vào production |
| Dataset | Có license và nguồn gốc (provenance); CC BY/CC0/ODbL theo nghĩa vụ ghi công; tôn trọng robots/TDM opt-out | Dữ liệu cá nhân → thêm [`privacy-by-design.md`](privacy-by-design.md) |
| Font/icon/ảnh | SIL OFL, CC BY/CC0, license mua có hoá đơn | Stock "miễn phí" không rõ license → không dùng |
| Đầu ra AI (code/ảnh/văn bản) | Rà trùng lặp (code: so với snippet license GPL; ảnh: không nhân vật/logo có bản quyền); ghi "có hỗ trợ AI" khi cần | Cần tài sản IP mạnh → người làm, AI hỗ trợ |

**Mặc định khuyến nghị:** `license-policy.yaml` (allow/deny/review + exceptions) → SBOM (syft/CycloneDX hoặc SPDX)
→ cổng license trong CI; REUSE spec 3.3 cho header/`LICENSES/` trong repo mở.

## Checklist

- [ ] `CMP-LIC-001` **MUST** Sản phẩm có file `LICENSE` (mở nguồn: license OSI; nội bộ: ghi "proprietary" + chủ sở hữu) và `NOTICE`/`THIRD_PARTY_NOTICES` sinh tự động từ SBOM cho phụ thuộc yêu cầu ghi công. → Kiểm: file tồn tại; CI sinh NOTICE và diff = 0. · Nguồn: Apache-2.0 §4(d); MIT; BSD-3-Clause; Luật SHTT 50/2005/QH11 (sửa đổi 2022, 2025)
- [ ] `CMP-LIC-002` **MUST** Chính sách license phụ thuộc dạng file (`license-policy.yaml`: allow/deny/review theo SPDX id; ngoại lệ có `package, reason, approved_by, expires`); cổng CI chặn license cấm hoặc không xác định. → Kiểm: job CI chạy license check trên lockfile/SBOM; PR thêm gói AGPL/unknown bị chặn; ngoại lệ hết hạn → fail. · Nguồn: SPDX License List 3.29.0 (16/09/2026); OSI Approved Licenses; `research/…catalog-extraction.md` §2.6
- [ ] `CMP-LIC-003` **MUST** SBOM (CycloneDX hoặc SPDX) sinh mỗi build cho mọi thành phần (code, container, model) với trường license; lưu cùng artifact phát hành. → Kiểm: artifact có `sbom.cdx.json`/`.spdx.json`; license không null ≥ 99%; xem [`../12-security/supply-chain.md`](../12-security/supply-chain.md). · Nguồn: NTIA Minimum Elements for SBOM; CycloneDX 1.7 (ECMA-424); SPDX 3.0 (phiên bản theo nhà [`../12-security/supply-chain.md`](../12-security/supply-chain.md))
- [ ] `CMP-LIC-004` **MUST** Không dùng gói/model/dataset/asset không có license rõ ràng; "source-available" (BSL, SSPL, ELv2, Commons Clause) được phân loại riêng và chỉ dùng với quyết định có ghi. → Kiểm: SBOM không có `NOASSERTION`/`UNKNOWN` ngoài danh sách ngoại lệ; ADR cho mỗi thành phần source-available. · Nguồn: OSI Open Source Definition; Elastic License 2.0; SSPL
- [ ] `CMP-LIC-005` **MUST@L** Model AI dùng trong sản phẩm có license trọng số cho phép mục đích thương mại và điều kiện (quy mô người dùng, ghi công, use policy) được ghi trong `docs/ai/<tên>.md`; dataset huấn luyện/fine-tune có license + nguồn gốc. → Kiểm: system card có mục License với SPDX/URL; CI kiểm trường không rỗng. · Nguồn: EU AI Act Art. 53(1)(c)–(d); Luật SHTT sửa đổi 131/2025/QH15 (TDM cho AI, hiệu lực 01/04/2026)
- [ ] `CMP-LIC-006` **MUST@L** Dữ liệu thu thập để huấn luyện tôn trọng điều khoản nguồn, robots.txt/TDM opt-out (EU) và không chứa dữ liệu cá nhân trái mục đích; nguồn gốc (provenance) ghi theo dataset. → Kiểm: crawler log tuân thủ robots; `datasets/<tên>/PROVENANCE.md`; quét PII. · Nguồn: Directive (EU) 2019/790 Art. 4; EU AI Act Art. 53(1)(c); Luật 91/2025/QH15 Đ.30
- [ ] `CMP-LIC-007` **MUST@L** Code/ảnh/văn bản do AI sinh được rà trước khi đưa vào sản phẩm: so trùng snippet với mã có license copyleft/không tương thích; ảnh không chứa logo/nhân vật/người thật nhận diện được. → Kiểm: quét trùng (vd ScanCode trên diff) trong CI cho PR gắn nhãn `ai-generated`; checklist review. · Nguồn: thực hành pháp lý; Luật SHTT (quyền tác giả cần tác giả là con người — chưa xác minh điều khoản 2025)
- [ ] `CMP-LIC-008` **MUST@L** Điều khoản dịch vụ (ToS) và privacy notice có phiên bản, ngày hiệu lực, lưu phiên bản người dùng chấp nhận; nội dung khớp luật người tiêu dùng (hợp đồng mẫu/điều kiện giao dịch chung, quyền huỷ, trách nhiệm) và không mâu thuẫn data map. → Kiểm: `terms_version` trong bảng chấp nhận; checklist đối chiếu NĐ 55/2024 đã ký bởi pháp chế. · Nguồn: Luật BVQLNTD 19/2023/QH15; NĐ 55/2024/NĐ-CP; Luật GDĐT 20/2023/QH15 (hợp đồng điện tử)
- [ ] `CMP-LIC-009` **MUST@L** Thương hiệu: tên sản phẩm/logo đã tra cứu khả năng đăng ký (VN: Cục SHTT; quốc tế: WIPO/Madrid) trước khi ra mắt; không dùng tên miền/tên giống cơ quan báo chí, tổ chức khác. → Kiểm: biên bản tra cứu; đơn đăng ký (nếu M/L). · Nguồn: Luật SHTT Phần III; NĐ 147/2024/NĐ-CP Đ.36 k.7 (tên tài khoản/kênh)
- [ ] `CMP-LIC-010` **MUST@L** Hợp đồng với nhân sự/đối tác/freelancer có điều khoản chuyển giao IP và bảo mật; đóng góp từ ngoài qua DCO hoặc CLA (repo mở). → Kiểm: mẫu hợp đồng có điều khoản; DCO check trong CI cho PR ngoài. · Nguồn: Luật SHTT Đ.39 (quyền tác giả theo hợp đồng); Developer Certificate of Origin 1.1
- [ ] `CMP-LIC-011` **MUST@L** Nghĩa vụ copyleft (nếu dùng GPL/LGPL/MPL): giữ nguyên thông báo, cung cấp mã nguồn tương ứng theo yêu cầu, tách module theo license; app phân phối có màn "Giấy phép mã nguồn mở". → Kiểm: NOTICE đầy đủ; màn hình license trong app; tài liệu cách lấy mã nguồn. · Nguồn: GPL-3.0 §6; LGPL-3.0 §4; MPL-2.0 §3
- [ ] `CMP-LIC-012` **SHOULD** Repo mở nguồn theo REUSE spec 3.3: `LICENSES/` chứa văn bản SPDX, header `SPDX-License-Identifier` hoặc `REUSE.toml`; `reuse lint` xanh. → Kiểm: `reuse lint` trong CI. · Nguồn: REUSE Specification 3.3 (14/11/2024)
- [ ] `CMP-LIC-013` **SHOULD** Rà license định kỳ (≤ 90 ngày) vì license gói có thể đổi giữa các phiên bản (vd chuyển sang BSL/SSPL); cảnh báo khi license của gói trong lockfile thay đổi so với lần trước. → Kiểm: job so SBOM kỳ trước ↔ kỳ này; diff license → issue. · Nguồn: `research/…catalog-extraction.md` §3 (bẫy license không OSI; Redis/Elastic/HashiCorp đổi license — ghi nhận ngành)
- [ ] `CMP-LIC-014` **SHOULD** Phân loại tài sản IP của sản phẩm (mã, model, dữ liệu, thương hiệu, bí mật kinh doanh) với chủ sở hữu và biện pháp bảo vệ (secret/NDA/đăng ký). → Kiểm: `docs/legal/ip-register.md`. · Nguồn: Luật SHTT; thực hành nội bộ
- [ ] `CMP-LIC-015` **SHOULD** Nội dung người dùng tạo (UGC): ToS ghi rõ quyền sử dụng cấp cho nền tảng (giới hạn mục đích), quy trình xử lý khiếu nại bản quyền (notice-and-takedown) có SLA; không dùng UGC huấn luyện AI nếu ToS không nói. → Kiểm: mục ToS; luồng khiếu nại có ticket; cờ `training_opt_in`. · Nguồn: Luật SHTT sửa đổi 07/2022/QH15 (trách nhiệm ISP); NĐ 147/2024/NĐ-CP; DMCA 17 U.S.C. §512; DSA Art. 16
- [ ] `CMP-LIC-016` **SHOULD** Ghi công theo yêu cầu license (CC BY, Apache NOTICE, OFL) ở nơi người dùng thấy được (trang "Giấy phép"/about). → Kiểm: trang tồn tại, sinh từ NOTICE. · Nguồn: CC BY 4.0 §3(a); Apache-2.0 §4
- [ ] `CMP-LIC-017` **MAY** Dùng dịch vụ quét license/IP sâu (ScanCode toolkit, FOSSology) cho release lớn ngoài cổng CI nhanh. → Kiểm: báo cáo scan đính kèm release. · Nguồn: ScanCode toolkit 32.5.0 (Apache-2.0, xác minh PyPI 2026-10-13)
- [ ] `CMP-LIC-018` **MAY** Chứng nhận OpenChain (ISO/IEC 5230) cho chương trình tuân thủ OSS. → Kiểm: tự đánh giá OpenChain. · Nguồn: ISO/IEC 5230:2020 (chưa xác minh phiên bản ngày 2026-10-13)
- [ ] `CMP-LIC-019` **SHOULD** Dependency từng **đổi license** (nhất là copyleft → dễ dãi) trên mã có nhiều tác giả mà không có CLA/DCO: coi lần đổi là rủi ro chưa xác minh; dùng theo license chặt hơn (hoặc bản trước khi đổi) cho tới khi repo ghi bằng chứng đã xin đồng ý người giữ bản quyền. → Kiểm: PR thêm dependency ghi `git log --follow -- LICENSE*` và có/không CLA/DCO; ngoại lệ trong `license-policy.yaml` có `reason`. · Nguồn: `seeker19110/stored` 19 §1b (OpenCreator: GPL-3.0 → Apache-2.0, 22 tác giả, không CLA/DCO)
- [ ] `CMP-LIC-020` **SHOULD** License của model/trọng số lấy từ **model card (hoặc LICENSE) của đúng repo** đang dùng, ghi **revision (commit hash)** và kích thước/biến thể đang dùng — không suy từ license của mã hay README; ghim revision khi tải; ghi điều kiện về doanh thu, lãnh thổ, đầu ra; đổi revision hoặc kích thước thì duyệt lại. → Kiểm: `docs/ai/<model>.md` có `revision`, `license_source_url`, `conditions`; loader ghim `revision=<sha>`. · Nguồn: `seeker19110/stored` 14 §3b (Audio8: README Apache-2.0 nhưng weights 0.1B theo Community License, trần doanh thu US$2M/năm), 14 §5b (Hunyuan3D 2.1 hạn chế lãnh thổ EU/UK/KR gồm output — (chưa xác minh), stored gắn `[UNVERIFIED]`), 18 §4c (PhoBERT base MIT, base-v2 AGPL-3.0); đọc 2026-10-16

## Bẫy thường gặp

- **"Trên GitHub public là được dùng":** không có LICENSE = không có quyền.
- **Gói MIT nhưng kéo phụ thuộc bắc cầu AGPL** → cổng phải quét toàn cây, không chỉ dependencies trực tiếp.
- **Model "open" nhưng license cấm thương mại hoặc giới hạn ngành** (NC, use-restriction).
- **Dataset Kaggle/HF không license** hoặc chứa dữ liệu cá nhân/bản quyền → sản phẩm thừa hưởng rủi ro.
- **Code AI sinh ra trùng đoạn GPL** → rủi ro nhiễm license; rà bằng scanner.
- **ToS nói "chúng tôi có thể dùng dữ liệu của bạn cho mọi mục đích"** → vô hiệu theo luật người tiêu dùng VN/EU và mâu thuẫn Luật 91/2025.
- **Đổi license gói giữa chừng** (Redis, Elastic, Terraform đã từng) → lockfile cũ ok, nâng phiên bản là vi phạm.
- **Font "free for personal use"** trong sản phẩm thương mại.
- **License của mã ≠ license của weights:** README ghi Apache-2.0 nhưng weights từng kích thước/revision theo license riêng (trần doanh thu, cấm lãnh thổ/đầu ra); cùng họ model, bản v2 đổi MIT → AGPL-3.0. Đọc model card đúng repo + revision (`CMP-LIC-020`).

## Cổng tự động

| Việc kiểm | Công cụ (giấy phép; xác minh 2026-10-13) | Lệnh/cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| SBOM + license | syft v1.54.0 (Apache-2.0) hoặc `@cyclonedx/cyclonedx-npm` 6.0.1 (Apache-2.0) | `syft dir:. -o cyclonedx-json > sbom.cdx.json` | CI build | license null ≤ 1% |
| Cổng license JS/TS | `license-checker-rseidelsohn` 5.0.1 (BSD-3-Clause) | `license-checker-rseidelsohn --failOn "AGPL-3.0;SSPL-1.0;UNLICENSED"` | CI (PR) | 0 vi phạm |
| Cổng license Python | `pip-licenses` 5.5.5 (MIT) | `pip-licenses --fail-on="AGPL-3.0-only;AGPL-3.0-or-later"` | CI | 0 |
| Cổng license Rust/Go | `cargo-deny` (MIT/Apache-2.0) · `go-licenses` (Apache-2.0) — (chưa xác minh phiên bản: GitHub API trả 403 ngày 2026-10-13) | `cargo deny check licenses` · `go-licenses check ./...` | CI | 0 |
| Policy-as-code trên SBOM | OPA/conftest (Apache-2.0) với `license-policy.yaml` | `conftest test sbom.cdx.json -p policy/license.rego` | CI | 0; ngoại lệ hết hạn = fail |
| Quét sâu/trùng mã | ScanCode toolkit 32.5.0 (Apache-2.0 AND CC-BY-4.0) · FOSSology (GPL-2.0) | `scancode -clpieu --json out.json .` | Release | báo cáo đính kèm |
| REUSE | `reuse` 6.2.0 (Apache-2.0 AND GPL-3.0-or-later cho tool) | `reuse lint` | CI | pass |
| DCO | DCO GitHub App / `commit --signoff` check | CI | PR ngoài | pass |
| License model/trọng số | test đọc `docs/ai/<model>.md` + grep loader | kiểm có `revision`, `license_source_url`, `conditions` và `revision=` được ghim | CI (PR đổi model) | thiếu trường hoặc revision không ghim = đỏ |

## Nguồn

- SPDX License List 3.29.0 (16/09/2026): <https://spdx.org/licenses/> — xác minh 2026-10-13.
- OSI Open Source Definition & Approved Licenses: <https://opensource.org/osd> — (chưa xác minh truy cập ngày 2026-10-13).
- REUSE Specification 3.3 (14/11/2024): <https://reuse.software/spec/> — xác minh 2026-10-13 (trang spec), ngày qua thông báo FSFE.
- Luật Sở hữu trí tuệ sửa đổi 131/2025/QH15 (10/12/2025, hiệu lực 01/04/2026; TDM cho huấn luyện AI): <https://thuvienphapluat.vn/van-ban/So-huu-tri-tue/Law-131-2025-QH15-amendments-to-the-Law-on-Intellectual-Property-700208.aspx> và WIPO Lex <https://www.wipo.int/wipolex/en/legislation/details/23828> — xác minh 2026-10-13; Luật 07/2022/QH15 (hiệu lực 01/01/2023 — chưa xác minh). Kiểm tra văn bản sửa đổi trước khi áp dụng.
- Luật BVQLNTD 19/2023/QH15 và NĐ 55/2024/NĐ-CP (hợp đồng mẫu, hiệu lực 01/07/2024): <https://moit.gov.vn/tin-tuc/bao-chi-voi-nguoi-dan/cac-van-ban-quy-pham-phap-luat-ve-bao-ve-quyen-loi-nguoi-tieu-dung-co-hieu-luc-tu-ngay-01-7-2024.html> — xác minh 2026-10-13.
- NĐ 147/2024/NĐ-CP (25/12/2024) Đ.36: <https://lsvn.vn/quy-dinh-moi-ve-quan-ly-trang-thong-tin-dien-tu-mang-xa-hoi-a150603.html> — nguồn thứ cấp, 2026-10-13.
- EU AI Act Art. 53 (GPAI: bản quyền, tóm tắt dữ liệu): xem [`ai-regulation.md`](ai-regulation.md); Directive (EU) 2019/790 Art. 4 (TDM opt-out) — (chưa xác minh trực tiếp EUR-Lex ngày 2026-10-13).
- Phiên bản công cụ (registry, 2026-10-13): scancode-toolkit 32.5.0 <https://pypi.org/pypi/scancode-toolkit/json>; pip-licenses 5.5.5 <https://pypi.org/pypi/pip-licenses/json>; reuse 6.2.0 <https://pypi.org/pypi/reuse/json>; license-checker-rseidelsohn 5.0.1 <https://registry.npmjs.org/license-checker-rseidelsohn/latest>; @cyclonedx/cyclonedx-npm 6.0.1 <https://registry.npmjs.org/@cyclonedx/cyclonedx-npm/latest>; syft v1.54.0 <https://github.com/anchore/syft/releases>.
- Nghiên cứu nền: `research/2026-10-13-stored-catalog-extraction.md` §2.6 (SBOM + cổng license, exception có `approved_by`/`expires`), §3 (bẫy license không OSI, repo không LICENSE).
- Catalog `seeker19110/stored` 19 §1b (OpenCreator/KrillinAI đổi GPL-3.0 → Apache-2.0 trên mã nhiều tác giả, không CLA/DCO) — đọc 2026-10-15.
- Catalog `seeker19110/stored` 14 §3b (Audio8 0.1B Community License), §5b (Hunyuan3D — (chưa xác minh)), 18 §4c (PhoBERT base MIT vs base-v2 AGPL-3.0) — đọc 2026-10-16; model card từng repo chưa tra lại trực tiếp (chưa xác minh).
