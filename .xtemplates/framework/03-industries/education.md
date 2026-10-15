---
title: Giáo dục · edtech · trẻ em
kind: industry
slug: education
prefix: IND-EDU
modules: [16-compliance-privacy/*, 12-security/appsec-web, 12-security/ai-security, 12-security/logging-audit-and-incident, 08-backend/authn-authz, 08-backend/files-and-media, 08-backend/realtime-and-streaming, 09-database/sensitive-data-and-access, 09-database/data-modeling, 06-design-ux/accessibility, 06-design-ux/content-and-microcopy, 06-design-ux/responsive-and-mobile-first, 07-frontend/performance-web-vitals, 13-ai-engineering/guardrails-and-safety, 14-testing-quality/e2e-and-accessibility, 14-testing-quality/unit-and-logic-edge-cases, 18-cross-cutting/i18n-and-l10n]
updated: 2026-10-14
---

# Gói ngành: Giáo dục · edtech · trẻ em

> Ghép cho LMS, lớp học trực tuyến, app học tập, thi/đánh giá, quản lý trường, gia sư AI, nền tảng cho trẻ em. Điểm
> khác biệt: **người dùng là trẻ em** (< 16 tuổi theo luật VN) và **dữ liệu học tập** quyết định tương lai một người —
> nên mặc định riêng tư, có người đại diện, không quảng cáo hành vi, điểm số và học bạ phải đúng tuyệt đối và truy vết.

## Khi nào dùng

Dùng khi có **người học dưới 18** (đặc biệt < 16), lưu **kết quả học tập/học bạ/điểm thi**, hoặc tích hợp với trường/Sở/
Bộ (CSDL ngành, học bạ số). Nền tảng đào tạo nội bộ doanh nghiệp cho người lớn chỉ cần phần dữ liệu học tập
(IND-EDU-010…) và bỏ phần trẻ em (`[~] — Miễn: không có người học dưới 16`).

## Kiến trúc tham chiếu

```text
[Học sinh app/web] ─┐                    ┌─ Identity: SSO trường (OIDC/SAML/LTI 1.3), vai: học sinh/phụ huynh/giáo viên/quản trị
[Phụ huynh]  ───────┼─► [API/BFF] ──────►├─ Roster (OneRoster 1.2) · Lớp · Khoá học · Bài tập
[Giáo viên]  ───────┘                    ├─ Assessment: ngân hàng câu hỏi (QTI 3.0), thi, chấm (append-only, audit)
                                          ├─ Gradebook/Học bạ: bất biến + phiên bản + ký số; xuất CSDL ngành/học bạ số
                                          ├─ Content/Media: video (DRM nếu cần), tài liệu, UGC có kiểm duyệt
                                          ├─ Analytics học tập (xAPI/Caliper) — giả danh hoá, không quảng cáo
                                          └─ AI tutor: guardrail nội dung trẻ em, không thu thêm dữ liệu, có người giám sát
```

## Thành phần đặc thù khuyến nghị (xác minh lại trước khi dùng)

| Thành phần | Mặc định | Ghi chú |
|---|---|---|
| Tích hợp LMS/công cụ | 1EdTech LTI 1.3 + LTI Advantage (AGS 2.0, NRPS 2.0, Deep Linking 2.0) | Thay cho LTI 1.1 (đã lỗi thời); xác minh phiên bản tại standards.1edtech.org |
| Danh sách lớp | OneRoster 1.2 (REST/CSV) | Đồng bộ từ hệ thống trường |
| Câu hỏi/đề thi | QTI 3.0 (chưa xác minh trạng thái bản mới nhất 2026-10-13) | Hoặc định dạng nội bộ có export QTI |
| Analytics học tập | xAPI / Caliper Analytics 1.2 (chưa xác minh) với LRS riêng | ID giả danh hoá |
| Tiếp cận | WCAG 2.2 AA; nội dung đọc được theo lớp tuổi | [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md) |
| Dạy học trực tuyến | Theo TT 09/2021/TT-BGDĐT (quản lý, tổ chức, kiểm tra đánh giá) | Kiểm tra định kỳ có quy định riêng |

## Khung pháp lý

**Việt Nam (xác minh 2026-10-13 — kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng):**

| Văn bản | Ban hành · Hiệu lực | Nội dung với phần mềm | Nguồn |
|---|---|---|---|
| Luật Trẻ em 102/2016/QH13 | 05/04/2016 · 01/06/2017 | Đ.1 trẻ em < 16; Đ.21 quyền bí mật đời sống riêng tư; Đ.54 trách nhiệm bảo vệ trên môi trường mạng | hethongphapluat |
| NĐ 56/2017/NĐ-CP | 09/05/2017 · 01/07/2017 | Đ.33 thông tin bí mật đời sống riêng tư (gồm kết quả học tập, trường lớp, bạn bè); Đ.35 trách nhiệm doanh nghiệp (cảnh báo, gỡ, kiểm soát thời gian chơi game); Đ.36 đồng ý cha mẹ + trẻ ≥ 7 tuổi | hethongphapluat |
| Luật BVDLCN 91/2025/QH15 + NĐ 356/2025/NĐ-CP (thay NĐ 13/2023 từ 01/01/2026) | 01/01/2026 | Đ.24 dữ liệu trẻ em: người đại diện thực hiện quyền; ngừng xử lý khi rút; Đ.9 đồng ý; Đ.29 MXH; Đ.30 AI | xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) |
| Luật An ninh mạng 116/2025/QH15 Đ.16 | 01/07/2026 | Phòng chống xâm hại trẻ em: kiểm soát/gỡ nội dung gây hại, hệ thống kỹ thuật ngăn chặn; cha mẹ đăng ký tài khoản dịch vụ giá trị gia tăng cho trẻ | hethongphapluat Đ.16 |
| NĐ 147/2024/NĐ-CP | 09/11/2024 · 25/12/2024 | Tài khoản MXH dưới 16 do cha mẹ/người giám hộ đăng ký; xác thực SĐT/định danh; gỡ nội dung vi phạm 24 h | luatvietnam |
| Luật Giáo dục 43/2019/QH14 sửa bởi Luật 123/2025/QH15 | 10/12/2025 · 01/01/2026 | Chuyển đổi số toàn diện: hạ tầng số, nền tảng số, CSDL quốc gia về giáo dục (Chính phủ quy định chi tiết) | thuvienphapluat 656970 |
| TT 09/2021/TT-BGDĐT | 30/03/2021 · 16/05/2021 | Quản lý và tổ chức dạy học trực tuyến ở phổ thông/GDTX; kiểm tra định kỳ | hethongphapluat |
| Luật AI 134/2025/QH15 + NĐ 142/2026/NĐ-CP | 01/03/2026; 01/05/2026 | AI trong giáo dục (xếp loại, đánh giá) có thể thuộc danh mục rủi ro cao; cấm khai thác trẻ em; nhãn nội dung AI | xem [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md) |

**Quốc tế (xác minh 2026-10-13):** US FERPA 20 U.S.C. §1232g; 34 CFR Part 99 (quyền xem/sửa hồ sơ ≤ 45 ngày; "school
official" exception; directory information) · COPPA 16 CFR Part 312, bản sửa 90 FR 16918 (22/04/2025; hiệu lực 23/06/2025;
tuân thủ 22/04/2026: đồng ý riêng cho chia sẻ bên thứ ba, chính sách lưu trữ, chương trình bảo mật) · GDPR Art. 8 (đồng ý
trẻ em: 16, quốc gia có thể hạ tới 13) · UK Age Appropriate Design Code; UK Online Safety Act 2023 (nghĩa vụ nội dung bất
hợp pháp từ 17/03/2025; bộ quy tắc bảo vệ trẻ em từ 25/07/2025) · EU AI Act Annex III điểm 3 (giáo dục = rủi ro cao, áp dụng
từ 02/12/2027) · WCAG 2.2; EN 301 549 V3.2.1; Section 508 (US) · 1EdTech LTI 1.3/OneRoster 1.2/QTI/Caliper.

## Mô hình dữ liệu / nghiệp vụ đặc trưng

- **Person** (học sinh/phụ huynh/giáo viên) với **quan hệ giám hộ** (`guardian_of`, có hiệu lực theo thời gian);
  **Enrollment** (học sinh × lớp × năm học, có ngày vào/ra); **Course/Section/Assignment/Submission**.
- **Gradebook append-only:** `grade_event(student, assessment, score, max, scale, graded_by, graded_at, reason)`;
  điểm hiện tại là dẫn xuất; sửa điểm = sự kiện mới có lý do; khoá sổ cuối kỳ + ký.
- **Học bạ/transcript:** snapshot theo kỳ, bất biến, có mã/ký số; xuất theo chuẩn CSDL ngành khi có.
- **Age gate:** `date_of_birth` → `is_minor` tính theo ngày, không lưu cứng; `consent_records` có `guardian_subject_id`.
- **Thời gian:** năm học/kỳ/múi giờ trường; hạn nộp bài theo múi giờ lớp.

## Ca biên nghiệp vụ

1. **Trẻ tròn 16 tuổi giữa năm học:** cờ `is_minor` tự đổi; quyền tự thực hiện chuyển cho trẻ; đồng ý của người đại diện
   trước đó vẫn hợp lệ cho mục đích cũ — nhưng mục đích mới phải hỏi trẻ.
2. **Hai phụ huynh ly hôn, một người rút đồng ý:** quy tắc "người đại diện theo pháp luật" theo giấy tờ; hệ thống cần
   trạng thái tranh chấp và dừng xử lý mục đích không thiết yếu.
3. **Sửa điểm sau khi khoá sổ:** chỉ qua quy trình phúc khảo tạo sự kiện mới có phê duyệt; học bạ đã xuất phải có phiên
   bản mới và dấu vết.
4. **Học sinh chuyển trường giữa kỳ:** enrollment kết thúc có ngày; dữ liệu học tập xuất cho trường mới theo chuẩn; quyền
   xem của giáo viên cũ chấm dứt.
5. **Nộp bài đúng hạn ở múi giờ khác** (học sinh du học/online): hạn theo múi giờ lớp; lưu cả thời điểm UTC và hiển thị.
6. **Thi trực tuyến mất kết nối:** tự lưu từng câu, cho phép nối lại trong cửa sổ, log sự kiện mạng để xử lý khiếu nại.
7. **Trùng học sinh** (cùng tên, cùng lớp): mã học sinh/định danh + ảnh/CCCD của người đại diện, không dựa tên.
8. **AI tutor trả lời nội dung không phù hợp lứa tuổi hoặc làm hộ bài:** guardrail theo tuổi, chế độ "gợi ý, không giải";
   log để giáo viên xem.
9. **Giáo viên tải ảnh lớp có mặt trẻ lên nền tảng công khai:** mặc định riêng tư; đăng công khai cần đồng ý phụ huynh và
   trẻ ≥ 7 tuổi (NĐ 56 Đ.36).
10. **Quảng cáo/khuyến nghị sản phẩm trong app trẻ em:** không cá nhân hoá theo hành vi; không thu dữ liệu cho mục đích tiếp thị.
11. **Xoá tài khoản học sinh nhưng trường phải lưu học bạ:** xoá PII không thiết yếu, giữ hồ sơ học tập theo nghĩa vụ pháp lý với căn cứ.
12. **Bảng xếp hạng công khai điểm** gây tổn thương: mặc định ẩn danh/không công khai; tuỳ chọn do trường bật có kiểm soát.

## Checklist

- [ ] `IND-EDU-001` **MUST** Xác định tuổi khi tạo tài khoản (ngày sinh hoặc dữ liệu từ trường); người học < 16 phải có người đại diện liên kết và bản ghi đồng ý của người đại diện trước khi xử lý ngoài mục đích thiết yếu. → Kiểm: test E2E tạo tài khoản < 16 không có người đại diện → không kích hoạt; `consent_records.guardian_subject_id` bắt buộc. · Nguồn: Luật 91/2025/QH15 Đ.24; NĐ 56/2017/NĐ-CP Đ.36; COPPA 16 CFR 312.5; GDPR Art. 8
- [ ] `IND-EDU-002` **MUST** Mặc định riêng tư cho trẻ em: hồ sơ không công khai, không tìm kiếm được, không chia sẻ với bên thứ ba, tắt định vị/cá nhân hoá; công bố ảnh/thông tin riêng tư cần đồng ý người đại diện **và** trẻ ≥ 7 tuổi. → Kiểm: test trạng thái mặc định tài khoản `is_minor`; luồng đăng công khai yêu cầu 2 đồng ý. · Nguồn: NĐ 56/2017/NĐ-CP Đ.33, Đ.36; Luật 91/2025/QH15 Đ.24; UK AADC
- [ ] `IND-EDU-003` **MUST** Không quảng cáo hành vi/tiếp thị cho tài khoản trẻ em; không dùng dữ liệu học tập của trẻ cho mục đích thương mại hay huấn luyện model ngoài dịch vụ giáo dục. → Kiểm: cờ `is_minor` tắt SDK ads/tracking (test chặn mạng); data map không có mục đích tiếp thị cho dữ liệu trẻ em. · Nguồn: Luật 91/2025/QH15 Đ.24, Đ.28; COPPA 312.2 (hạn chế); FERPA 34 CFR 99.31(a)(1)
- [ ] `IND-EDU-004` **MUST** Phân quyền theo vai và quan hệ: giáo viên chỉ thấy học sinh lớp mình trong thời gian enrollment; phụ huynh chỉ thấy con mình; quản trị trường theo trường; quyền kết thúc khi quan hệ kết thúc. → Kiểm: test quyền với enrollment hết hạn → 403; bộ test chéo vai; xem [`../08-backend/authn-authz.md`](../08-backend/authn-authz.md). · Nguồn: FERPA 34 CFR 99.31; ASVS 5.0 V8
- [ ] `IND-EDU-005` **MUST** Điểm/kết quả đánh giá lưu append-only với người chấm, thời gian, lý do sửa; điểm hiện tại là dẫn xuất; khoá sổ cuối kỳ tạo snapshot bất biến có hash/ký. → Kiểm: test sửa điểm tạo sự kiện mới; snapshot không đổi sau khoá; không có quyền UPDATE trên bảng sự kiện. · Nguồn: Luật GDĐT 20/2023/QH15 (giá trị pháp lý); thực hành nội bộ
- [ ] `IND-EDU-006` **MUST** Học sinh/phụ huynh xem và yêu cầu sửa hồ sơ học tập trong thời hạn công bố (FERPA ≤ 45 ngày; VN theo NĐ 356 — chưa xác minh số điều); có luồng phúc khảo với trạng thái. → Kiểm: giao diện xem hồ sơ + yêu cầu sửa; SLA đo. · Nguồn: FERPA 34 CFR 99.10, 99.20; Luật 91/2025/QH15 Đ.4, Đ.13
- [ ] `IND-EDU-007` **MUST** Nội dung và UGC trên nền tảng có trẻ em: kiểm duyệt (tự động + người), báo cáo/gỡ nội dung gây hại trong 24 h, chặn liên lạc người lạ với trẻ mặc định, công cụ cho phụ huynh/giáo viên. → Kiểm: luồng báo cáo có SLA; test tin nhắn từ người ngoài lớp bị chặn với tài khoản trẻ; log gỡ. · Nguồn: Luật ANM 116/2025/QH15 Đ.16; NĐ 56/2017/NĐ-CP Đ.35; NĐ 147/2024/NĐ-CP; UK OSA 2023
- [ ] `IND-EDU-008` **MUST** Thu thập dữ liệu tối thiểu theo lớp tuổi: không yêu cầu ảnh giấy tờ của trẻ, không sinh trắc học, không định vị chính xác trừ khi thiết yếu và có đồng ý người đại diện; thời hạn lưu ngắn cho dữ liệu hành vi. → Kiểm: data map phân loại `child_data` có retention; schema đăng ký trẻ em không có trường sinh trắc/giấy tờ. · Nguồn: Luật 91/2025/QH15 Đ.3, Đ.24, Đ.31; COPPA 312.10
- [ ] `IND-EDU-009` **MUST** Tiếp cận được: WCAG 2.2 AA toàn bộ luồng học/thi, hỗ trợ bàn phím/đọc màn hình, phụ đề video, kích thước chạm ≥ 24×24 CSS px, nội dung đọc được theo lớp tuổi. → Kiểm: axe trong E2E = 0 lỗi nghiêm trọng; kiểm phụ đề; xem [`../14-testing-quality/e2e-and-accessibility.md`](../14-testing-quality/e2e-and-accessibility.md). · Nguồn: WCAG 2.2 SC 2.5.8, 1.2.2; EN 301 549 V3.2.1; Section 508
- [ ] `IND-EDU-010` **MUST** Thi/đánh giá trực tuyến: tự lưu câu trả lời, nối lại phiên, thời gian máy chủ là chuẩn, log sự kiện (bắt đầu, nộp, mất kết nối) để giải quyết khiếu nại; chấm tự động có test ca biên. → Kiểm: test mất kết nối giữa thi → khôi phục đủ câu; log phiên; test chấm với đáp án biên. · Nguồn: TT 09/2021/TT-BGDĐT; thực hành nội bộ
- [ ] `IND-EDU-011` **MUST@M** AI trong học tập (gia sư, chấm, gợi ý, xếp loại): guardrail nội dung theo tuổi, không thu thêm dữ liệu, giáo viên xem được tương tác, quyết định xếp loại có người duyệt; phân loại rủi ro theo Luật AI (giáo dục có thể cao). → Kiểm: bộ test red-team nội dung trẻ em; cờ `human_review` cho xếp loại; system card; xem [`../13-ai-engineering/guardrails-and-safety.md`](../13-ai-engineering/guardrails-and-safety.md). · Nguồn: Luật AI 134/2025/QH15 Đ.7, Đ.9; EU AI Act Annex III(3); Luật 91/2025/QH15 Đ.30
- [ ] `IND-EDU-012` **MUST@M** Tích hợp trường/LMS qua chuẩn mở (LTI 1.3 + Advantage, OneRoster 1.2) với OAuth 2.0/JWT; không trao đổi danh sách học sinh qua email/Excel thủ công. → Kiểm: contract test LTI launch + AGS; roster sync có log; xem [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md). · Nguồn: 1EdTech LTI 1.3 Core; OneRoster 1.2
- [ ] `IND-EDU-013` **MUST@M** Xuất dữ liệu cho CSDL ngành/học bạ số theo định dạng Bộ GDĐT yêu cầu, idempotent theo mã học sinh/kỳ, có đối chiếu; học bạ xuất có ký số. → Kiểm: test export + validate schema; báo cáo đối chiếu. · Nguồn: Luật Giáo dục sửa đổi 123/2025/QH15 (CSDL quốc gia về giáo dục); Luật GDĐT 20/2023/QH15
- [ ] `IND-EDU-014` **MUST@M** Thị trường Mỹ: FERPA "school official" contract với trường (mục đích hạn chế, không tái tiết lộ, xoá khi hết hợp đồng); COPPA: thông báo trực tiếp + đồng ý có xác minh, đồng ý riêng cho chia sẻ bên thứ ba, chính sách lưu trữ công khai. → Kiểm: hợp đồng mẫu; luồng đồng ý COPPA có xác minh; chính sách lưu trữ công khai. · Nguồn: 34 CFR 99.31(a)(1)(i)(B); 16 CFR 312.4, 312.5, 312.10 (sửa 2025)
- [ ] `IND-EDU-015` **SHOULD** Analytics học tập (xAPI/Caliper) với ID giả danh hoá, mục đích cải thiện học tập ghi trong notice; không bán/chia sẻ; dashboard cho giáo viên không lộ dữ liệu học sinh khác. → Kiểm: schema sự kiện không có PII trực tiếp; data map. · Nguồn: Luật 91/2025/QH15 Đ.3; FERPA
- [ ] `IND-EDU-016` **SHOULD** Thời gian sử dụng/sức khoẻ số: nhắc nghỉ, giới hạn thời gian cho game học tập, không dark pattern giữ chân trẻ (streak phạt, thông báo dồn dập). → Kiểm: cấu hình giới hạn; review UX theo checklist dark pattern. · Nguồn: NĐ 56/2017/NĐ-CP Đ.35 (kiểm soát thời gian chơi); UK AADC
- [ ] `IND-EDU-017` **SHOULD** Nội dung đa ngôn ngữ/ngữ cảnh địa phương (tiếng Việt chuẩn, dân tộc khi cần), định dạng ngày/giờ/kỳ học theo trường. → Kiểm: i18n key đầy đủ; xem [`../18-cross-cutting/i18n-and-l10n.md`](../18-cross-cutting/i18n-and-l10n.md). · Nguồn: thực hành nội bộ
- [ ] `IND-EDU-018` **SHOULD** Hiệu năng trên thiết bị yếu/mạng chậm (nông thôn): bundle nhỏ, offline-first cho bài học, video thích ứng. → Kiểm: Lighthouse trên cấu hình "Moto G/3G"; xem [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md). · Nguồn: Core Web Vitals
- [ ] `IND-EDU-019` **MAY** Xác minh người đại diện bằng VNeID/ví định danh thay vì ảnh giấy tờ. → Kiểm: không lưu ảnh giấy tờ. · Nguồn: NĐ 69/2024/NĐ-CP; Luật 91/2025/QH15 Đ.29
- [ ] `IND-EDU-020` **MAY** Cấp chứng chỉ số có thể xác minh (Open Badges 3.0/Verifiable Credentials). → Kiểm: chứng chỉ xác minh được bằng verifier. · Nguồn: 1EdTech Open Badges 3.0 (chưa xác minh phiên bản 2026-10-13)

## Cổng chất lượng tương đương

| Cổng chung | Tương đương giáo dục | Ngưỡng |
|---|---|---|
| CWV | LCP ≤ 2,5 s trên thiết bị tầm trung/3G cho trang bài học; thi: lưu câu ≤ 1 s | Lighthouse CI cấu hình mạng chậm |
| A11y | WCAG 2.2 AA; phụ đề 100% video học | axe + kiểm thủ công |
| Đúng dữ liệu | 0 lệch giữa điểm dẫn xuất và sự kiện; snapshot học bạ hash khớp | job đối chiếu |
| Bảo vệ trẻ em | Test mặc định riêng tư + chặn liên lạc lạ + tắt ads pass | CI |
| Pháp lý | Đồng ý người đại diện, xuất CSDL ngành, system card AI ✅ | GO/NO-GO |

## Bẫy

- **Age gate "Tôi trên 16" tự khai** cho app rõ ràng dành cho tiểu học.
- **Điểm là cột UPDATE** → không giải thích được khi phụ huynh khiếu nại.
- **Bảng xếp hạng công khai mặc định** → lộ kết quả học tập (thông tin riêng tư theo NĐ 56 Đ.33).
- **Chat lớp cho phép người lạ** hoặc giáo viên nhắn riêng không log.
- **Gửi bài làm của trẻ cho LLM nước ngoài** không hồ sơ chuyển dữ liệu, không redact.
- **LTI 1.1 (OAuth 1.0a) còn dùng** → đã lỗi thời, bảo mật yếu.
- **Hạn nộp theo giờ máy chủ UTC** → học sinh "nộp muộn" lúc 23:30 giờ VN.
- **Xoá tài khoản xoá cả học bạ** → vi phạm nghĩa vụ lưu; hoặc ngược lại, giữ toàn bộ PII "cho chắc".

## Nguồn

- Luật Trẻ em 102/2016/QH13 (hiệu lực 01/06/2017): <https://hethongphapluat.com/luat-tre-em-2016.html>; NĐ 56/2017/NĐ-CP (hiệu lực 01/07/2017) Đ.33–37: <https://hethongphapluat.com/nghi-dinh-56-2017-nd-cp-huong-dan-luat-tre-em.html> — xác minh 2026-10-13; kiểm tra văn bản sửa đổi trước khi áp dụng.
- Luật BVDLCN 91/2025/QH15 Đ.24 và NĐ 356/2025/NĐ-CP (thay NĐ 13/2023 từ 01/01/2026): <https://hethongphapluat.com/luat-bao-ve-du-lieu-ca-nhan-2025/dieu-24> — xác minh 2026-10-13.
- Luật An ninh mạng 116/2025/QH15 Đ.16: <https://hethongphapluat.com/luat-an-ninh-mang-2025/dieu-16> — xác minh 2026-10-13.
- NĐ 147/2024/NĐ-CP (25/12/2024): <https://luatvietnam.vn/tin-van-ban-moi/tu-25-12-2024-tai-khoan-mang-xa-hoi-da-xac-thuc-bang-so-dien-thoai-moi-duoc-dang-bai-186-99855-article.html> — nguồn thứ cấp, 2026-10-13.
- Luật Giáo dục sửa đổi 123/2025/QH15 (10/12/2025, hiệu lực 01/01/2026): <https://thuvienphapluat.vn/van-ban/Giao-duc/Luat-Giao-duc-sua-doi-2025-so-123-2025-QH15-656970.aspx> — xác minh 2026-10-13.
- TT 09/2021/TT-BGDĐT (30/03/2021, hiệu lực 16/05/2021): <https://hethongphapluat.com/phap-luat/the/thong-tu-092021tt-bgddt.html> — xác minh 2026-10-13.
- FERPA 20 U.S.C. §1232g; 34 CFR Part 99: <https://studentprivacy.ed.gov/ferpa> — xác minh 2026-10-13.
- COPPA 16 CFR Part 312 (bản sửa 22/04/2025, hiệu lực 23/06/2025, tuân thủ 22/04/2026): <https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312> (eCFR, HTTP 200) và bản sửa đổi <https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule> (Federal Register, HTTP 200) — xác minh 2026-10-14 (link ftc.gov gốc 404/không truy cập được).
- UK Online Safety Act 2023 (17/03/2025; 25/07/2025): <https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/statement-protecting-children-from-harms-online> — xác minh 2026-10-13.
- 1EdTech LTI 1.3 Advantage: <https://standards.1edtech.org/lti/specifications/guides/implementation_guide/implementation-guide> — xác minh 2026-10-13; (chưa xác minh) phiên bản QTI 3.0, Caliper 1.2, Open Badges 3.0.
- WCAG 2.2 (W3C Recommendation 05/10/2023, bản cập nhật 12/12/2024): <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13.
- EU AI Act Annex III(3) + Omnibus 2026/1744: xem [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md).
