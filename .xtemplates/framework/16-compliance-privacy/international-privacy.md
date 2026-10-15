---
title: Quốc tế: GDPR, UK GDPR, CCPA/CPRA, PDPA (SG/TH), chuyển dữ liệu xuyên biên giới
kind: module
prefix: CMP-INTL
applies_to: [all]
updated: 2026-10-14
---

# Quốc tế: GDPR, UK GDPR, CCPA/CPRA, PDPA (SG/TH), chuyển dữ liệu xuyên biên giới

> Khi sản phẩm có người dùng, máy chủ, nhà cung cấp hoặc khách hàng ở **ngoài Việt Nam**, luật nơi đó áp dụng thêm —
> không thay — luật Việt Nam ([`vietnam-data-law.md`](vietnam-data-law.md)). Module này cho bảng **áp dụng khi nào,
> khác gì, phải làm gì** của 5 khung hay gặp nhất và cơ chế chuyển dữ liệu xuyên biên giới. Luồng đồng ý/quyền ở
> [`consent-and-user-rights.md`](consent-and-user-rights.md).

## Nguyên tắc

1. **Luật đi theo người dùng, không theo máy chủ:** GDPR áp dụng khi bạn cung cấp dịch vụ cho người ở EU hoặc theo
   dõi hành vi của họ (Art. 3(2)), dù công ty ở Việt Nam.
2. **Chọn khung nghiêm nhất làm mặc định kỹ thuật** (thường GDPR + Luật 91/2025) rồi bật khác biệt theo vùng bằng cấu
   hình, thay vì xây nhiều luồng.
3. **Chuyển dữ liệu xuyên biên giới là sự kiện cần hồ sơ ở cả hai đầu:** đầu VN (hồ sơ chuyển dữ liệu), đầu EU/UK
   (SCC/IDTA + transfer impact assessment), SG (điều kiện tương đương), TH (hợp đồng theo PDPC).
4. **Thời hạn thông báo vi phạm khác nhau** — lấy thời hạn ngắn nhất áp dụng làm SLA kỹ thuật: SG 3 ngày lịch sau khi
   xác định; VN/EU/TH 72 giờ; US HIPAA 60 ngày; CCPA theo luật tiểu bang.
5. **Không khai "tuân thủ GDPR" khi chưa có:** ROPA, cơ sở pháp lý, DPA với bên xử lý, đại diện EU (Art. 27) nếu không có
   cơ sở tại EU.

## Quyết định

| Câu hỏi | Có → khung áp dụng | Việc tối thiểu phải làm |
|---|---|---|
| Người dùng/khách hàng ở EU/EEA? | **GDPR 2016/679** (áp dụng 25/05/2018) | Cơ sở pháp lý Art. 6; ROPA Art. 30; DPA Art. 28; quyền 1 tháng; vi phạm 72 h (Art. 33); DPIA Art. 35; đại diện EU Art. 27; chuyển dữ liệu Chương V |
| Người dùng ở Anh? | **UK GDPR + Data Protection Act 2018**, sửa bởi **Data (Use and Access) Act 2025** (c. 18, 19/06/2025, hiệu lực theo giai đoạn 2025–2026) | Như GDPR; chuyển dữ liệu dùng IDTA/Addendum; theo dõi các điều DUAA đã có hiệu lực (ICO) |
| Người dùng ở California (doanh thu > $25M, hoặc ≥ 100k người, hoặc ≥ 50% doanh thu từ bán dữ liệu)? | **CCPA/CPRA** (Cal. Civ. Code §1798.100+) + quy định CPPA 2025 (hiệu lực 01/01/2026; ADMT 01/01/2027; risk assessment attestation 01/04/2028; cybersecurity audit 2028–2030 theo doanh thu) | "Do Not Sell/Share" + GPC; thông báo khi thu thập; quyền xoá/sửa/biết; hợp đồng service provider |
| Người dùng ở Singapore? | **PDPA 2012** (sửa 2020; vi phạm ≤ 3 ngày lịch từ 01/02/2021; phạt tới 10% doanh thu SG hoặc S$1M từ 01/10/2022) | Thông báo + đồng ý; DPO bắt buộc; không dùng NRIC để xác thực từ 01/01/2027 (chưa xác minh) |
| Người dùng ở Thái Lan? | **PDPA B.E. 2562 (2019)**, hiệu lực đầy đủ 01/06/2022 | Cơ sở pháp lý; vi phạm 72 h (s.37(4), thông báo PDPC 15/12/2022); DPO khi quy mô lớn |
| Khách hàng doanh nghiệp EU trong tài chính/y tế? | Thêm **DORA 2022/2554** (17/01/2025), **NIS2 2022/2555**, **EHDS 2025/327** | Hợp đồng ICT third-party; báo cáo sự cố |
| Dữ liệu chuyển EU → VN? | Chương V GDPR: VN **chưa có quyết định tương xứng** (adequacy) | SCC 2021/914 + Transfer Impact Assessment; hoặc BCR |

**Mặc định khuyến nghị:** một "privacy config" theo vùng (`region → {breach_sla_hours, dsar_days, min_age, gpc,
transfer_mechanism}`) nạp từ file, code chung; test theo bảng vùng.

## Bảng so sánh nhanh (xác minh 2026-10-13)

| Tiêu chí | GDPR (EU) | UK GDPR/DUAA 2025 | CCPA/CPRA | PDPA SG | PDPA TH | VN 91/2025 |
|---|---|---|---|---|---|---|
| Thông báo vi phạm cho cơ quan | 72 h (Art. 33) | 72 h | Theo luật breach bang CA (không có hạn giờ chung) | ≤ 3 ngày lịch sau khi xác định (s.26D) | 72 h (s.37(4)) | 72 h (Đ.23) |
| Thời hạn trả lời quyền | 1 tháng (+2) | 1 tháng | 45 ngày (+45) | 30 ngày | 30 ngày | theo NĐ 356 (chưa xác minh số điều) |
| Tuổi đồng ý trẻ em | 16 (quốc gia có thể hạ tới 13) | 13 | 13 (COPPA); 16 cho bán dữ liệu | — (phụ huynh cho < 13 theo hướng dẫn) | 10 (minor) | < 16 trẻ em; ≥ 7 được hỏi |
| DPIA/đánh giá rủi ro | Art. 35 | Art. 35 | Risk assessment (regs 2025) | — | DPIA theo hướng dẫn | Đ.21 + nộp A05 60 ngày |
| Phạt tối đa | 4% doanh thu toàn cầu/€20M | £17.5M/4% | $2.663/vi phạm ($7.988 cố ý; chỉ số CPI) | 10% doanh thu SG/S$1M | 5M THB + hình sự | 5% doanh thu/10× khoản thu/3 tỷ đ |
| Chuyển xuyên biên giới | Adequacy/SCC/BCR | IDTA/Addendum | — | Điều kiện tương đương (s.26) | Hợp đồng/BCR theo PDPC | Hồ sơ chuyển + A05 |

## Checklist

- [ ] `CMP-INTL-001` **MUST@L** Xác định tập pháp luật áp dụng theo thị trường (người dùng, khách hàng, máy chủ, nhà cung cấp) và ghi vào `docs/privacy/jurisdictions.md` với lý do; rà lại mỗi khi mở thị trường mới. → Kiểm: file tồn tại, có ngày rà; PR mở vùng mới (i18n/region) phải cập nhật. · Nguồn: GDPR Art. 3; CCPA §1798.140; PDPA SG s.2
- [ ] `CMP-INTL-002` **MUST** Mỗi hoạt động xử lý có cơ sở pháp lý ghi trong data map (`legal_basis` theo GDPR Art. 6/9; `consent`/`contract`/`legal_obligation`/…); không có → không xử lý. → Kiểm: lint data map bắt buộc `legal_basis`; dữ liệu nhạy cảm phải có cơ sở Art. 9. · Nguồn: GDPR Art. 6, 9; Luật 91/2025/QH15 Đ.19
- [ ] `CMP-INTL-003` **MUST@L** Sổ hoạt động xử lý (ROPA, Art. 30) sinh từ data map và cập nhật cùng PR; bao gồm bên xử lý, nơi lưu, cơ chế chuyển. → Kiểm: script sinh `docs/privacy/ROPA.md` từ `data-map.yaml`; CI diff = 0. · Nguồn: GDPR Art. 30; UK GDPR Art. 30
- [ ] `CMP-INTL-004` **MUST@L** Hợp đồng xử lý dữ liệu (DPA) với mọi bên xử lý theo Art. 28 (chỉ thị, bảo mật, sub-processor được duyệt, hỗ trợ DSAR, xoá/trả, kiểm toán); danh sách sub-processor công khai. → Kiểm: `docs/privacy/processors.md` link DPA cho từng nhà cung cấp; CI chặn SDK mới chưa có dòng. · Nguồn: GDPR Art. 28; CCPA §1798.100(d)
- [ ] `CMP-INTL-005` **MUST** Chuyển dữ liệu từ EU/UK ra ngoài (kể cả về VN) có cơ chế hợp lệ: SCC 2021/914 (EU) hoặc IDTA/Addendum (UK) + Transfer Impact Assessment; không có adequacy cho VN. → Kiểm: `docs/privacy/transfers.md` liệt kê từng luồng với cơ chế + TIA; test cấu hình vùng lưu trữ. · Nguồn: GDPR Art. 44–46; Commission Decision (EU) 2021/914
- [ ] `CMP-INTL-006` **MUST** SLA kỹ thuật thông báo vi phạm = thời hạn ngắn nhất áp dụng (SG 3 ngày lịch sau xác định; EU/VN/TH 72 giờ); runbook có bảng thời hạn theo vùng và mẫu thông báo. → Kiểm: `docs/ops/runbooks/data-breach.md` có bảng vùng; diễn tập hằng năm. · Nguồn: GDPR Art. 33; PDPA SG s.26D; PDPA TH s.37(4); Luật 91/2025/QH15 Đ.23
- [ ] `CMP-INTL-007` **MUST** Thời hạn trả lời DSAR cấu hình theo vùng (EU/UK 1 tháng, CA 45 ngày, SG/TH 30 ngày, VN theo NĐ 356) và theo dõi quá hạn. → Kiểm: cấu hình `dsar_days` theo vùng; metric quá hạn = 0. · Nguồn: GDPR Art. 12(3); CCPA §1798.130; PDPA SG s.21
- [ ] `CMP-INTL-008` **MUST@L** Thị trường EU không có cơ sở tại EU → chỉ định đại diện (Art. 27) và ghi trong privacy notice; UK tương tự (Art. 27 UK GDPR). → Kiểm: notice có tên/địa chỉ đại diện; hợp đồng đại diện. · Nguồn: GDPR Art. 27
- [ ] `CMP-INTL-009` **MUST@L** California: liên kết "Do Not Sell or Share My Personal Information"/"Limit the Use of My Sensitive PI" (khi áp dụng), tôn trọng GPC, thông báo khi thu thập, quyền biết/xoá/sửa; hợp đồng "service provider" với nhà cung cấp. → Kiểm: test GPC; trang quyền CA; hợp đồng có điều khoản CCPA. · Nguồn: Cal. Civ. Code §1798.100–1798.199.100; CPPA regs 2025
- [ ] `CMP-INTL-010` **MUST@L** California (từ 01/01/2026): risk assessment cho xử lý rủi ro (bán/chia sẻ, dữ liệu nhạy cảm, ADMT quyết định quan trọng); attestation nộp CPPA trước 01/04/2028; ADMT thông báo + opt-out từ 01/01/2027. → Kiểm: `docs/privacy/risk-assessments/` + lịch nộp; UI ADMT có thông báo. · Nguồn: CPPA regulations (OAL phê duyệt 23/09/2025)
- [ ] `CMP-INTL-011` **MUST@L** Singapore: chỉ định DPO và công bố liên hệ; thông báo vi phạm ≤ 3 ngày lịch khi có khả năng gây hại đáng kể hoặc ≥ 500 người; không dùng số NRIC làm yếu tố xác thực theo hướng dẫn PDPC. → Kiểm: notice có DPO; runbook; xác thực không dựa NRIC. · Nguồn: PDPA 2012 s.11(3), s.26B–26D; PDPC Advisory Guidelines
- [ ] `CMP-INTL-012` **MUST@L** Thái Lan: cơ sở pháp lý theo s.24/26, thông báo vi phạm 72 giờ tới PDPC (miễn khi không có rủi ro), thông báo chủ thể khi rủi ro cao; DPO khi xử lý quy mô lớn/nhạy cảm; hợp đồng chuyển dữ liệu theo PDPC. → Kiểm: `jurisdictions.md` mục TH; runbook. · Nguồn: PDPA B.E. 2562 s.24, 26, 37, 41; PDPC Notification 15/12/2022
- [ ] `CMP-INTL-013` **SHOULD** Privacy notice đa ngôn ngữ theo thị trường, cùng nguồn nội dung (sinh từ data map), nêu cơ sở pháp lý, thời hạn giữ, quyền và cách thực hiện, chuyển dữ liệu quốc tế. → Kiểm: i18n key đầy đủ; diff với data map = 0; xem [`../18-cross-cutting/i18n-and-l10n.md`](../18-cross-cutting/i18n-and-l10n.md). · Nguồn: GDPR Art. 13–14; CCPA §1798.100(a)
- [ ] `CMP-INTL-014` **SHOULD** Khách hàng là tổ chức tài chính EU: hợp đồng theo DORA (ICT third-party), hỗ trợ báo cáo sự cố và kiểm tra; tổ chức thuộc NIS2: cam kết an ninh chuỗi cung ứng. → Kiểm: điều khoản mẫu + runbook. · Nguồn: DORA 2022/2554 Art. 28–30; NIS2 2022/2555 Art. 21
- [ ] `CMP-INTL-015` **SHOULD** Lưu vùng (region) theo người dùng/tenant và định tuyến dữ liệu theo vùng (EU ở EU khi khách yêu cầu). → Kiểm: `region` trong schema; policy IaC. · Nguồn: GDPR Chương V (giảm chuyển dữ liệu)
- [ ] `CMP-INTL-016` **SHOULD** Theo dõi thay đổi luật theo vùng hằng quý (ICO, EDPB, CPPA, PDPC SG/TH, Bộ Công an) ghi ngày rà vào `jurisdictions.md`. → Kiểm: ngày rà ≤ 90 ngày. · Nguồn: thực hành nội bộ
- [ ] `CMP-INTL-017` **MAY** Chứng nhận ISO/IEC 27701:2025 (PIMS) làm bằng chứng chéo cho nhiều khung (GDPR/PDPA/VN). → Kiểm: chứng chỉ còn hạn. · Nguồn: ISO/IEC 27701:2025
- [ ] `CMP-INTL-018` **MAY** Binding Corporate Rules (BCR) cho tập đoàn chuyển dữ liệu nội bộ EU ↔ VN thay SCC từng hợp đồng. → Kiểm: BCR được phê duyệt. · Nguồn: GDPR Art. 47

## Bẫy thường gặp

- **"Máy chủ ở Singapore nên theo luật SG":** GDPR theo người dùng; Luật 91/2025 theo người ở VN; SG theo tổ chức ở SG.
- **SCC ký rồi bỏ ngăn kéo**, không có Transfer Impact Assessment và không cập nhật sub-processor.
- **Một thời hạn DSAR cho mọi vùng** → trễ ở CA (45 ngày) hoặc SG (30 ngày).
- **Tưởng CCPA chỉ áp dụng cho công ty Mỹ**: ngưỡng là doanh thu/số người, không phải trụ sở.
- **UK = EU:** cơ chế chuyển dữ liệu khác (IDTA), và DUAA 2025 đã sửa một số điều (recognised legitimate interests, khiếu nại).
- **PDPA SG "3 ngày" tính từ khi xác định vi phạm**, không phải từ khi phát hiện — nhưng việc xác định phải "nhanh chóng" (30 ngày theo hướng dẫn).
- **Chỉ dịch privacy notice sang tiếng Anh** mà không nêu cơ chế chuyển dữ liệu, đại diện EU.
- **PSD2/AI Act/EHDS không phải luật riêng tư nhưng chạm dữ liệu** — xem gói ngành tương ứng.

## Cổng tự động

| Việc kiểm | Công cụ | Lệnh/cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| ROPA sinh từ data map | Script nội bộ | `python scripts/privacy/gen-ropa.py --check` | CI | diff = 0 |
| Sub-processor mới chưa có DPA | So `package.json`/`requirements`/IaC ↔ `processors.md` | script | CI | 0 thiếu |
| Vùng lưu trữ theo `region` | OPA/conftest (Apache-2.0) | `conftest test infra/ -p policy/region.rego` | CI | 0 vi phạm |
| GPC/DNT, DSAR SLA theo vùng | Playwright + metric | E2E + alert | CI/Obs | pass; 0 quá hạn |
| Thời hạn vi phạm theo vùng trong runbook | Lint bảng runbook | script | CI | có đủ vùng trong `jurisdictions.md` |

## Nguồn

- GDPR — Regulation (EU) 2016/679: <https://eur-lex.europa.eu/eli/reg/2016/679/oj> — xác minh gián tiếp 2026-10-13 (EUR-Lex không trả nội dung qua công cụ; đối chiếu CELEX:32016R0679 qua kết quả tìm kiếm). SCC — Decision (EU) 2021/914 (chưa xác minh trực tiếp ngày 2026-10-13).
- UK Data (Use and Access) Act 2025 c. 18 (Royal Assent 19/06/2025, hiệu lực theo giai đoạn; Commencement No. 6 Regs 2026): <https://www.legislation.gov.uk/ukpga/2025/18/contents> — xác minh 2026-10-13; <https://www.gov.uk/guidance/data-use-and-access-act-2025-plans-for-commencement> — 2026-10-13.
- CCPA/CPRA và quy định CPPA (OAL phê duyệt 23/09/2025; hiệu lực 01/01/2026; ADMT 01/01/2027; attestation 01/04/2028; audit 2028–2030): <https://www.cppa.ca.gov/announcements/2025/20250923.html> — xác minh 2026-10-13.
- Singapore PDPA 2012 — thông báo vi phạm 3 ngày lịch, mức phạt từ 01/10/2022: <https://www.pdpc.gov.sg/report-data-breach/before-you-report-a-data-breach-3/info> và <https://www.pdpc.gov.sg/news-and-events/announcements/2022/09/amendments-to-enforcement-under-the-personal-data-protection-act-in-updated-advisory-guidelines-and-guide> — xác minh 2026-10-13; (chưa xác minh) cấm dùng NRIC xác thực từ 01/01/2027 (một nguồn thứ cấp).
- Thailand PDPA B.E. 2562 (2019), hiệu lực đầy đủ 01/06/2022; bản dịch không chính thức: <https://www.mdes.go.th/law/detail/3577-Personal-Data-Protection-Act-B-E--2562--2019-> — xác minh 2026-10-13; s.37(4) và Notification 15/12/2022 qua <https://www.iapp.org/news/a/thailand-s-pdpc-clarifies-data-breach-notification-requirements> — nguồn thứ cấp.
- DORA (EU) 2022/2554 (áp dụng 17/01/2025); NIS2 (EU) 2022/2555 (chuyển hoá 17/10/2024); EHDS (EU) 2025/327 (hiệu lực 26/03/2025, áp dụng 26/03/2027): <https://www.eumonitor.eu/9353000/1/j9vvik7m1c3gyxp/vmlg5gptv7zp> — xác minh gián tiếp 2026-10-13.
- ISO/IEC 27701:2025: <https://www.iso.org/standard/27701> — xác minh 2026-10-13.
- Luật Việt Nam: xem [`vietnam-data-law.md`](vietnam-data-law.md).
