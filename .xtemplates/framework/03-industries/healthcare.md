---
title: Y tế · sức khoẻ · dữ liệu bệnh nhân
kind: industry
slug: healthcare
prefix: IND-HEALTH
modules: [12-security/*, 16-compliance-privacy/*, 09-database/sensitive-data-and-access, 09-database/backup-and-recovery, 09-database/transactions-and-consistency, 08-backend/authn-authz, 08-backend/files-and-media, 08-backend/integrations-and-webhooks, 08-backend/reliability-and-errors, 06-design-ux/accessibility, 06-design-ux/ui-states-and-feedback, 14-testing-quality/unit-and-logic-edge-cases, 14-testing-quality/integration-and-contract, 15-operations/backup-and-disaster-recovery, 15-operations/incident-response, 18-cross-cutting/units-time-and-money, 13-ai-engineering/guardrails-and-safety]
updated: 2026-10-14
---

# Gói ngành: Y tế · sức khoẻ · dữ liệu bệnh nhân

> Ghép cho phần mềm xử lý **dữ liệu sức khoẻ** hoặc hỗ trợ **quyết định lâm sàng**: HIS/EMR/bệnh án điện tử, đặt lịch,
> kê đơn, LIS/RIS/PACS, app sức khoẻ, bảo hiểm y tế, telehealth, AI chẩn đoán. Sai một đơn vị thuốc có thể gây chết
> người; lộ một bệnh án là vi phạm dữ liệu nhạy cảm. Quy mô mặc định **L**.

## Khi nào dùng

Dùng khi hệ thống lưu/truyền thông tin sức khoẻ định danh được (PHI), kết nối cơ sở khám chữa bệnh, BHXH, hoặc đưa ra
gợi ý ảnh hưởng điều trị. App theo dõi bước chân không kết nối y tế vẫn thuộc **dữ liệu nhạy cảm** theo Luật
91/2025 → ghép gói này ở mức tối thiểu (IND-HEALTH-001…008). Phần mềm là thiết bị y tế (SaMD) → thêm nghĩa vụ
MDR/IEC 62304 (IND-HEALTH-016).

## Kiến trúc tham chiếu

```text
[Thiết bị/LIS/RIS/PACS] ──HL7 v2 / FHIR R4 / DICOM──► [Integration engine] ──► [Clinical data store]
[Bác sĩ/điều dưỡng UI] ──► [App server: RBAC theo vai + ngữ cảnh điều trị, break-glass] ──► [Audit log bất biến]
[Bệnh nhân app] ──► [Patient API (consent, DSAR)]            [Mã hoá cột PHI; khoá ở KMS]
[Cổng BHXH / Sổ sức khoẻ điện tử / CSDL y tế quốc gia] ◄──XML QĐ 130 / FHIR VN Core──► [Export service]
[AI hỗ trợ] → chỉ gợi ý, có bác sĩ xác nhận; log đầu vào/đầu ra; phân loại rủi ro cao
```

## Thành phần đặc thù khuyến nghị (xác minh lại trước khi dùng)

| Thành phần | Mặc định | Ghi chú |
|---|---|---|
| Chuẩn trao đổi | HL7 FHIR R4 (Vietnam Core IG của Bộ Y tế dựa trên R4, bản CI build chưa chính thức) hoặc R5 5.0.0 (bản "current published" của HL7, xác minh 2026-10-13) | Nội địa BHYT: XML theo QĐ 130/QĐ-BYT (18/01/2023) sửa bởi QĐ 4750/QĐ-BYT (29/12/2023) |
| Mã hoá dữ liệu | ICD-10 (chẩn đoán), LOINC (xét nghiệm), SNOMED CT (lâm sàng), DICOM (ảnh) | Danh mục thuốc/dịch vụ theo Bộ Y tế |
| Định danh bệnh nhân | Số định danh cá nhân (CCCD 12 số)/VNeID + mã bệnh nhân nội bộ; thuật toán ghép bản ghi có điểm tin cậy | Không dùng tên + ngày sinh làm khoá duy nhất |
| Đơn vị thuốc | Ucum/đơn vị chuẩn + liều theo cân nặng, kiểm tương tác | Lưu liều ở số thập phân cố định, không float |
| Lưu trữ ảnh | Object storage mã hoá + PACS; DICOM de-identification khi dùng nghiên cứu | Thời hạn lưu theo loại hồ sơ |
| Chữ ký số bệnh án | Chữ ký số/chữ ký điện tử theo Luật GDĐT 20/2023 + NĐ 23/2025 | TT 13/2025/TT-BYT yêu cầu ký/xác nhận điện tử |

## Khung pháp lý

**Việt Nam (xác minh 2026-10-13 — kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng):**

| Văn bản | Ban hành · Hiệu lực | Nội dung với phần mềm | Nguồn |
|---|---|---|---|
| Luật Khám bệnh, chữa bệnh 15/2023/QH15 | 09/01/2023 · 01/01/2024 | Đ.69 hồ sơ bệnh án giấy/điện tử giá trị pháp lý như nhau; lưu trữ, bảo mật, khai thác | hethongphapluat |
| TT 13/2025/TT-BYT hồ sơ bệnh án điện tử | 06/06/2025 · 21/07/2025 (thay TT 46/2018/TT-BYT) | Bệnh viện hoàn thành EMR chậm nhất 30/09/2025; cơ sở khác 31/12/2026; kết nối số định danh cá nhân/VNeID; ký điện tử/sinh trắc; sao lưu dự phòng; truy xuất; quy chế nội bộ | caselaw 587211 |
| NĐ 102/2025/NĐ-CP quản lý dữ liệu y tế | 13/05/2025 · 01/07/2025 | CSDL quốc gia về y tế, Sổ sức khoẻ điện tử thay giấy tờ từ 01/07/2025, dữ liệu chủ có giá trị pháp lý | luatvietnam 400071 |
| TT 27/2021/TT-BYT + TT 04/2022/TT-BYT kê đơn điện tử | hiệu lực 15/02/2022; sửa 15/09/2022 | Đơn thuốc điện tử, liên thông hệ thống đơn thuốc quốc gia | caselaw 401810 |
| QĐ 130/QĐ-BYT + QĐ 4750/QĐ-BYT | 18/01/2023; 29/12/2023 (gửi dữ liệu chính thức từ 01/07/2024) | Chuẩn/định dạng XML dữ liệu đầu ra phục vụ giám định, thanh toán BHYT | luatvietnam 241607 |
| TT 32/2023/TT-BYT hướng dẫn Luật KBCB | 2023 | Mẫu hồ sơ bệnh án; thời hạn lưu hồ sơ (10/20/30 năm theo loại — **chưa xác minh điều khoản**, có thể ở TT 33/2025/TT-BYT) | thuvienphapluat |
| Luật BVDLCN 91/2025/QH15 Đ.26 + NĐ 356/2025 | 01/01/2026 | Dữ liệu sức khoẻ = nhạy cảm; không cung cấp cho bảo hiểm/bên thứ ba trừ khi có yêu cầu văn bản của chủ thể; thông báo vi phạm 72 h | xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) |
| Luật Giao dịch điện tử 20/2023/QH15; NĐ 23/2025/NĐ-CP | 01/07/2024; 10/04/2025 | Chữ ký số, dấu thời gian cho bệnh án/đơn thuốc | thuvienphapluat 513347 |
| Luật An ninh mạng 116/2025/QH15 | 01/07/2026 | Hệ thống y tế công: cấp độ 3+ thường gặp; bảo vệ theo cấp độ | thuvienphapluat 666020 |
| Luật Trí tuệ nhân tạo 134/2025/QH15 + NĐ 142/2026/NĐ-CP | 01/03/2026; 01/05/2026 | AI chẩn đoán/hỗ trợ điều trị thường thuộc rủi ro cao → đánh giá sự phù hợp trước khi dùng | xem [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md) |

**Quốc tế (xác minh 2026-10-13):** HIPAA 45 CFR Part 160 & 164 — Privacy (Subpart E), Security (Subpart C), Breach
Notification (§§164.400–414, thông báo ≤ 60 ngày); NPRM sửa Security Rule đăng 06/01/2025, bản cuối bị lùi (chưa có hiệu
lực) · GDPR Art. 9 (dữ liệu sức khoẻ) · EHDS Regulation (EU) 2025/327 (hiệu lực 26/03/2025, áp dụng chung từ 26/03/2027)
· EU MDR 2017/745 Rule 11 (SaMD), IEC 62304 (vòng đời phần mềm y tế, lớp A/B/C), ISO 13485, ISO 27799:2016 · HL7 FHIR,
DICOM, ICD-10/11, LOINC, SNOMED CT.

## Mô hình dữ liệu / nghiệp vụ đặc trưng

- **Patient** (định danh + ghép bản ghi có `match_score`), **Encounter** (lượt khám), **Condition** (ICD-10),
  **Observation** (LOINC, giá trị + đơn vị + khoảng tham chiếu), **MedicationRequest** (thuốc, liều, đơn vị, tần suất,
  đường dùng), **DiagnosticReport/ImagingStudy** (DICOM), **Consent**, **AuditEvent** — đặt theo tài nguyên FHIR để dễ liên thông.
- **Quyền truy cập theo ngữ cảnh:** vai (bác sĩ/điều dưỡng/dược/thu ngân) × quan hệ điều trị hiện tại × khoa; cơ chế
  **break-glass** (truy cập khẩn cấp) có lý do, hậu kiểm.
- **Hồ sơ bệnh án là append-only:** sửa = bản ghi mới có lý do, giữ lịch sử; ký điện tử khi khoá.
- **Thời gian:** sự kiện lâm sàng lưu UTC + múi giờ cơ sở; thời điểm "ghi" ≠ thời điểm "xảy ra".
- **Xuất dữ liệu:** XML QĐ 130 cho BHYT; FHIR cho liên thông; de-identification cho nghiên cứu.

## Ca biên nghiệp vụ

1. **Bệnh nhân trùng tên, cùng ngày sinh** (Nguyễn Văn A ×2 trong một ngày): ghép bản ghi phải dùng số định danh
   cá nhân/BHYT + điểm tin cậy; UI bắt buộc xác nhận "đúng người" trước khi kê đơn.
2. **Đơn vị thuốc nhầm** (mg ↔ mcg, mL ↔ giọt, IU): hệ thống lưu đơn vị chuẩn hoá và cảnh báo khi liều vượt ngưỡng
   theo cân nặng/tuổi; không nhận liều không có đơn vị.
3. **Trẻ sơ sinh chưa có tên/CCCD:** định danh tạm theo mẹ + thời gian sinh; phải hợp nhất khi có định danh thật mà
   không mất lịch sử.
4. **Bệnh nhân trùng lặp sau hợp nhất (merge) rồi phát hiện sai:** cần unmerge với audit đầy đủ.
5. **Kết quả xét nghiệm về sau khi bệnh nhân đã ra viện/tử vong:** vẫn gắn đúng encounter, cảnh báo bác sĩ phụ trách.
6. **Giá trị xét nghiệm ngoài dải đo** (`<0.01`, `>1000`): lưu dạng so sánh + giá trị, không ép thành số.
7. **Đổi giờ/múi giờ và nhập muộn:** thuốc "đã cho lúc 08:00" nhập lúc 10:00 — phải có cả hai mốc; thứ tự sự kiện theo
   thời điểm xảy ra.
8. **Truy cập khẩn cấp (break-glass)** khi bệnh nhân bất tỉnh ở khoa khác: cho phép có lý do, thông báo và hậu kiểm trong 24 h.
9. **Rút đồng ý chia sẻ dữ liệu với bảo hiểm** giữa chừng: dừng gửi nhưng dữ liệu đã gửi theo nghĩa vụ pháp lý không thu hồi được — phải thông báo rõ.
10. **Hồ sơ bệnh án điện tử bị yêu cầu sao chép bởi người nhà:** phải kiểm quyền theo Luật KBCB Đ.69 (ai được đọc/sao).
11. **Gửi XML BHYT thất bại nửa lô:** gửi lại phải idempotent theo mã lượt khám, không tạo lượt trùng ở BHXH.
12. **AI gợi ý chẩn đoán sai, bác sĩ đã ký:** log phải chứng minh gợi ý + quyết định cuối do người; có cơ chế báo cáo sự cố AI.

## Checklist

- [ ] `IND-HEALTH-001` **MUST** Dữ liệu sức khoẻ được phân loại nhạy cảm, mã hoá ở mức cột/trường (khoá tại KMS), tách khỏi dữ liệu vận hành; dump CSDL không có bản rõ. → Kiểm: schema đánh dấu `phi: true`; test đọc dump không thấy chẩn đoán/ghi chú; xem [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md). · Nguồn: Luật 91/2025/QH15 Đ.2, Đ.12; HIPAA §164.312(a)(2)(iv); GDPR Art. 9, 32
- [ ] `IND-HEALTH-002` **MUST** Mọi truy cập đọc/ghi hồ sơ bệnh nhân ghi vào audit log bất biến (ai, khi nào, bản ghi nào, lý do/ngữ cảnh), lưu tối thiểu bằng thời hạn hồ sơ; có báo cáo truy cập bất thường. → Kiểm: bảng `audit_event` append-only; test mọi endpoint PHI đều sinh sự kiện; alert "xem hồ sơ người nổi tiếng/đồng nghiệp". · Nguồn: HIPAA §164.312(b); TT 13/2025/TT-BYT; Luật KBCB Đ.69
- [ ] `IND-HEALTH-003` **MUST** Phân quyền theo vai **và** quan hệ điều trị (bệnh nhân đang thuộc khoa/bác sĩ); break-glass có lý do bắt buộc và hậu kiểm. → Kiểm: test quyền: bác sĩ khoa khác bị từ chối; break-glass tạo ticket hậu kiểm; xem [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md). · Nguồn: HIPAA §164.308(a)(4); ASVS 5.0 V8
- [ ] `IND-HEALTH-004` **MUST** Hồ sơ bệnh án điện tử append-only: mọi sửa đổi tạo phiên bản mới có người sửa, thời điểm, lý do; bản đã ký điện tử không đổi được. → Kiểm: test sửa bản ghi đã ký → tạo phiên bản mới, bản cũ nguyên vẹn; hash chuỗi phiên bản. · Nguồn: TT 13/2025/TT-BYT; Luật KBCB 15/2023/QH15 Đ.69; Luật GDĐT 20/2023/QH15
- [ ] `IND-HEALTH-005` **MUST** Thuốc/liều lưu với đơn vị chuẩn hoá (danh mục cố định), số thập phân cố định; kiểm tra liều tối đa theo cân nặng/tuổi và tương tác trước khi lưu đơn. → Kiểm: test đơn vị bảng ca biên (mg/mcg, trẻ em, suy thận); từ chối liều không có đơn vị. · Nguồn: TT 27/2021/TT-BYT; thực hành an toàn thuốc (ISMP)
- [ ] `IND-HEALTH-006` **MUST** Định danh bệnh nhân bằng số định danh cá nhân/VNeID hoặc mã BHYT + mã nội bộ; ghép bản ghi có điểm tin cậy và xác nhận thủ công khi dưới ngưỡng; hỗ trợ merge/unmerge có audit. → Kiểm: test 2 bệnh nhân trùng tên+ngày sinh không tự ghép; unmerge khôi phục đúng. · Nguồn: TT 13/2025/TT-BYT (kết nối số định danh); NĐ 102/2025/NĐ-CP
- [ ] `IND-HEALTH-007` **MUST** Sao lưu dữ liệu y tế mã hoá, có bản dự phòng, diễn tập khôi phục định kỳ; RPO/RTO công bố cho cơ sở KCB. → Kiểm: biên bản diễn tập ≤ 6 tháng; số đo RPO/RTO; xem [`../15-operations/backup-and-disaster-recovery.md`](../15-operations/backup-and-disaster-recovery.md). · Nguồn: TT 13/2025/TT-BYT (lưu trữ dự phòng, phục hồi); HIPAA §164.308(a)(7)
- [ ] `IND-HEALTH-008` **MUST** Không chia sẻ dữ liệu sức khoẻ cho bên thứ ba (bảo hiểm thương mại, đối tác) nếu không có yêu cầu bằng văn bản của chủ thể hoặc căn cứ pháp luật; mọi chia sẻ ghi `consent_document_id`. → Kiểm: API xuất dữ liệu yêu cầu tham chiếu đồng ý; test thiếu → 403. · Nguồn: Luật 91/2025/QH15 Đ.26; HIPAA §164.508
- [ ] `IND-HEALTH-009` **MUST** Quy trình thông báo vi phạm dữ liệu: ≤ 72 h tới Bộ Công an và chủ thể (VN); ≤ 60 ngày tới cá nhân/HHS (HIPAA) nếu áp dụng; runbook có mẫu. → Kiểm: runbook + diễn tập tabletop hằng năm; xem [`../15-operations/incident-response.md`](../15-operations/incident-response.md). · Nguồn: Luật 91/2025/QH15 Đ.23; 45 CFR §164.404
- [ ] `IND-HEALTH-010` **MUST** Liên thông theo chuẩn: FHIR (R4/R5) hoặc HL7 v2 cho hệ thống nội bộ; XML theo QĐ 130/4750 cho BHYT; mọi thông điệp validate theo schema trước khi nhận/gửi. → Kiểm: test contract với FHIR validator/XSD; lỗi schema không được ghi vào kho lâm sàng; xem [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md). · Nguồn: QĐ 130/QĐ-BYT; HL7 FHIR R5
- [ ] `IND-HEALTH-011` **MUST** Gửi dữ liệu BHYT/CSDL y tế quốc gia idempotent theo mã lượt khám; thất bại nửa lô gửi lại không tạo trùng; có đối chiếu số lượt gửi/nhận hằng ngày. → Kiểm: test gửi lại lô lỗi; báo cáo đối chiếu. · Nguồn: QĐ 130/QĐ-BYT; NĐ 102/2025/NĐ-CP
- [ ] `IND-HEALTH-012` **MUST** Chữ ký số/xác nhận điện tử khi khoá bệnh án, đơn thuốc, kết quả; có dấu thời gian tin cậy. → Kiểm: bản ghi đã ký kèm chứng thư + timestamp xác minh được. · Nguồn: TT 13/2025/TT-BYT; Luật GDĐT 20/2023/QH15; NĐ 23/2025/NĐ-CP
- [ ] `IND-HEALTH-013` **MUST** Thời hạn lưu hồ sơ bệnh án theo loại (ít nhất 10 năm; dài hơn cho tử vong/tâm thần/ghép tạng theo quy định hiện hành) được cấu hình; không xoá trước hạn; de-identify khi dùng nghiên cứu. → Kiểm: data map có retention từng loại hồ sơ dẫn nguồn văn bản; job xoá bỏ qua hồ sơ chưa hết hạn (test). · Nguồn: Luật KBCB 15/2023/QH15 Đ.69; Luật Lưu trữ 33/2024/QH15; (chưa xác minh) mốc 10/20/30 năm theo TT của Bộ Y tế
- [ ] `IND-HEALTH-014` **MUST@L** Hệ thống của cơ sở KCB công lập/CSDL quốc gia xác định cấp độ ATTT (thường ≥ 3) và áp dụng biện pháp theo cấp độ; lưu trữ dữ liệu người dùng VN trong nước. → Kiểm: hồ sơ cấp độ được phê duyệt; region kho dữ liệu = VN. · Nguồn: Luật ANM 116/2025/QH15 Đ.8; NĐ 333/2026/NĐ-CP Đ.19
- [ ] `IND-HEALTH-015` **MUST** AI hỗ trợ lâm sàng chỉ **gợi ý**, bác sĩ xác nhận; log đầu vào/đầu ra/phiên bản model; phân loại rủi ro cao và đánh giá sự phù hợp trước khi dùng; có kênh báo cáo sự cố. → Kiểm: UI không cho ký khi chưa có xác nhận người; log model_version; hồ sơ phân loại theo NĐ 142/2026; xem [`../13-ai-engineering/guardrails-and-safety.md`](../13-ai-engineering/guardrails-and-safety.md). · Nguồn: Luật AI 134/2025/QH15 Đ.9; NĐ 142/2026/NĐ-CP; EU AI Act Annex III
- [ ] `IND-HEALTH-016` **MUST@L** Phần mềm là thiết bị y tế (chẩn đoán/điều trị): áp dụng vòng đời IEC 62304 (phân lớp A/B/C), quản lý rủi ro ISO 14971, hồ sơ kỹ thuật MDR 2017/745 (Rule 11) hoặc đăng ký thiết bị y tế VN; không phải SaMD thì ghi rõ lý do. → Kiểm: ADR phân loại; hồ sơ kỹ thuật; test theo lớp. · Nguồn: MDR 2017/745 Annex VIII Rule 11; IEC 62304
- [ ] `IND-HEALTH-017` **SHOULD** Giao diện lâm sàng: tương phản/khả năng tiếp cận WCAG 2.2 AA, xác nhận hai bước cho thao tác nguy hiểm (kê thuốc liều cao, xoá kết quả), hiển thị đơn vị cạnh mọi số. → Kiểm: axe = 0 lỗi nghiêm trọng; test E2E hộp thoại xác nhận; xem [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md). · Nguồn: WCAG 2.2; ISO 9241-210
- [ ] `IND-HEALTH-018` **SHOULD** Dữ liệu dùng cho nghiên cứu/huấn luyện AI được de-identify (xoá 18 loại định danh kiểu HIPAA Safe Harbor hoặc chuyên gia đánh giá), DICOM xoá tag định danh. → Kiểm: script de-id + test không còn PII; DICOM header không có PatientName. · Nguồn: 45 CFR §164.514(b); GDPR Art. 89
- [ ] `IND-HEALTH-019` **SHOULD** Telehealth/video: kênh mã hoá đầu cuối hoặc TLS 1.3 + lưu bản ghi chỉ khi có đồng ý; thời gian/múi giờ lịch hẹn hiển thị theo bệnh nhân. → Kiểm: cấu hình TLS; test đồng ý trước khi ghi hình. · Nguồn: Luật 91/2025/QH15 Đ.9; HIPAA §164.312(e)
- [ ] `IND-HEALTH-020` **SHOULD** Đơn thuốc điện tử liên thông hệ thống đơn thuốc quốc gia theo TT 27/2021 (sửa TT 04/2022); mã đơn duy nhất, trạng thái cấp phát. → Kiểm: test gửi đơn và nhận mã; đối chiếu trạng thái. · Nguồn: TT 27/2021/TT-BYT; TT 04/2022/TT-BYT
- [ ] `IND-HEALTH-021` **MAY** Dùng SMART on FHIR/OAuth 2.0 cho app bên thứ ba truy cập dữ liệu bệnh nhân với phạm vi (scope) theo tài nguyên. → Kiểm: scope tối thiểu; test app chỉ đọc đúng tài nguyên. · Nguồn: HL7 SMART App Launch
- [ ] `IND-HEALTH-022` **MAY** Cung cấp cho bệnh nhân bản sao hồ sơ máy đọc được (FHIR JSON/PDF) tự phục vụ. → Kiểm: endpoint xuất + test. · Nguồn: Luật 91/2025/QH15 Đ.4; GDPR Art. 20

## Cổng chất lượng tương đương

| Cổng chung | Tương đương y tế | Ngưỡng |
|---|---|---|
| CWV/hiệu năng | Màn hình kê đơn/khám tải ≤ 2 s p95 trên mạng bệnh viện; API tra cứu bệnh nhân ≤ 300 ms p95 | k6 + RUM |
| Độ phủ test | 100% nhánh của tính liều, ghép bệnh nhân, phân quyền; test ca biên có bảng | coverage + mutation ≥ 80% (nâng từ 70% của [`QA-COV-005`](../14-testing-quality/coverage-and-mutation.md)) |
| Bảo mật | ASVS 5.0 L2+; pentest hằng năm; 0 PHI trong log | scan + pentest |
| Đúng dữ liệu | 0 lỗi schema khi gửi BHYT; đối chiếu lượt gửi = nhận | job + alert |
| Sẵn sàng | Diễn tập khôi phục ≤ 6 tháng; RTO đạt công bố | biên bản |

## Bẫy

- **Dùng tên + ngày sinh làm khoá bệnh nhân** → ghép nhầm, kê đơn nhầm người.
- **Liều lưu dạng chuỗi tự do** ("1 viên x2") → không kiểm tra được.
- **Log debug in cả HL7/FHIR message** chứa PHI → vi phạm.
- **"Xoá mềm" hồ sơ** khi pháp luật bắt lưu 10+ năm → mâu thuẫn với DSAR xoá; phải giải thích căn cứ pháp lý từ chối xoá.
- **Gửi bệnh án qua LLM API nước ngoài** để tóm tắt → chuyển dữ liệu nhạy cảm xuyên biên giới không hồ sơ.
- **Break-glass không hậu kiểm** → mọi người dùng "khẩn cấp" để xem hồ sơ.
- **Chỉ dựa TT 46/2018** đã hết hiệu lực từ 21/07/2025.
- **AI "tự động ký"** kết quả → vi phạm nguyên tắc người quyết định.

## Nguồn

- Luật Khám bệnh, chữa bệnh 15/2023/QH15 (09/01/2023, hiệu lực 01/01/2024), Đ.69: <https://hethongphapluat.com/luat-kham-benh-chua-benh-2023/dieu-69> — xác minh 2026-10-13; kiểm tra văn bản sửa đổi trước khi áp dụng.
- Thông tư 13/2025/TT-BYT (06/06/2025, hiệu lực 21/07/2025, thay TT 46/2018/TT-BYT): <https://caselaw.vn/van-ban-phap-luat/587211-thong-tu-so-13-2025-tt-byt-ngay-06-06-2025-cua-bo-truong-bo-y-te-huong-dan-trien-khai-ho-so-benh-an-dien-tu> — xác minh 2026-10-13.
- Nghị định 102/2025/NĐ-CP (13/05/2025, hiệu lực 01/07/2025): <https://luatvietnam.vn/y-te/nghi-dinh-102-2025-nd-cp-cua-chinh-phu-quy-dinh-quan-ly-du-lieu-y-te-400071-d1.html> — xác minh 2026-10-13.
- Thông tư 27/2021/TT-BYT (hiệu lực 15/02/2022) và TT 04/2022/TT-BYT (15/09/2022): <https://caselaw.vn/van-ban-phap-luat/401810-thong-tu-so-27-2021-tt-byt-ngay-20-12-2021-cua-bo-truong-bo-y-te-quy-dinh-ke-don-thuoc-bang-hinh-thuc-dien-tu> — xác minh 2026-10-13.
- Quyết định 130/QĐ-BYT (18/01/2023) và QĐ 4750/QĐ-BYT (29/12/2023): <https://luatvietnam.vn/y-te/quyet-dinh-130-qd-byt-241607-d1.html> — xác minh 2026-10-13.
- Thông tư 32/2023/TT-BYT: <https://trungtamytekhanhson.khanhhoa.gov.vn/wp-content/uploads/2024/01/Thông-tư-32-2023-TT-BYT.pdf> — xác minh tồn tại 2026-10-13; (chưa xác minh) điều khoản thời hạn lưu hồ sơ bệnh án 10/20/30 năm (nguồn thứ cấp dẫn TT 33/2025/TT-BYT).
- Luật Lưu trữ 33/2024/QH15 (21/06/2024, hiệu lực 01/07/2025): <https://hethongphapluat.com/luat-luu-tru-2024.html> — xác minh 2026-10-13.
- HL7 FHIR R5 5.0.0 (bản current published): <https://www.hl7.org/fhir/> — xác minh 2026-10-13; Vietnam Core IG (R4, bản công bố của HL7 Việt Nam, v0.10.0 lúc đọc): <https://fhir.hl7.org.vn/> — xác minh 2026-10-14 (link build.fhir.org cũ 404).
- HIPAA Security Rule (45 CFR 160, 164 Subparts A, C): <https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html>; Breach Notification Rule (§§164.400–414, 60 ngày): <https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html> — xác minh 2026-10-13; NPRM Security Rule (06/01/2025) chưa thành bản cuối — nguồn thứ cấp 2026-10-13.
- EHDS Regulation (EU) 2025/327 (hiệu lực 26/03/2025, áp dụng 26/03/2027): <https://www.eumonitor.eu/9353000/1/j9vvik7m1c3gyxp/vmlg5gptv7zp> — xác minh gián tiếp 2026-10-13.
- EU MDR 2017/745 Rule 11; IEC 62304: <https://blog.johner-institute.com/regulatory-affairs/mdr-software/> — nguồn thứ cấp, xác minh 2026-10-13; (chưa xác minh) bản EUR-Lex không truy cập được qua công cụ.
- Luật AI 134/2025/QH15 và NĐ 142/2026/NĐ-CP: xem [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md).
