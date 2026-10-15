---
title: Chính phủ · dịch vụ công · khu vực công
kind: industry
slug: government
prefix: IND-GOV
modules: [16-compliance-privacy/*, 12-security/*, 04-standards/accessibility-standards, 04-standards/security-standards, 06-design-ux/accessibility, 06-design-ux/content-and-microcopy, 06-design-ux/ui-states-and-feedback, 08-backend/authn-authz, 08-backend/api-design, 08-backend/integrations-and-webhooks, 08-backend/files-and-media, 09-database/backup-and-recovery, 09-database/data-modeling, 15-operations/backup-and-disaster-recovery, 15-operations/observability, 15-operations/slo-and-alerting, 15-operations/infrastructure-as-code, 18-cross-cutting/i18n-and-l10n, 10-workflow/documentation-workflow, 14-testing-quality/e2e-and-accessibility, 14-testing-quality/integration-and-contract]
updated: 2026-10-13
---

# Gói ngành: Chính phủ · dịch vụ công · khu vực công

> Ghép cho cổng dịch vụ công, hệ thống thông tin giải quyết thủ tục hành chính, CSDL chuyên ngành, phần mềm nội bộ cơ
> quan nhà nước, hoặc sản phẩm **bán cho khu vực công**. Khác biệt: **ai cũng phải dùng được** (tiếp cận, ngôn ngữ, thiết
> bị yếu), **định danh quốc gia** (VNeID), **kiến trúc và cấp độ an toàn theo quy định** (Khung kiến trúc Chính phủ số
> 4.0, cấp độ 1–5), và **mọi thứ phải lưu trữ/truy vết** theo Luật Lưu trữ. Quy mô mặc định **L**.

## Khi nào dùng

Dùng khi chủ quản hệ thống là cơ quan nhà nước, hệ thống kết nối Cổng Dịch vụ công quốc gia/CSDL quốc gia, hoặc hợp
đồng yêu cầu tuân thủ kiến trúc/cấp độ của Nhà nước. Doanh nghiệp bán SaaS cho cơ quan nhà nước ghép thêm
[`saas-multitenant.md`](saas-multitenant.md).

## Kiến trúc tham chiếu

```text
[Người dân/DN: web, app, kiosk] ─► [Cổng/HTTT giải quyết TTHC cấp bộ/tỉnh (TT 21/2023)] ─► [Nghiệp vụ TTHC: state machine hồ sơ]
                                       │ định danh: VNeID (NĐ 69/2024), chữ ký số (NĐ 23/2025)          │
[Cổng DVC quốc gia] ◄── tích hợp ──►   │ LGSP/NDXP (nền tảng tích hợp, chia sẻ dữ liệu — NĐ 47/2020)     ├─ CSDL quốc gia (dân cư, DN, đất đai…) qua API
                                       │ Lưu trữ số (Luật Lưu trữ 2024), ký số, dấu thời gian            └─ Kho dữ liệu dùng chung, mở dữ liệu
Hạ tầng: trong nước; cấp độ ATTT 1–5 (Luật ANM 2025 Đ.8); giám sát ANM; sao lưu/DR; mã nguồn và tài liệu bàn giao
```

## Thành phần đặc thù khuyến nghị (xác minh lại trước khi dùng)

| Thành phần | Mặc định | Ghi chú |
|---|---|---|
| Kiến trúc | Khung kiến trúc Chính phủ số Việt Nam 4.0 (QĐ 292/QĐ-BKHCN 25/03/2025) + khung bộ/tỉnh 4.0 tương ứng | Thay phiên bản 3.0 (QĐ 2568/QĐ-BTTTT 29/12/2023 — chưa xác minh) |
| Định danh | VNeID mức 2 (NĐ 69/2024), tài khoản định danh điện tử; NIST SP 800-63-4 (07/2025) cho IAL/AAL khi cần tham chiếu quốc tế | Không tự xây hệ thống định danh riêng |
| Chữ ký/dấu | Chữ ký số công vụ/công cộng + dấu thời gian theo NĐ 23/2025 | Văn bản điện tử có giá trị pháp lý |
| Tiếp cận | WCAG 2.2 AA (EN 301 549 V3.2.1 dùng WCAG 2.1 AA; US Section 508/ADA Title II WCAG 2.1 AA) | Mức tối thiểu AA cho mọi trang |
| An toàn | Cấp độ theo Luật ANM 2025 Đ.8; TCVN 11930:2017 + TT 12/2022 trong chuyển tiếp | Hồ sơ cấp độ được phê duyệt |
| Lưu trữ | Tài liệu số theo Luật Lưu trữ 33/2024 (toàn vẹn, xác thực, kho lưu trữ số) | Thời hạn 2–70 năm/vĩnh viễn |

## Khung pháp lý

**Việt Nam (xác minh 2026-10-13 — kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng):**

| Văn bản | Ban hành · Hiệu lực | Nội dung với phần mềm | Nguồn |
|---|---|---|---|
| NĐ 42/2022/NĐ-CP cung cấp thông tin và DVC trực tuyến | 24/06/2022 · 15/08/2022 (thay NĐ 43/2011) | 2 mức DVC (toàn trình/một phần); cổng thông tin điện tử; chuyển đổi trong 2 năm | luatvietnam 223182 |
| NĐ 118/2025/NĐ-CP một cửa, một cửa liên thông | 09/06/2025 · 2025 (thay NĐ 61/2018); TT 03/2025/TT-VPCP 15/09/2025 | Trung tâm phục vụ hành chính công cấp tỉnh/xã, Cổng DVC quốc gia, quy trình tiếp nhận – trả kết quả | vbpl.moj.gov.vn; qdnd.vn |
| TT 21/2023/TT-BTTTT | 31/12/2023 (đang được sửa đổi — dự thảo 2025) | Chức năng, tính năng kỹ thuật của HTTT giải quyết TTHC cấp bộ, cấp tỉnh | luatvietnam 303689 |
| QĐ 292/QĐ-BKHCN Khung kiến trúc Chính phủ số 4.0 | 25/03/2025 | Khung kiến trúc bộ/tỉnh phải cập nhật theo 4.0 sau sắp xếp đơn vị hành chính | lsvn.vn; moc.gov.vn (dẫn chiếu) |
| NĐ 47/2020/NĐ-CP | 2020 | Quản lý, kết nối, chia sẻ dữ liệu số của cơ quan nhà nước (nền tảng tích hợp, API) | thuvienphapluat 440168 |
| Luật Căn cước 26/2023/QH15; NĐ 69/2024/NĐ-CP; NĐ 70/2024/NĐ-CP | 27/11/2023 · 01/07/2024; NĐ 25/06/2024 · 01/07/2024 | Căn cước điện tử, tài khoản định danh điện tử (VNeID) có giá trị như giấy tờ; định danh/xác thực điện tử | lsvn.vn; thuvienphapluat |
| Luật Giao dịch điện tử 20/2023/QH15; NĐ 23/2025/NĐ-CP | 01/07/2024; 10/04/2025 | Chương V giao dịch điện tử của cơ quan nhà nước; chữ ký số, dịch vụ tin cậy | thuvienphapluat 513347 |
| Luật Lưu trữ 33/2024/QH15 | 21/06/2024 · 01/07/2025 | Đ.7 giá trị pháp lý tài liệu số; Đ.15 thời hạn 2–70 năm/vĩnh viễn; Đ.32–36 tài liệu số, kho lưu trữ số, huỷ | hethongphapluat |
| Luật Dữ liệu 60/2024/QH15; NĐ 165/2025/NĐ-CP | 01/07/2025 | Dữ liệu cốt lõi/quan trọng, CSDL tổng hợp quốc gia, Trung tâm dữ liệu quốc gia, chuyển xuyên biên giới | thuvienphapluat |
| Luật An ninh mạng 116/2025/QH15; NĐ 333/2026/NĐ-CP; NĐ 85/2016 + TT 12/2022 (chuyển tiếp) | 01/07/2026; 19/08/2026 | Cấp độ 1–5, thẩm định/kiểm tra/giám sát ANM, lưu trữ trong nước, log ≥ 12 tháng; cấp độ cũ giữ, 12 tháng đáp ứng điều kiện mới | Công báo 499; thuvienphapluat |
| Luật BVDLCN 91/2025/QH15; NĐ 356/2025/NĐ-CP (thay NĐ 13/2023 từ 01/01/2026) | 01/01/2026 | Cơ quan nhà nước là bên kiểm soát; Đ.19 trường hợp không cần đồng ý; ĐGTĐ; trẻ em | xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) |
| Luật Tiếp cận thông tin 104/2016/QH13 → Luật 01/2026/QH16 | 01/07/2018 → 23/04/2026 · 01/09/2026 (**một nguồn, chưa xác minh**) | Công khai thông tin, cung cấp theo yêu cầu | moj.gov.vn; (chưa xác minh luật mới) |
| Luật AI 134/2025/QH15; NĐ 142/2026/NĐ-CP | 01/03/2026; 01/05/2026 | Cơ quan nhà nước dùng AI: đánh giá tác động (NĐ 142 Chương III), phân loại rủi ro | xem [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md) |

**Quốc tế (xác minh 2026-10-13):** EN 301 549 V3.2.1 (hài hoà 08/2021, WCAG 2.1 AA; bản V4 có WCAG 2.2 chưa hài hoà) +
EU Web Accessibility Directive 2016/2102 · US Section 508 (36 CFR 1194, WCAG 2.0 AA — chưa xác minh) và ADA Title II
(WCAG 2.1 AA; hạn 26/04/2027 cho đơn vị lớn, 26/04/2028 nhỏ — theo IFR 20/04/2026, nguồn thứ cấp) · eIDAS 2.0 Regulation
(EU) 2024/1183 (hiệu lực 20/05/2024; ví định danh EU cuối 2026) · NIST SP 800-63-4 (07/2025) · ISO/IEC 27001:2022 ·
GDPR (khu vực công: cơ sở Art. 6(1)(e)).

## Mô hình dữ liệu / nghiệp vụ đặc trưng

- **Hồ sơ TTHC = state machine:** `tiếp nhận → xử lý (nhiều bước, nhiều cơ quan) → bổ sung → trả kết quả / từ chối`
  với hạn xử lý theo ngày làm việc, mã hồ sơ, biên nhận điện tử, kết quả điện tử ký số.
- **Chủ thể:** công dân (số định danh), tổ chức (mã số DN), người được uỷ quyền; định danh qua VNeID, không tự lưu bản sao CCCD.
- **Dữ liệu dùng chung:** tra cứu CSDL quốc gia qua API thay vì yêu cầu người dân nộp lại giấy tờ (nguyên tắc "không hỏi lại").
- **Tài liệu lưu trữ:** mỗi hồ sơ/kết quả có `retention_class` (2–70 năm/vĩnh viễn), hash, ký số, dấu thời gian; kho
  lưu trữ số tách biệt.
- **Thời gian:** ngày làm việc theo lịch nghỉ lễ VN; mốc "nộp" tính theo giờ Việt Nam ghi trên biên nhận.

## Ca biên nghiệp vụ

1. **Hạn xử lý rơi vào ngày nghỉ/lễ** (Tết, nghỉ bù): tính ngày làm việc theo lịch chính thức có cập nhật hằng năm;
   test ca Tết Âm lịch.
2. **Người dân nộp hồ sơ 23:59 ngày cuối hạn** theo giờ VN, server UTC → ghi nhận đúng ngày; biên nhận hiển thị giờ VN.
3. **Hồ sơ yêu cầu bổ sung nhiều lần:** đồng hồ hạn xử lý dừng/chạy lại đúng quy định; lịch sử đầy đủ.
4. **Một người có nhiều vai** (công dân + đại diện DN + cán bộ): phiên theo vai, không trộn quyền.
5. **CSDL quốc gia tạm ngưng (API lỗi):** hàng đợi tra cứu lại, cho phép tiếp nhận "chờ xác minh", không làm mất hạn của dân.
6. **Thay đổi địa giới hành chính/sáp nhập đơn vị** (2025): mã đơn vị, địa chỉ, cơ quan tiếp nhận đổi — dữ liệu cũ phải
   ánh xạ, hồ sơ đang xử lý không được "mồ côi".
7. **Kết quả đã ký số bị phát hiện sai:** không sửa tại chỗ; phát hành kết quả thay thế, thu hồi có dấu vết.
8. **Người khuyết tật nộp hồ sơ** bằng trình đọc màn hình/chỉ bàn phím: toàn bộ luồng kể cả tải file, CAPTCHA phải có thay thế.
9. **Tải tệp đính kèm lớn qua mạng chậm:** tải tiếp (resumable), giới hạn và quét mã độc, định dạng mở (PDF/A, ODF/OOXML).
10. **Trẻ em/người được giám hộ là chủ thể hồ sơ** (khai sinh, học bạ): người đại diện thực hiện; dữ liệu trẻ em bảo vệ theo Đ.24.
11. **Yêu cầu cung cấp thông tin theo Luật Tiếp cận thông tin** vs thông tin phải bảo mật: phân loại tài liệu có cờ công khai/hạn chế.
12. **Mất điện/thiên tai tại trung tâm dữ liệu:** DR ở địa điểm khác trong nước; RTO/RPO theo cấp độ; diễn tập.

## Checklist

- [ ] `IND-GOV-001` **MUST** Hệ thống được xác định cấp độ an toàn (1–5) theo Luật ANM 2025 Đ.8 với hồ sơ đề xuất, phương án bảo đảm theo cấp độ (TCVN 11930:2017/TT 12/2022 trong chuyển tiếp) và quyết định phê duyệt; cập nhật khi kiến trúc đổi; đáp ứng điều kiện mới trước 01/07/2027. → Kiểm: `docs/security/cap-do/` có quyết định + ma trận biện pháp; kiểm tra định kỳ ≤ 12 tháng. · Nguồn: Luật ANM 116/2025/QH15 Đ.8, Đ.45; NĐ 85/2016/NĐ-CP; TT 12/2022/TT-BTTTT
- [ ] `IND-GOV-002` **MUST** Kiến trúc hệ thống đối chiếu Khung kiến trúc Chính phủ số 4.0 và khung bộ/tỉnh tương ứng (lớp nghiệp vụ, dữ liệu, ứng dụng, hạ tầng, an toàn); tài liệu kiến trúc là đầu ra bàn giao. → Kiểm: `docs/architecture/` có bảng ánh xạ thành phần ↔ khung 4.0; ADR cho sai lệch. · Nguồn: QĐ 292/QĐ-BKHCN (25/03/2025)
- [ ] `IND-GOV-003` **MUST** Định danh người dân/doanh nghiệp qua VNeID/tài khoản định danh điện tử (không tự xây định danh riêng, không lưu ảnh CCCD khi đã xác thực); cán bộ dùng tài khoản công vụ có MFA. → Kiểm: tích hợp VNeID có test; schema không lưu ảnh giấy tờ sau xác thực; MFA bắt buộc cho vai cán bộ. · Nguồn: Luật Căn cước 26/2023/QH15; NĐ 69/2024/NĐ-CP; Luật 91/2025/QH15 Đ.29
- [ ] `IND-GOV-004` **MUST** Kết quả giải quyết TTHC, biên nhận, văn bản điện tử ký số (công vụ/công cộng theo NĐ 23/2025) kèm dấu thời gian; xác minh được bằng công cụ độc lập; không sửa sau ký (thay thế có dấu vết). → Kiểm: test xác minh chữ ký bằng thư viện chuẩn; sửa tài liệu đã ký → phiên bản mới. · Nguồn: Luật GDĐT 20/2023/QH15 Chương III, V; NĐ 23/2025/NĐ-CP
- [ ] `IND-GOV-005` **MUST** Hồ sơ TTHC theo state machine có hạn xử lý tính theo ngày làm việc (lịch nghỉ lễ cập nhật), tạm dừng khi chờ bổ sung, lịch sử trạng thái đầy đủ, mã hồ sơ duy nhất, tra cứu trạng thái công khai. → Kiểm: test hạn qua Tết/ngày nghỉ bù; test tạm dừng/chạy lại; API tra cứu. · Nguồn: NĐ 118/2025/NĐ-CP; TT 21/2023/TT-BTTTT; NĐ 42/2022/NĐ-CP
- [ ] `IND-GOV-006` **MUST** Tích hợp Cổng DVC quốc gia, LGSP/NDXP và CSDL quốc gia qua API chuẩn với xác thực, idempotency, retry và hàng đợi khi dịch vụ đối tác lỗi; không yêu cầu người dân nộp lại dữ liệu đã có trong CSDL quốc gia. → Kiểm: contract test với môi trường thử nghiệm; test API đối tác lỗi → hồ sơ vẫn tiếp nhận "chờ xác minh". · Nguồn: NĐ 47/2020/NĐ-CP; NĐ 118/2025/NĐ-CP; [`../08-backend/integrations-and-webhooks.md`](../08-backend/integrations-and-webhooks.md)
- [ ] `IND-GOV-007` **MUST** Tiếp cận được toàn bộ luồng (WCAG 2.2 AA tối thiểu, tương đương EN 301 549/Section 508): bàn phím, đọc màn hình, tương phản, CAPTCHA có thay thế, biểu mẫu có nhãn/lỗi rõ, tiếng Việt dễ hiểu; kiểm thử với người khuyết tật trước phát hành. → Kiểm: axe = 0 lỗi nghiêm trọng mọi trang; Lighthouse a11y ≥ 95; biên bản kiểm thử với người dùng khuyết tật; xem [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md). · Nguồn: WCAG 2.2; EN 301 549 V3.2.1; ADA Title II (WCAG 2.1 AA)
- [ ] `IND-GOV-008` **MUST** Dữ liệu và hệ thống đặt tại Việt Nam; sao lưu + DR ở địa điểm khác trong nước; RTO/RPO theo cấp độ; diễn tập khôi phục ≥ 1 lần/năm (cấp độ 3+: 2 lần). → Kiểm: IaC policy chặn region ngoài VN; biên bản diễn tập; số đo. · Nguồn: NĐ 333/2026/NĐ-CP Đ.19; TT 12/2022/TT-BTTTT (sao lưu theo cấp độ); [`../15-operations/backup-and-disaster-recovery.md`](../15-operations/backup-and-disaster-recovery.md)
- [ ] `IND-GOV-009` **MUST** Tài liệu điện tử theo Luật Lưu trữ 2024: `retention_class` cho mỗi loại hồ sơ/kết quả; toàn vẹn (hash), xác thực số, kho lưu trữ số kết nối được; huỷ hết hạn đồng thời dữ liệu chủ; nộp lưu trữ đúng hạn (≤ 1 năm hiện hành, ≤ 5 năm lịch sử). → Kiểm: data map có retention theo Danh mục; job nộp/huỷ có lịch và biên bản. · Nguồn: Luật Lưu trữ 33/2024/QH15 Đ.7, Đ.15, Đ.17, Đ.32–36
- [ ] `IND-GOV-010` **MUST** Nhật ký hệ thống và nhật ký truy cập dữ liệu công dân bất biến, lưu ≥ 12 tháng (dài hơn theo cấp độ/ngành), thời gian đồng bộ chuẩn quốc gia; giám sát an ninh mạng kết nối cơ quan có thẩm quyền theo cấp độ. → Kiểm: cấu hình WORM + retention; NTP; kết nối SOC/giám sát có biên bản; xem [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md). · Nguồn: NĐ 333/2026/NĐ-CP Đ.7, Đ.22–23; Luật ANM 116/2025/QH15
- [ ] `IND-GOV-011` **MUST** Dữ liệu cá nhân do cơ quan nhà nước xử lý: xác định căn cứ (Đ.19 không cần đồng ý khi thực hiện nhiệm vụ) nhưng vẫn thông báo, tối thiểu hoá, ĐGTĐ, bảo vệ dữ liệu trẻ em; chia sẻ liên cơ quan qua nền tảng tích hợp có log mục đích. → Kiểm: data map ghi căn cứ pháp lý; log chia sẻ liên cơ quan có `purpose`; hồ sơ ĐGTĐ. · Nguồn: Luật 91/2025/QH15 Đ.19, Đ.21, Đ.24; NĐ 47/2020/NĐ-CP
- [ ] `IND-GOV-012` **MUST** Mã nguồn, tài liệu kiến trúc/vận hành, dữ liệu và quyền quản trị bàn giao đầy đủ cho chủ quản (không khoá vendor): repo, IaC, runbook, tài khoản quản trị, khoá; định dạng dữ liệu mở. → Kiểm: checklist bàn giao theo [`../17-product-project/handover-and-stakeholders.md`](../17-product-project/handover-and-stakeholders.md); build lại được từ mã bàn giao (CI chạy ở hạ tầng chủ quản). · Nguồn: Luật CNCNS 71/2025/QH15 (không rào cản chuyển nhà cung cấp); thực hành đấu thầu CNTT
- [ ] `IND-GOV-013` **MUST@L** Thẩm định/đánh giá điều kiện an ninh mạng theo NĐ 333/2026 trước khi đưa vào vận hành với hệ thống thuộc diện (quan trọng về an ninh quốc gia); kiểm tra ANM định kỳ; nhân sự ANM đạt chuẩn tập huấn (24/36 tháng). → Kiểm: hồ sơ thẩm định/biên bản; kế hoạch tập huấn. · Nguồn: NĐ 333/2026/NĐ-CP Đ.5–8, Đ.24
- [ ] `IND-GOV-014` **MUST@L** AI trong dịch vụ công: đánh giá tác động theo NĐ 142/2026 Chương III trước khi dùng; AI không tự quyết định hồ sơ (người ký); minh bạch với người dân. → Kiểm: hồ sơ đánh giá tác động; state machine có bước người duyệt; thông báo trong UI. · Nguồn: NĐ 142/2026/NĐ-CP; Luật AI 134/2025/QH15
- [ ] `IND-GOV-015` **SHOULD** Thiết kế cho thiết bị yếu/mạng chậm/kiosk: trang quan trọng ≤ 500 KB, hoạt động không JS cho tra cứu cơ bản, hỗ trợ trình duyệt cũ theo thống kê người dùng. → Kiểm: Lighthouse cấu hình 3G; test no-JS tra cứu. · Nguồn: [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md)
- [ ] `IND-GOV-016` **SHOULD** Ngôn ngữ: tiếng Việt chuẩn, thuật ngữ hành chính nhất quán theo bộ từ điển, hỗ trợ tiếng dân tộc/tiếng Anh ở nơi cần; biểu mẫu dùng mẫu chính thức. → Kiểm: glossary trong repo; i18n; xem [`../06-design-ux/content-and-microcopy.md`](../06-design-ux/content-and-microcopy.md). · Nguồn: NĐ 42/2022/NĐ-CP (thông tin dễ hiểu)
- [ ] `IND-GOV-017` **SHOULD** Dữ liệu mở: công bố dữ liệu không nhạy cảm theo định dạng máy đọc (CSV/JSON/API) có license rõ, cập nhật định kỳ. → Kiểm: cổng dữ liệu mở có metadata + license. · Nguồn: NĐ 47/2020/NĐ-CP (dữ liệu mở); Luật Dữ liệu 60/2024/QH15
- [ ] `IND-GOV-018` **SHOULD** SLO công khai cho dịch vụ công (uptime, thời gian phản hồi tra cứu) và trang trạng thái; cảnh báo khi hạn xử lý hồ sơ sắp quá. → Kiểm: `docs/ops/slo.md`; alert hồ sơ quá hạn; xem [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md). · Nguồn: NĐ 42/2022/NĐ-CP; thực hành SRE
- [ ] `IND-GOV-019` **SHOULD** Thông tin công khai và thông tin theo yêu cầu phân loại rõ (công khai/hạn chế/mật) ngay trong schema; cơ chế tiếp nhận yêu cầu cung cấp thông tin có thời hạn. → Kiểm: cờ phân loại; luồng yêu cầu có SLA. · Nguồn: Luật Tiếp cận thông tin 104/2016/QH13 (và luật thay thế 2026 — chưa xác minh)
- [ ] `IND-GOV-020` **MAY** Hỗ trợ ví định danh EU (eIDAS 2.0) hoặc chuẩn Verifiable Credentials cho giao dịch xuyên biên giới. → Kiểm: ADR + thử nghiệm. · Nguồn: Regulation (EU) 2024/1183
- [ ] `IND-GOV-021` **MAY** Mã nguồn mở hoá thành phần dùng chung (theo chính sách chủ quản) với license OSI và quy trình đóng góp. → Kiểm: repo công khai có LICENSE; xem [`../18-cross-cutting/open-source-and-community.md`](../18-cross-cutting/open-source-and-community.md). · Nguồn: thực hành chính phủ số

## Cổng chất lượng tương đương

| Cổng chung | Tương đương khu vực công | Ngưỡng |
|---|---|---|
| A11y | WCAG 2.2 AA mọi trang; kiểm thử người dùng khuyết tật | axe 0 lỗi nghiêm trọng; biên bản |
| CWV | LCP ≤ 2,5 s trên 3G/thiết bị yếu; tra cứu không JS | Lighthouse CI |
| Bảo mật | Hồ sơ cấp độ phê duyệt; kiểm tra ANM định kỳ; pentest; ASVS L2+ | hồ sơ + báo cáo |
| Tin cậy | DR trong nước, diễn tập; SLO công khai | biên bản + dashboard |
| Bàn giao | Build lại được từ mã bàn giao ở hạ tầng chủ quản | CI chủ quản xanh |

## Bẫy

- **"Kiến trúc 3.0" trong hồ sơ 2026** → đã có 4.0 (QĐ 292/QĐ-BKHCN).
- **Tự xây đăng nhập riêng, lưu ảnh CCCD** thay vì VNeID → vi phạm Đ.29 Luật 91/2025 và tạo kho dữ liệu nhạy cảm.
- **Hạn xử lý tính ngày lịch** → sai hạn dịp Tết.
- **Kết quả ký số rồi "sửa PDF"** → chữ ký vô hiệu, mất giá trị pháp lý.
- **Cloud nước ngoài "cho nhanh"** → vi phạm lưu trữ trong nước (NĐ 333 Đ.19) và cấp độ.
- **CAPTCHA hình ảnh bắt buộc** → người khiếm thị không nộp được.
- **Vendor giữ tài khoản quản trị/khoá** → khoá vendor; bàn giao không build lại được.
- **Xoá hồ sơ "cho nhẹ CSDL"** → vi phạm thời hạn lưu trữ.

## Nguồn

- NĐ 42/2022/NĐ-CP (24/06/2022, hiệu lực 15/08/2022): <https://luatvietnam.vn/thong-tin/nghi-dinh-42-2022-nd-cp-quy-dinh-ve-dvc-truc-tuyen-cua-co-quan-nn-tren-moi-truong-mang-223182-d1.html> — xác minh 2026-10-13; kiểm tra văn bản sửa đổi trước khi áp dụng.
- NĐ 118/2025/NĐ-CP (09/06/2025, thay NĐ 61/2018) và TT 03/2025/TT-VPCP (15/09/2025): <https://vbpl.moj.gov.vn/TW/Pages/vanban.aspx?cqbh=166>; <https://en.qdnd.vn/politics/news/pm-orders-uninterrupted-public-services-amid-transition-to-two-tier-local-government-model-579506> — xác minh 2026-10-13 (ngày hiệu lực NĐ 118 chưa xác minh chính xác).
- TT 21/2023/TT-BTTTT (31/12/2023): <https://luatvietnam.vn/hanh-chinh/thong-tu-21-2023-tt-btttt-tinh-nang-ky-thuat-cua-he-thong-thong-tin-giai-quyet-tthc-cap-bo-303689-d1.html> — xác minh 2026-10-13 (dự thảo sửa đổi 2025 chưa xác minh ban hành).
- QĐ 292/QĐ-BKHCN (25/03/2025) Khung kiến trúc Chính phủ số 4.0: dẫn chiếu tại <https://lsvn.vn/huong-dan-trien-khai-chuyen-doi-so-khi-sap-xep-don-vi-hanh-chinh-a156127.html> và <https://moc.gov.vn/Images/FileVanBan/BXD_305-QD-BXD_03032026.pdf> — xác minh gián tiếp 2026-10-13 (chưa có bản gốc quyết định); QĐ 2568/QĐ-BTTTT (3.0) — chưa xác minh.
- NĐ 47/2020/NĐ-CP: <https://thuvienphapluat.vn/van-ban/Cong-nghe-thong-tin/Decree-47-2020-ND-CP-management-connection-and-share-of-digital-data-of-regulatory-agencies-440168.aspx> — xác minh tồn tại 2026-10-13.
- Luật Căn cước 26/2023/QH15 (hiệu lực 01/07/2024); NĐ 69/2024/NĐ-CP và NĐ 70/2024/NĐ-CP (25/06/2024, hiệu lực 01/07/2024): <https://thuvienphapluat.vn/hoi-dap-phap-luat/dang-ky-vneid-khong-can-den-cong-an-duoc-khong-138051223.html> — nguồn thứ cấp, xác minh 2026-10-13.
- Luật Lưu trữ 33/2024/QH15 (hiệu lực 01/07/2025): <https://hethongphapluat.com/luat-luu-tru-2024.html> — xác minh 2026-10-13.
- Luật ANM 116/2025/QH15 Đ.8, Đ.45; NĐ 333/2026/NĐ-CP (Công báo 499): xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) — xác minh 2026-10-13.
- Luật Tiếp cận thông tin 104/2016/QH13 (hiệu lực 01/07/2018): <https://www.moj.gov.vn:443/qt/tintuc/Lists/ChiDaoDieuHanh/Attachments/2147/4.%20Tai%20lieu%20gioi%20thieu%20nhung%20diem%20moi%20va%20quan%20triet%20thi%20hanh%20Luat%20tiep%20can%20thong%20tin.pdf> — xác minh 2026-10-13; (chưa xác minh) Luật Tiếp cận thông tin 01/2026/QH16 (23/04/2026, hiệu lực 01/09/2026) — chỉ một tài liệu tập huấn dẫn.
- EN 301 549 V3.2.1 / WCAG 2.1: <https://digital-strategy.ec.europa.eu/en/policies/changes-accessibility-standard> — xác minh 2026-10-13; WCAG 2.2: <https://www.w3.org/TR/WCAG22/> — 2026-10-13; ADA Title II hạn 2027/2028: <https://www.hubinternational.com/en-us/hub-resources/absence-management-bulletins/2026/04/ada-title-ii-web-and-mobile-application-accessibility-rule/> — nguồn thứ cấp.
- NIST SP 800-63-4 (final 07/2025): <https://pages.nist.gov/800-63-4/> — xác minh 2026-10-13.
- eIDAS 2.0 Regulation (EU) 2024/1183 (hiệu lực 20/05/2024): <https://presencis.com/regulations/eidas-2/timeline/> — nguồn thứ cấp, 2026-10-13 (EUR-Lex không truy cập được qua công cụ).
