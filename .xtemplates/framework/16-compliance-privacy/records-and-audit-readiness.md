---
title: Hồ sơ tuân thủ, audit trail, bằng chứng, chính sách, đào tạo
kind: module
prefix: CMP-AUDIT
applies_to: [all]
updated: 2026-10-14
---

# Hồ sơ tuân thủ, audit trail, bằng chứng, chính sách, đào tạo

> "Tuân thủ" chỉ tồn tại khi **chứng minh được bằng hồ sơ**: kiểm toán viên, Bộ Công an, khách hàng doanh nghiệp hay
> post-mortem đều hỏi cùng câu "bằng chứng đâu, ai duyệt, khi nào". Module này quy định **hồ sơ nào phải có, ở đâu,
> sinh ra thế nào** để luôn sẵn sàng kiểm tra (audit-ready) mà không làm thủ công trước mỗi kỳ. Log bảo mật kỹ thuật ở
> [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md); bằng chứng "đã xong"
> của vòng lặp phát triển ở [`../00-method/evidence-and-sources.md`](../00-method/evidence-and-sources.md).

## Nguyên tắc

1. **Bằng chứng sinh từ hệ thống, không chép tay** (P1): ROPA từ data map, danh sách truy cập từ IdP, cấu hình từ IaC,
   kết quả kiểm từ CI — đều có ngày, hash/commit.
2. **Một kho bằng chứng, nhiều khung:** cùng một bằng chứng (vd quét lỗ hổng tháng) ánh xạ tới SOC 2 CC7, ISO 27001
   A.8.8, PCI 11.3, Luật ANM — tránh làm 4 lần.
3. **Audit trail bất biến và truy vết được:** ai, làm gì, trên gì, khi nào, từ đâu, kết quả; không sửa/xoá; thời gian
   đồng bộ.
4. **Chính sách có chủ, có phiên bản, có người đọc:** mỗi chính sách có owner, ngày rà, bằng chứng nhân sự đã xác nhận.
5. **Rà định kỳ là job, không phải lời hứa:** quyền truy cập (quý), nhà cung cấp (năm), chính sách (năm), diễn tập
   (năm) — có lịch, có ticket, có kết quả.

## Quyết định

| Nhu cầu | Khung bằng chứng nên theo | Khi nào |
|---|---|---|
| Khách hàng doanh nghiệp (B2B/SaaS) hỏi bảo mật | **SOC 2 Type II** (AICPA TSC 2017, points of focus 2022) | Thị trường Mỹ/quốc tế; cần báo cáo định kỳ 12 tháng |
| Muốn chứng chỉ được công nhận rộng | **ISO/IEC 27001:2022** (+ 27017/27018 cloud, 27701:2025 riêng tư) | Thị trường EU/châu Á, đấu thầu nhà nước |
| Thanh toán thẻ | **PCI DSS v4.0.1** (SAQ/ROC) | Bắt buộc theo hợp đồng acquirer |
| Việt Nam: dữ liệu cá nhân | Hồ sơ ĐGTĐ/chuyển dữ liệu (NĐ 356/2025), bản ghi đồng ý, biên bản kiểm tra | Mọi tổ chức xử lý dữ liệu cá nhân |
| Việt Nam: an ninh mạng/cấp độ | Hồ sơ đề xuất cấp độ, phương án bảo đảm, biên bản kiểm tra/đánh giá (Luật ANM 2025, NĐ 85/2016 + TT 12/2022 trong thời gian chuyển tiếp) | Hệ thống cơ quan nhà nước/hạ tầng quan trọng |
| AI | AI system card, hồ sơ phân loại/đánh giá (NĐ 142/2026), ISO/IEC 42001 | Có thành phần AI |
| Chưa cần chứng chỉ | **Kho bằng chứng tối thiểu** (mục Checklist 001–010) ánh xạ sẵn sang SOC 2/ISO để nâng cấp sau | Quy mô S/M |

**Mặc định khuyến nghị:** thư mục `docs/compliance/` trong repo (hoặc kho riêng) với `controls.yaml` (control → khung →
bằng chứng → owner → tần suất) và `evidence/<YYYY-MM>/` do CI/job đẩy vào; dashboard tình trạng control.

## Checklist

- [ ] `CMP-AUDIT-001` **MUST@L** Có ma trận kiểm soát `docs/compliance/controls.yaml`: mỗi control có id, mô tả, khung ánh xạ (SOC 2/ISO/PCI/luật VN), owner, tần suất, loại bằng chứng, nguồn tự động. → Kiểm: file hợp lệ schema; script liệt kê control không có bằng chứng trong kỳ. · Nguồn: ISO/IEC 27001:2022 cl. 9.2; SOC 2 CC1–CC9
- [ ] `CMP-AUDIT-002` **MUST** Audit trail cho hành động nhạy cảm (đăng nhập/đổi quyền, truy cập dữ liệu nhạy cảm, thay đổi cấu hình, triển khai, xuất dữ liệu, xử lý DSAR) ghi `who, what, target, when(UTC), where(ip/ua), result, reason`; lưu ở kho chỉ ghi thêm (append-only/WORM) với thời hạn theo luật (≥ 12 tháng NĐ 333; ≥ 6 năm HIPAA; ≥ 10 năm chứng từ kế toán). → Kiểm: schema sự kiện; test mỗi hành động trong danh sách sinh sự kiện; cấu hình immutability/retention; NTP. · Nguồn: NĐ 333/2026/NĐ-CP Đ.22–23; HIPAA §164.316(b)(2); PCI DSS v4.0.1 Req. 10
- [ ] `CMP-AUDIT-003` **MUST** Sổ hoạt động xử lý (ROPA)/sổ dữ liệu, hồ sơ ĐGTĐ, hồ sơ chuyển dữ liệu, bản ghi đồng ý và biên nhận nộp cơ quan được lưu có phiên bản tại `docs/privacy/`; cập nhật theo mốc luật (6 tháng/10 ngày NĐ 356). → Kiểm: thư mục có CHANGELOG với ngày; CI nhắc khi quá hạn cập nhật. · Nguồn: Luật 91/2025/QH15 Đ.21–22; NĐ 356/2025/NĐ-CP (chưa xác minh số điều); GDPR Art. 30
- [ ] `CMP-AUDIT-004` **MUST@L** Rà soát quyền truy cập định kỳ (≤ 90 ngày cho hệ thống production/dữ liệu nhạy cảm): danh sách người × quyền xuất tự động từ IdP/cloud, người duyệt ký, quyền thừa bị thu hồi có ticket. → Kiểm: `evidence/<kỳ>/access-review.csv` + phê duyệt; job xuất danh sách; số quyền thu hồi. · Nguồn: SOC 2 CC6.2–6.3; ISO/IEC 27001:2022 A.5.18; PCI DSS 7.2.4
- [ ] `CMP-AUDIT-005` **MUST@L** Chính sách bắt buộc có owner, phiên bản, ngày rà ≤ 12 tháng và bằng chứng nhân sự xác nhận: an toàn thông tin, bảo vệ dữ liệu cá nhân, sử dụng chấp nhận được, ứng phó sự cố, quản lý nhà cung cấp, quản lý thay đổi, sao lưu/khôi phục, phát triển an toàn, AI (nếu có). → Kiểm: `docs/policies/` có frontmatter `owner, version, reviewed_at`; CI fail khi quá 12 tháng; bảng xác nhận từ LMS/IdP. · Nguồn: ISO/IEC 27001:2022 cl. 5.2, A.5.1; SOC 2 CC1.4, CC2.2
- [ ] `CMP-AUDIT-006` **MUST@L** Bằng chứng kiểm soát kỹ thuật được CI/job tự đẩy vào kho bằng chứng theo kỳ: kết quả quét lỗ hổng/SBOM, cấu hình MFA, backup thành công, test khôi phục, scan secrets, báo cáo pentest, trạng thái patch. → Kiểm: `evidence/<YYYY-MM>/` có file do pipeline tạo (metadata commit/run id), không file chép tay. · Nguồn: SOC 2 CC7.1; ISO/IEC 27001:2022 A.8.8; PCI DSS 6.3, 11.3
- [ ] `CMP-AUDIT-007` **MUST** Quản lý nhà cung cấp/bên xử lý: sổ nhà cung cấp (dịch vụ, dữ liệu chạm, vị trí, DPA, chứng chỉ, đánh giá rủi ro, ngày rà ≤ 12 tháng); thay đổi sub-processor có thông báo. → Kiểm: `docs/privacy/processors.md` + `docs/compliance/vendors.yaml`; CI chặn phụ thuộc/SDK mới không có dòng. · Nguồn: ISO/IEC 27001:2022 A.5.19–5.22; SOC 2 CC9.2; Luật 91/2025/QH15 Đ.17
- [ ] `CMP-AUDIT-008` **MUST@L** Đào tạo nhận thức an toàn thông tin & bảo vệ dữ liệu khi gia nhập và hằng năm (thêm AI literacy khi có AI); bằng chứng hoàn thành theo người. → Kiểm: bảng hoàn thành đào tạo (export LMS) trong kho bằng chứng; tỷ lệ 100% nhân sự có quyền production. · Nguồn: ISO/IEC 27001:2022 A.6.3; SOC 2 CC1.4; PCI DSS 12.6; EU AI Act Art. 4
- [ ] `CMP-AUDIT-009` **MUST@L** Quản lý thay đổi có dấu vết: mọi thay đổi production qua PR có review + CI xanh + bản ghi triển khai (ai, khi nào, phiên bản, rollback); thay đổi khẩn có hậu kiểm. → Kiểm: branch protection bật; bản ghi deploy tự động trong kho bằng chứng; xem [`../10-workflow/ci-cd-pipeline.md`](../10-workflow/ci-cd-pipeline.md). · Nguồn: SOC 2 CC8.1; ISO/IEC 27001:2022 A.8.32; PCI DSS 6.5
- [ ] `CMP-AUDIT-010` **MUST** Sổ sự cố và vi phạm dữ liệu: mọi sự cố có bản ghi (phát hiện, phân loại, thông báo cơ quan/khách hàng với mốc giờ, khắc phục, post-mortem, hành động); diễn tập ứng phó ≥ 1 lần/năm có biên bản. → Kiểm: `docs/ops/incidents/` theo mẫu [`../templates/POST-MORTEM.md`](../templates/POST-MORTEM.md); biên bản diễn tập. · Nguồn: Luật 91/2025/QH15 Đ.23; GDPR Art. 33(5); SOC 2 CC7.4–7.5
- [ ] `CMP-AUDIT-011` **MUST@L** Kiểm toán nội bộ/independent review hằng năm theo ma trận control; phát hiện có kế hoạch khắc phục với hạn và chủ; theo dõi đến khi đóng. → Kiểm: báo cáo kiểm toán + bảng phát hiện (open/closed) trong kho bằng chứng. · Nguồn: ISO/IEC 27001:2022 cl. 9.2, 10.1; SOC 2 CC4.1
- [ ] `CMP-AUDIT-012` **MUST@L** Thời hạn lưu hồ sơ tuân thủ: bằng chứng kiểm soát ≥ 3 năm (SOC 2/ISO), chứng từ kế toán ≥ 10 năm, hồ sơ KYC theo luật PCRT, log theo luật; lịch huỷ có phê duyệt. → Kiểm: `docs/compliance/retention.yaml`; job áp dụng; biên bản huỷ. · Nguồn: Luật Kế toán 88/2015/QH13 Đ.41; Luật Lưu trữ 33/2024/QH15 Đ.15; PCI DSS 10.5.1
- [ ] `CMP-AUDIT-013` **MUST@L** Hồ sơ cấp độ an toàn hệ thống thông tin (đề xuất cấp độ, phương án bảo đảm theo cấp, quyết định phê duyệt, biên bản kiểm tra định kỳ) và hồ sơ tuân thủ ngành (NHNN, Bộ Y tế…) được duy trì và cập nhật khi kiến trúc đổi. → Kiểm: `docs/security/cap-do/` có quyết định + ngày kiểm tra gần nhất ≤ 12 tháng. · Nguồn: Luật ANM 116/2025/QH15 Đ.8, Đ.45; TT 12/2022/TT-BTTTT
- [ ] `CMP-AUDIT-014` **SHOULD** Dashboard tình trạng control (đạt/thiếu bằng chứng/quá hạn) sinh từ `controls.yaml` + kho bằng chứng; alert khi control quá hạn. → Kiểm: trang/CLI tồn tại; alert cấu hình. · Nguồn: thực hành nội bộ
- [ ] `CMP-AUDIT-015` **SHOULD** Trust center/tài liệu bảo mật cho khách hàng: kiến trúc, kiểm soát, chứng chỉ, sub-processor, lịch sử sự cố — cập nhật từ cùng nguồn với kho bằng chứng. → Kiểm: trang công khai có ngày cập nhật ≤ 90 ngày. · Nguồn: SOC 2 CC2.3
- [ ] `CMP-AUDIT-016` **SHOULD** Bằng chứng có chữ ký/hash và thời gian tin cậy (commit SHA, run id, hoặc dấu thời gian từ dịch vụ tin cậy) để chống chỉnh sửa hồi tố. → Kiểm: mỗi file bằng chứng có metadata nguồn; kiểm tra hash. · Nguồn: Luật GDĐT 20/2023/QH15 (dấu thời gian); NIST SP 800-92
- [ ] `CMP-AUDIT-017` **SHOULD** Lịch tuân thủ (calendar) tập trung: hạn nộp ĐGTĐ, cập nhật hồ sơ 6 tháng, rà quyền quý, pentest năm, gia hạn chứng chỉ, mốc luật mới — có nhắc tự động. → Kiểm: file `docs/compliance/calendar.yaml` + job nhắc. · Nguồn: thực hành nội bộ
- [ ] `CMP-AUDIT-018` **MAY** Dùng nền tảng GRC tự động thu bằng chứng (OSS: ví dụ các công cụ tự host có giấy phép OSI) thay script riêng; ghi cảnh báo telemetry/license nếu có. → Kiểm: ADR chọn công cụ với license. · Nguồn: thực hành nội bộ
- [ ] `CMP-AUDIT-019` **MAY** Mô phỏng kiểm toán (mock audit) 1 tháng trước kỳ chính thức bằng checklist của khung. → Kiểm: báo cáo mock audit. · Nguồn: thực hành nội bộ

## Bẫy thường gặp

- **Screenshot làm bằng chứng:** không có ngày/nguồn, dễ chỉnh sửa; kiểm toán viên hỏi "lấy lúc nào". Dùng export tự động có metadata.
- **Chính sách chép mẫu, không ai đọc, không có owner** → khi hỏi "ai chịu trách nhiệm" không trả lời được.
- **Rà quyền truy cập bằng cách gửi email "ai còn cần quyền thì giữ"** → không ai trả lời, không thu hồi.
- **Audit log có thể sửa bởi DBA** → không phải audit trail.
- **Mỗi khung một bộ hồ sơ riêng** → tốn gấp 3–4 lần, mâu thuẫn nhau.
- **Diễn tập sự cố chỉ là họp** không có kịch bản, mốc giờ, biên bản.
- **Bằng chứng nằm trong tài khoản cá nhân** (Drive, Notion riêng) → mất khi người nghỉ.
- **Quên thời hạn cập nhật hồ sơ NĐ 356 (6 tháng/10 ngày)** vì không có lịch.

## Cổng tự động

| Việc kiểm | Công cụ | Lệnh/cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Control thiếu bằng chứng trong kỳ | Script đọc `controls.yaml` + `evidence/` | `python scripts/compliance/check-evidence.py --period 2026-10` | CI nightly | 0 control quá hạn |
| Chính sách quá hạn rà | Lint frontmatter `reviewed_at` | script | CI | 0 quá 12 tháng |
| Rà quyền truy cập | Export IdP/cloud IAM (API) → CSV | job quý | Job | file + phê duyệt |
| Bằng chứng kỹ thuật tự đẩy | CI job upload (SBOM syft v1.54.0 Apache-2.0, OSV-Scanner, gitleaks v8.30.1 MIT — xác minh 2026-10-13) | sau mỗi scan | CI | metadata run id |
| Audit log bất biến | Kiểm cấu hình kho log (object lock/WORM) | conftest | CI | pass |
| Lịch tuân thủ | Job đọc `calendar.yaml` → nhắc | cron | Job | nhắc trước 30/7/1 ngày |

## Nguồn

- ISO/IEC 27001:2022 (bản 2013 hết chuyển tiếp 31/10/2025): <https://www.iso.org/standard/27001>; ISO/IEC 27701:2025: <https://www.iso.org/standard/27701> — xác minh 2026-10-13.
- AICPA SOC 2 — Trust Services Criteria 2017 (revised points of focus 2022, TSP Section 100): <https://www.aicpa-cima.com/> — (chưa xác minh trực tiếp tài liệu ngày 2026-10-13; xác nhận qua nguồn thứ cấp).
- PCI DSS v4.0.1 Req. 6, 7, 10, 11, 12: <https://www.pcisecuritystandards.org/document_library/> — xác minh 2026-10-13.
- Luật BVDLCN 91/2025/QH15 Đ.17, Đ.21–23: <https://vanban.chinhphu.vn/?pageid=27160&docid=214590>; NĐ 356/2025/NĐ-CP (thay NĐ 13/2023 từ 01/01/2026): <https://vanban.chinhphu.vn/?pageid=27160&docid=216387> — xác minh 2026-10-13; kiểm tra văn bản sửa đổi trước khi áp dụng.
- NĐ 333/2026/NĐ-CP Đ.22–23 (log ≥ 12 tháng): Công báo 499 — <https://congbaocdn.chinhphu.vn/180507251028987904/2026/9/4/470335-1787890927_v1_1788486330_signed.pdf> — xác minh 2026-10-13.
- Luật Kế toán 88/2015/QH13 Đ.41: <https://hethongphapluat.com/luat-ke-toan-2015/dieu-41>; Luật Lưu trữ 33/2024/QH15 (hiệu lực 01/07/2025): <https://hethongphapluat.com/luat-luu-tru-2024.html> — xác minh 2026-10-13.
- HIPAA 45 CFR §164.316 (lưu tài liệu 6 năm): <https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html> — xác minh 2026-10-13.
- gitleaks v8.30.1, syft v1.54.0: <https://github.com/gitleaks/gitleaks/releases>, <https://github.com/anchore/syft/releases> — xác minh 2026-10-13 (qua kết quả tìm kiếm GitHub).
- Nghiên cứu nền: `research/2026-10-13-stored-catalog-extraction.md` §2.14 (bằng chứng tách khỏi tuyên bố, `docs/bang-chung/<ngày>/`).
