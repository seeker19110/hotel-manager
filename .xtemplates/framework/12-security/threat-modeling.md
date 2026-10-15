---
title: Threat model (STRIDE), tài sản, ranh giới tin cậy, biện pháp
kind: module
prefix: SEC-TM
applies_to: [all]
updated: 2026-10-14
---

# Threat model (STRIDE), tài sản, ranh giới tin cậy, biện pháp

> Threat model là **đầu ra bắt buộc của G4 (Thiết kế)**: liệt kê tài sản, vẽ luồng dữ liệu qua ranh giới tin cậy, dò mối đe doạ
> theo STRIDE, xếp mức rủi ro và gắn **biện pháp kiểm được bằng máy** cho mọi mối đe doạ mức cao. Mẫu điền:
> [`../templates/THREAT-MODEL.md`](../templates/THREAT-MODEL.md). Các lớp lỗ hổng cụ thể nằm ở
> [`appsec-web.md`](appsec-web.md), [`ai-security.md`](ai-security.md), [`infrastructure-and-network.md`](infrastructure-and-network.md).

## Nguyên tắc

- **Bốn câu hỏi** (OWASP Threat Modeling Cheat Sheet): *Đang xây gì?* → *Có thể hỏng chỗ nào?* → *Làm gì với nó?* → *Đã làm đủ chưa?*
  Mỗi câu hỏi có một đầu ra kiểm được: sơ đồ luồng dữ liệu (DFD) · bảng mối đe doạ · bảng biện pháp · bằng chứng (test/scan/cấu hình).
- **Mô hình hoá theo luồng dữ liệu, không theo tính năng.** Mối đe doạ nằm ở chỗ dữ liệu **vượt ranh giới tin cậy** (trình duyệt→API,
  API→CSDL, ứng dụng→dịch vụ bên thứ ba, nội dung ngoài→LLM, agent→tool). Mỗi ranh giới là một hàng trong bảng.
- **STRIDE là bộ gợi ý, không phải bộ đếm.** Spoofing (xác thực) · Tampering (toàn vẹn) · Repudiation (trách nhiệm) · Information
  disclosure (bí mật) · Denial of service (sẵn sàng) · Elevation of privilege (phân quyền). Mỗi phần tử DFD hỏi đủ 6 chữ rồi mới loại bỏ.
- **Mỗi mối đe doạ có đúng một quyết định**: giảm thiểu (mitigate) · loại bỏ (eliminate) · chuyển giao (transfer) · chấp nhận (accept, có
  người ký và hạn xem lại). Không có trạng thái "đang xem xét" khi qua cổng G4.
- **Biện pháp phải trỏ tới cổng máy** (ID checklist của khung, test, scanner, cấu hình) — "đã xử lý" không có bằng chứng là chưa xử lý
  (nguyên tắc P1). Threat model **sống cùng code**: đổi kiến trúc/thêm ranh giới → cập nhật, qua review như code.
- **Tài sản trước, kỹ thuật sau.** Liệt kê thứ kẻ tấn công muốn (dữ liệu cá nhân, tiền, khoá, uy tín, năng lực tính toán) rồi mới tìm đường tới.

## Quyết định

| Tình huống | Phương pháp | Độ sâu | Khi nào không dùng |
|---|---|---|---|
| Mặc định mọi dự án ≥ M | STRIDE theo phần tử DFD (per-element) | DFD mức C4-1/2; bảng mối đe doạ theo ranh giới | Dự án S không có dữ liệu thật → bảng 1 trang "tài sản + 5 mối đe doạ hàng đầu" |
| Hệ có AI agent/tool | STRIDE + ánh xạ OWASP ASI01–10 và LLM01–10 | Thêm ranh giới "nội dung ngoài → model" và "model → tool" | — (bắt buộc với hồ sơ ai-agent/agentic-system; chi tiết ở [`ai-security.md`](ai-security.md)) |
| Ngành bị quản lý (fintech, y tế, chính phủ) | STRIDE + bảng kiểm soát theo chuẩn ngành | Mỗi mối đe doạ ánh xạ sang yêu cầu luật (trỏ [`../16-compliance-privacy/README.md`](../16-compliance-privacy/README.md)) | — |
| Cần kịch bản kẻ tấn công cụ thể | Attack tree cho 1–3 tài sản quý nhất | Bổ sung, không thay STRIDE | Khi chưa có DFD (sẽ thành danh sách tưởng tượng) |
| Xếp hạng rủi ro | Likelihood × Impact 3 mức (Thấp/Vừa/Cao) | Đủ cho hầu hết; CVSS chỉ dùng cho lỗ hổng cụ thể | Đừng dùng DREAD cũ (điểm chủ quan, không tái lập) |

Công cụ: **OWASP Threat Dragon** (Apache-2.0, vẽ DFD + STRIDE, lưu JSON trong repo) hoặc **pytm** (threat-model-as-code, Python) —
xác minh phiên bản trước khi dùng; tài liệu Markdown theo mẫu của khung là đủ cho đa số dự án.

## Checklist

- [ ] `SEC-TM-001` **MUST** Có file `docs/THREAT-MODEL.md` theo mẫu khung, được tạo ở G4 và cập nhật khi thêm ranh giới tin cậy mới. → Kiểm: file tồn tại; CI kiểm `updated` trong frontmatter không cũ hơn ADR kiến trúc mới nhất (script so ngày). · Nguồn: OWASP Threat Modeling CS; NIST SSDF PW.1
- [ ] `SEC-TM-002` **MUST@L** Bảng tài sản liệt kê dữ liệu/khoá/tiền/năng lực cần bảo vệ, mỗi tài sản có mức nhạy cảm và chủ sở hữu. → Kiểm: mục "Tài sản" có ≥ 1 hàng mỗi loại dữ liệu trong schema có cột nhạy cảm (đối chiếu [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md)). · Nguồn: ASVS 5.0 V15
- [ ] `SEC-TM-003` **MUST** Có sơ đồ luồng dữ liệu (DFD) đánh dấu mọi ranh giới tin cậy: client↔server, server↔CSDL, server↔bên thứ ba, nội dung ngoài↔LLM, agent↔tool. → Kiểm: sơ đồ (Mermaid/Threat Dragon JSON) trong repo; mỗi tích hợp bên ngoài trong `docs/` hoặc cấu hình env xuất hiện trên sơ đồ. · Nguồn: OWASP Threat Modeling CS §"What are we working on"
- [ ] `SEC-TM-004` **MUST@L** Mỗi phần tử DFD được rà đủ 6 loại STRIDE; mối đe doạ không áp dụng ghi "N/A + lý do". → Kiểm: bảng mối đe doạ có cột STRIDE; script đếm mỗi phần tử × 6 ô đều có giá trị. · Nguồn: OWASP Threat Modeling CS §STRIDE
- [ ] `SEC-TM-005` **MUST** Mỗi mối đe doạ có mức rủi ro (khả năng × tác động, 3 bậc) và quyết định: mitigate / eliminate / transfer / accept. → Kiểm: không còn hàng thiếu mức hoặc thiếu quyết định (grep bảng). · Nguồn: OWASP Threat Modeling CS §"What are we going to do"
- [ ] `SEC-TM-006` **MUST** Mọi mối đe doạ mức **Cao** có biện pháp trỏ tới ID checklist khung, test hoặc cấu hình cụ thể — không có hàng Cao ở trạng thái "accept" khi lên production. → Kiểm: `blueprint-status` của các ID được trỏ = đạt; cổng G4 chặn nếu còn Cao chưa có biện pháp. · Nguồn: NIST SSDF PW.1.1
- [ ] `SEC-TM-007` **MUST@L** Mối đe doạ "accept" có người ký, lý do và ngày xem lại (≤ 12 tháng). → Kiểm: cột Người ký + Hạn xem lại không rỗng; CI cảnh báo khi quá hạn. · Nguồn: ISO/IEC 27005 (chấp nhận rủi ro có chủ)
- [ ] `SEC-TM-008` **MUST@L** Đầu vào từ mọi ranh giới tin cậy được đánh dấu "không tin" và có biện pháp validate ở biên (trỏ [`appsec-web.md`](appsec-web.md), [`ai-security.md`](ai-security.md)). → Kiểm: mỗi mũi tên vào hệ thống trên DFD có tham chiếu tới middleware/schema validate trong code. · Nguồn: ASVS 5.0 V2; P6
- [ ] `SEC-TM-009` **SHOULD** Threat model được review bởi người không viết thiết kế (hoặc agent reviewer khác model với tác giả) trước cổng G4. → Kiểm: PR threat model có ≥ 1 approval khác tác giả. · Nguồn: OWASP Threat Modeling CS §"Did we do a good enough job"
- [ ] `SEC-TM-010` **SHOULD** Có mục "Giả định tin cậy" liệt kê thứ hệ thống tin mà không kiểm (vd CSDL quản lý của cloud, OS của người dùng) để lộ rõ điểm mù. → Kiểm: mục tồn tại, ≥ 3 giả định. · Nguồn: NIST SP 800-207 (không tin theo vị trí mạng)
- [ ] `SEC-TM-011` **SHOULD** Hệ có AI: thêm hàng cho từng ASI01–10 (OWASP Agentic 2026) với trạng thái áp dụng/N/A. → Kiểm: bảng ánh xạ ASI trong threat model; chi tiết biện pháp ở `SEC-AI-*`. · Nguồn: OWASP Top 10 Agentic 2026
- [ ] `SEC-TM-012` **SHOULD** Có attack tree cho 1–3 tài sản quý nhất (tiền, dữ liệu nhạy cảm, khoá ký) khi dự án ≥ M. → Kiểm: mục Attack tree với ≥ 1 cây, lá cây trỏ biện pháp. · Nguồn: OWASP Threat Modeling CS (attack trees)
- [ ] `SEC-TM-013` **SHOULD** Mỗi sự cố bảo mật (SEV1–2) hoặc lỗ hổng tìm thấy ở production được đối chiếu lại threat model: thiếu hàng → thêm hàng + hàng rào mới. → Kiểm: post-mortem có mục "Threat model đã dự đoán? có/không"; commit cập nhật threat model liên kết từ post-mortem. · Nguồn: P12; [`../15-operations/incident-response.md`](../15-operations/incident-response.md)
- [ ] `SEC-TM-014` **SHOULD** Threat model là code: lưu Markdown/JSON trong repo, đổi qua PR, có CODEOWNERS là người phụ trách bảo mật. → Kiểm: `CODEOWNERS` có dòng cho `docs/THREAT-MODEL.md`. · Nguồn: NIST SSDF PO.3
- [ ] `SEC-TM-015` **MUST@L** Threat model được review độc lập (bên ngoài đội) trước khi lên production và sau mỗi thay đổi kiến trúc lớn. → Kiểm: biên bản review có tên/ngày, lưu `docs/security/`. · Nguồn: ASVS 5.0 (mức L3 cần đánh giá sâu)
- [ ] `SEC-TM-016` **MAY** Dùng công cụ threat-model-as-code (pytm/Threat Dragon) sinh bảng tự động từ DFD để tránh bỏ sót phần tử. → Kiểm: file nguồn + output sinh commit cùng nhau. · Nguồn: OWASP Threat Dragon
- [ ] `SEC-TM-017` **MAY** Bảng "mối đe doạ hàng đầu" (top 5) được nhắc trong `PROJECT.md` để mọi PR lớn đối chiếu. → Kiểm: `PROJECT.md` có mục trỏ threat model. · Nguồn: kinh nghiệm khung cũ (GĐ 2 thiết kế)

## Bẫy thường gặp

1. **Threat model một lần rồi quên.** Viết ở G4, không cập nhật khi thêm webhook/LLM/tool → ranh giới mới không ai rà. Tránh: `SEC-TM-001` + checklist PR "có thêm ranh giới tin cậy mới không?".
2. **Liệt kê lỗ hổng thay vì mối đe doạ.** "XSS, SQLi, CSRF" là lớp lỗ hổng chung, không gắn với tài sản/luồng của hệ này. Tránh: đi từ DFD, mỗi hàng ghi *ai → làm gì → với tài sản nào → qua ranh giới nào*.
3. **Mọi thứ đều "Cao"** (hoặc đều "Thấp") → không ưu tiên được. Tránh: định nghĩa 3 bậc tác động theo tài sản (mất tiền thật, lộ PII, gián đoạn < 1h…) trước khi chấm.
4. **Biện pháp là câu văn** ("kiểm tra kỹ đầu vào") không trỏ cổng máy → không ai biết đã làm chưa. Tránh: `SEC-TM-006`.
5. **Bỏ qua ranh giới nội bộ** ("service nội bộ nên tin nhau"). Zero trust: service↔service vẫn xác thực, phân quyền (NIST SP 800-207).
6. **Coi output của LLM/tool là tin cậy.** Nội dung ngoài → model → tool là chuỗi ranh giới; mỗi bước là một hàng STRIDE (ASI01, ASI02).
7. **Chấp nhận rủi ro ngầm.** "Để sau" không ghi người ký = accept không chủ. Tránh: `SEC-TM-007`.
8. **Threat model cho sản phẩm nhưng quên pipeline.** CI/CD, secret trong runner, action bên thứ ba cũng là ranh giới (xem [`supply-chain.md`](supply-chain.md)).

## Cổng tự động

| Việc | Công cụ / lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| File tồn tại + frontmatter tươi | script repo: so `updated` của `THREAT-MODEL.md` với ADR mới nhất | CI (job docs) | lệch > 0 ngày sau ADR kiến trúc → đỏ |
| Bảng đủ cột | script grep bảng Markdown: cột STRIDE, Mức, Quyết định, Biện pháp, Người ký | CI | hàng thiếu ô → đỏ |
| Cao có biện pháp | `xt.py blueprint-status BLUEPRINT.md --strict` với các ID được trỏ | Cổng G4 / G7 | còn Cao chưa có ID đạt → NO-GO |
| Review độc lập | CODEOWNERS + branch protection yêu cầu review | GitHub/GitLab | PR sửa threat model cần ≥ 1 approval |
| Vẽ/kiểm DFD | OWASP Threat Dragon (Apache-2.0) hoặc pytm (`python3 tm.py --report`) | local / CI | sinh báo cáo từ nguồn trong repo |

## Nguồn

- OWASP Threat Modeling Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html> — xác minh 2026-10-13 (bốn câu hỏi, STRIDE, mitigate/eliminate/transfer/accept).
- OWASP ASVS 5.0.0 (05/2025), chương V2 Validation & Business Logic, V15 Secure Coding & Architecture: <https://owasp.org/www-project-application-security-verification-standard/> — xác minh 2026-10-13.
- NIST SP 800-218 SSDF v1.1 (02/2022), practice PW.1 (thiết kế đáp ứng yêu cầu bảo mật, threat modeling), PO.3: <https://csrc.nist.gov/pubs/sp/800/218/final> — xác minh 2026-10-13; bản Rev.1 (SSDF 1.2) đang ở Initial Public Draft 2025-12-17: <https://csrc.nist.gov/pubs/sp/800/218/r1/ipd>.
- NIST SP 800-207 Zero Trust Architecture (08/2020): <https://csrc.nist.gov/pubs/sp/800/207/final> — xác minh 2026-10-13.
- OWASP Top 10 for Agentic Applications 2026 (ASI01–10, công bố 2025-12-09): ghi theo `research/2026-10-13-ai-agent-research.md` §5.1 [F]; trang genai.owasp.org trả 403 khi fetch lại ngày 2026-10-13.
- ISO/IEC 27005 (quản lý rủi ro an toàn thông tin) — (chưa xác minh phiên bản hiện hành ngày 2026-10-13; tiêu chuẩn trả phí).
- Khung cũ X-stored `docs/specs/AI-HARNESS-AND-COMPANY-SPEC.md` §A4.5 (ánh xạ ASI), commit `1b80fe4`; catalog `seeker19110/stored` mục 09 §1.3 (STRIDE trong checklist Security), đọc 2026-10-13.
