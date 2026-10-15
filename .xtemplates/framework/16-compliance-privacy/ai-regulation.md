---
title: Quy định AI: EU AI Act, minh bạch, phân loại rủi ro, Việt Nam
kind: module
prefix: CMP-AI
applies_to: [ai-agent, agentic-system, data-ml, web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Quy định AI: EU AI Act, minh bạch, phân loại rủi ro, Việt Nam

> Nghĩa vụ **pháp lý** khi sản phẩm có thành phần AI (LLM, model học máy, hệ thống tự động ra quyết định): phân loại
> rủi ro, minh bạch/nhãn nội dung, giám sát của con người, ghi log, báo cáo sự cố — theo Luật Trí tuệ nhân tạo Việt Nam
> 134/2025/QH15 (hiệu lực 01/03/2026) và EU AI Act 2024/1689 (Digital Omnibus 2026/1744 lùi mốc rủi ro cao, **không** hoãn nghĩa vụ minh bạch Điều 50).
> File này là **nhà** của mốc áp dụng EU AI Act; nơi khác trỏ về đây.
> Mối đe doạ kỹ thuật ở [`../12-security/ai-security.md`](../12-security/ai-security.md); guardrail runtime ở
> [`../13-ai-engineering/guardrails-and-safety.md`](../13-ai-engineering/guardrails-and-safety.md); dữ liệu cá nhân trong
> AI ở [`vietnam-data-law.md`](vietnam-data-law.md) (Đ.30).

## Nguyên tắc

1. **Phân loại trước khi xây:** mức rủi ro (VN: cao/trung bình/thấp — Luật AI Đ.9, NĐ 142/2026; EU: cấm/cao/minh bạch/
   tối thiểu + GPAI) quyết định hồ sơ, đánh giá sự phù hợp và thời điểm được phép vận hành.
2. **Người dùng phải biết đang tương tác với AI** và nội dung do AI tạo phải nhận biết được (VN: "dấu hiệu nhận biết
   phù hợp", watermark máy đọc được cho audio/ảnh/video; EU Art. 50 — áp dụng từ 02/08/2026; riêng đánh dấu máy đọc được
   Art. 50(2) cho hệ thống AI tạo nội dung đã đưa ra thị trường EU trước 02/08/2026: hạn 02/12/2026).
3. **Con người giám sát được và dừng được:** không che giấu, làm sai lệch sự giám sát (Luật AI Đ.7); quyết định ảnh
   hưởng đáng kể có người xem lại.
4. **Nhật ký là bằng chứng:** đầu vào, đầu ra, phiên bản model/prompt, người duyệt; sự cố nghiêm trọng báo cáo đúng hạn
   (VN: 72 giờ khẩn cấp / 5 ngày làm việc, báo cáo cuối 15 ngày — NĐ 142/2026).
5. **Hành vi bị cấm là tuyệt đối:** thao túng/lừa dối, khai thác nhóm dễ tổn thương, chấm điểm xã hội, deepfake gây
   hại — không có "bật theo cấu hình".

## Quyết định

| Hệ thống của bạn | VN (Luật 134/2025 + NĐ 142/2026) | EU AI Act (2024/1689 sửa bởi 2026/1744) | Việc phải làm |
|---|---|---|---|
| Chatbot hỗ trợ, tóm tắt, gợi ý nội dung | **Trung bình** nếu có thể gây hiểu lầm đang tương tác với người (Đ.9; NĐ 142 Đ.5–7) | Nghĩa vụ minh bạch Art. 50 (từ **02/08/2026**; đánh dấu Art. 50(2) cho hệ đã lưu hành trước mốc: tới 02/12/2026) | Thông báo "đây là AI", nhãn nội dung, log |
| Tuyển dụng, chấm điểm tín dụng, y tế, giáo dục (xếp loại), hạ tầng, pháp luật, an toàn | **Cao** nếu trong Danh mục do Thủ tướng ban hành (NĐ 142 Đ.5) | **Cao** Annex III — áp dụng từ **02/12/2027** (Omnibus); Annex I (sản phẩm có luật riêng) từ 02/08/2028 | Hồ sơ kỹ thuật, quản lý rủi ro, đánh giá sự phù hợp trước khi dùng, giám sát người, log, báo cáo sự cố |
| Model nền (GPAI/LLM tự huấn luyện) | Theo Luật AI (nhà phát triển) + Luật CNCNS 71/2025 | Nghĩa vụ GPAI từ 02/08/2025 (Art. 53); rủi ro hệ thống Art. 55 | Tài liệu model, chính sách bản quyền, tóm tắt dữ liệu huấn luyện |
| Nhận diện cảm xúc nơi làm việc/trường học, chấm điểm xã hội, thao túng, khai thác trẻ em | **Cấm** (Đ.7) | **Cấm** Art. 5 (từ 02/02/2025); cấm mới (ảnh thân mật/CSAM) từ 02/12/2026 | Không xây; nếu nghi ngờ → dừng và hỏi |
| Công cụ nội bộ, chuẩn bị dữ liệu, có người kiểm soát hiệu quả | **Thấp**/miễn (NĐ 142 ngoại lệ) | Tối thiểu | Minh bạch nội bộ, log cơ bản |
| Hệ thống đã vận hành trước 01/03/2026 | Thông báo trên Cổng một cửa trong 60 ngày từ 01/05/2026; 12–18 tháng chuyển tiếp | High-risk đã có trước mốc: theo điều khoản chuyển tiếp Art. 111 | Hồ sơ phân loại + kế hoạch tuân thủ |

**Mặc định khuyến nghị:** mỗi tính năng AI có **AI system card** (`docs/ai/<tên>.md`: mục đích, mức rủi ro VN/EU, dữ liệu,
đánh giá, giám sát, log, sự cố) sinh từ cùng nguồn với [`../13-ai-engineering/evaluation.md`](../13-ai-engineering/evaluation.md).

## Checklist

- [ ] `CMP-AI-001` **MUST** Mỗi hệ thống/tính năng AI được phân loại rủi ro (VN cao/trung bình/thấp; EU cấm/cao/minh bạch/tối thiểu/GPAI) với lý do, người ký, ngày; phân loại lại khi thay đổi đáng kể, sự cố nghiêm trọng hoặc danh mục mới. → Kiểm: `docs/ai/<tên>.md` có mục "Phân loại" + `classified_at`; CI yêu cầu file này cho module gắn nhãn `ai`. · Nguồn: Luật AI 134/2025/QH15 Đ.9; NĐ 142/2026/NĐ-CP Chương II; EU AI Act Art. 6, Annex III
- [ ] `CMP-AI-002` **MUST** Không xây hành vi bị cấm: thao túng/lừa dối, khai thác trẻ em/người cao tuổi/khuyết tật, chấm điểm xã hội, nhận diện cảm xúc nơi làm việc/trường học, deepfake gây hại, che giấu giám sát của con người. → Kiểm: threat model có mục "hành vi bị cấm" ký xác nhận không có; test red-team cho prompt yêu cầu các hành vi này bị từ chối. · Nguồn: Luật AI 134/2025/QH15 Đ.7; EU AI Act Art. 5
- [ ] `CMP-AI-003` **MUST** Người dùng được thông báo rõ khi tương tác với AI (chatbot, voice) trước khi tương tác; không giả làm người. → Kiểm: test E2E thông điệp hiển thị ở lượt đầu; snapshot UI. · Nguồn: Luật AI 134/2025/QH15; Luật 71/2025/QH15 (thông báo tương tác AI); EU AI Act Art. 50(1)
- [ ] `CMP-AI-004` **MUST@L** Nội dung audio/ảnh/video do AI tạo gắn dấu hiệu nhận biết máy đọc được (watermark/metadata, vd C2PA) và nhãn hiển thị; deepfake/tái hiện sự kiện thật phải được gắn nhãn rõ. → Kiểm: test đầu ra có metadata/watermark; verifier đọc được; UI có nhãn. · Nguồn: Luật AI 134/2025/QH15; NĐ 142/2026/NĐ-CP Chương III; EU AI Act Art. 50(2), 50(4) (từ 02/08/2026; đánh dấu 50(2) cho hệ đã lưu hành trước 02/08/2026: tới 02/12/2026)
- [ ] `CMP-AI-005` **MUST@L** Nhật ký hệ thống AI: đầu vào, đầu ra, phiên bản model/prompt/retrieval, thời gian, người dùng (giả danh hoá), quyết định của người giám sát; lưu theo thời hạn tương xứng rủi ro (EU high-risk ≥ 6 tháng). → Kiểm: schema log; test mọi lời gọi model sinh bản ghi có `model_version`; retention cấu hình. · Nguồn: NĐ 142/2026/NĐ-CP (hồ sơ, giám sát); EU AI Act Art. 12, 19, 26(6)
- [ ] `CMP-AI-006` **MUST** Quyết định tự động ảnh hưởng đáng kể tới quyền/lợi ích (từ chối dịch vụ, chấm điểm, xếp loại, kỷ luật) có người xem lại trước khi có hiệu lực hoặc kênh khiếu nại có SLA; AI chỉ gợi ý trong y tế/pháp lý/tuyển dụng. → Kiểm: state machine quyết định có bước `human_review`; test không thể bỏ qua; xem [`consent-and-user-rights.md`](consent-and-user-rights.md). · Nguồn: Luật 91/2025/QH15 Đ.30; GDPR Art. 22; EU AI Act Art. 14, 26
- [ ] `CMP-AI-007` **MUST@L** Quy trình sự cố AI: phát hiện (metric chất lượng/an toàn), dừng/khôi phục, báo cáo cơ quan (VN: sơ bộ 72 giờ khẩn cấp/5 ngày làm việc qua Cổng một cửa, báo cáo cuối 15 ngày; EU high-risk: Art. 73), post-mortem. → Kiểm: `docs/ops/runbooks/ai-incident.md`; nút kill-switch có test; diễn tập hằng năm. · Nguồn: NĐ 142/2026/NĐ-CP Chương III; Luật AI 134/2025/QH15; EU AI Act Art. 73
- [ ] `CMP-AI-008` **MUST@L** Hệ thống rủi ro cao (VN danh mục Thủ tướng; EU Annex III từ 02/12/2027): hồ sơ kỹ thuật, quản lý rủi ro liên tục, quản trị dữ liệu (chất lượng, thiên lệch), đánh giá sự phù hợp **trước khi đưa vào sử dụng** và sau thay đổi đáng kể; kết quả công bố trên Cổng (VN). → Kiểm: `docs/ai/<tên>/conformity.md` + chứng nhận/tự đánh giá; biên bản đánh giá dữ liệu thiên lệch; xem [`../13-ai-engineering/evaluation.md`](../13-ai-engineering/evaluation.md). · Nguồn: NĐ 142/2026/NĐ-CP Chương II; EU AI Act Art. 9–11, 43
- [ ] `CMP-AI-009` **MUST@L** Dữ liệu cá nhân dùng để huấn luyện/vận hành AI: đúng mục đích, tối thiểu, có cơ sở pháp lý; thông báo chủ thể về xử lý tự động và cho phép từ chối; phân loại rủi ro theo Đ.30. → Kiểm: data map ghi `used_for_training`; cờ opt-out có tác dụng (test không đưa vào tập huấn luyện). · Nguồn: Luật 91/2025/QH15 Đ.30; GDPR Art. 5, 6, 22
- [ ] `CMP-AI-010` **MUST@L** Hệ thống AI đang vận hành trước 01/03/2026 (VN): thông báo trên Cổng thông tin một cửa trong 60 ngày từ 01/05/2026 và hoàn tất hồ sơ trong thời gian chuyển tiếp (12–18 tháng); giữ giám sát của người và log trong thời gian này. → Kiểm: biên nhận thông báo; kế hoạch tuân thủ có hạn. · Nguồn: NĐ 142/2026/NĐ-CP (chuyển tiếp)
- [ ] `CMP-AI-011` **MUST@L** Model nền tự huấn luyện/cung cấp (GPAI) cho thị trường EU: tài liệu kỹ thuật, thông tin cho bên tích hợp, chính sách tôn trọng bản quyền EU, tóm tắt công khai dữ liệu huấn luyện; rủi ro hệ thống → đánh giá, giảm thiểu, báo cáo. → Kiểm: model card + tóm tắt dữ liệu công khai; xem [`licensing-and-ip.md`](licensing-and-ip.md). · Nguồn: EU AI Act Art. 53, 55 (từ 02/08/2025)
- [ ] `CMP-AI-012` **MUST@L** Chương trình quản trị AI theo ISO/IEC 42001:2023 (chính sách, vai trò, đánh giá tác động, cải tiến) hoặc NIST AI RMF 1.0 (Govern/Map/Measure/Manage) với bằng chứng; đào tạo AI literacy cho nhân sự vận hành (EU Art. 4). → Kiểm: tài liệu AIMS + hồ sơ đào tạo; xem [`records-and-audit-readiness.md`](records-and-audit-readiness.md). · Nguồn: ISO/IEC 42001:2023; NIST AI RMF 1.0; EU AI Act Art. 4
- [ ] `CMP-AI-013` **SHOULD** Bộ đánh giá (eval) an toàn/độ chính xác/thiên lệch chạy trong CI với ngưỡng chặn phát hành; kết quả lưu làm bằng chứng cho hồ sơ phân loại. → Kiểm: job eval + ngưỡng; báo cáo gắn phiên bản; xem [`../13-ai-engineering/evaluation.md`](../13-ai-engineering/evaluation.md). · Nguồn: NĐ 142/2026/NĐ-CP (đánh giá sự phù hợp); EU AI Act Art. 15
- [ ] `CMP-AI-014` **SHOULD** Thông báo cho người dùng về hạn chế của AI (có thể sai, không phải tư vấn y tế/pháp lý/tài chính) ngay trong giao diện, không chỉ ở điều khoản. → Kiểm: snapshot UI; nội dung từ [`../06-design-ux/ai-ux.md`](../06-design-ux/ai-ux.md). · Nguồn: Luật AI 134/2025/QH15 (minh bạch); EU AI Act Art. 13
- [ ] `CMP-AI-015` **SHOULD** Sandbox/thử nghiệm có kiểm soát (VN 3 cấp theo NĐ 142; EU Art. 57 từ 02/08/2027) được cân nhắc cho ứng dụng mới trong lĩnh vực nhạy cảm; ADR ghi quyết định. → Kiểm: ADR tồn tại. · Nguồn: NĐ 142/2026/NĐ-CP Chương IV; EU AI Act Art. 57
- [ ] `CMP-AI-016` **SHOULD** Hợp đồng với nhà cung cấp model/API có điều khoản: dữ liệu không dùng huấn luyện (hoặc có), vị trí xử lý, log, thông báo thay đổi model, bản quyền đầu ra. → Kiểm: `docs/privacy/processors.md` mục AI vendors có điều khoản. · Nguồn: GDPR Art. 28; Luật 91/2025/QH15 Đ.17, Đ.20
- [ ] `CMP-AI-017` **MAY** Dùng C2PA Content Credentials cho nhãn nguồn gốc nội dung đa phương tiện. → Kiểm: manifest C2PA hợp lệ. · Nguồn: C2PA (chưa xác minh phiên bản ngày 2026-10-13)
- [ ] `CMP-AI-018` **MAY** Công bố "AI transparency report" định kỳ: số sự cố, khiếu nại, kết quả eval. → Kiểm: báo cáo công khai. · Nguồn: thực hành nội bộ

## Bẫy thường gặp

- **"Chỉ là chatbot nên không cần phân loại":** chatbot có thể là trung bình (VN) và chịu Art. 50; chatbot tư vấn y tế/tài chính có thể là cao.
- **Tưởng Omnibus hoãn cả Art. 50 tới 02/12/2026:** minh bạch Art. 50 áp dụng từ 02/08/2026; chỉ đánh dấu máy đọc được Art. 50(2) cho hệ thống AI tạo nội dung **đã đưa ra thị trường EU trước 02/08/2026** mới có hạn 02/12/2026. Sản phẩm mới ra sau 02/08/2026 phải đạt ngay.
- **Tin rằng EU high-risk áp dụng từ 08/2026:** đã lùi tới 02/12/2027 (Annex III) bởi Regulation (EU) 2026/1744 — nhưng cấm (02/02/2025) và GPAI (02/08/2025) đã có hiệu lực.
- **Watermark chỉ cho văn bản:** NĐ 142 yêu cầu máy đọc được cho audio/ảnh/video, không bắt buộc văn bản; EU Art. 50(2) bao gồm văn bản ở mức "máy đọc được" khi khả thi.
- **Log không có phiên bản model/prompt** → không tái hiện, không báo cáo sự cố được.
- **"Human in the loop" là nút Approve ai cũng bấm Yes:** giám sát phải có thẩm quyền, thông tin và thời gian.
- **Hệ thống cũ không thông báo lên Cổng một cửa** trong 60 ngày (VN).
- **Dùng dữ liệu người dùng để fine-tune** mà notice không nói → vi phạm mục đích.
- **Nhầm nghĩa vụ nhà cung cấp (provider) với bên triển khai (deployer):** tích hợp API bên thứ ba vẫn có nghĩa vụ deployer.

## Cổng tự động

| Việc kiểm | Công cụ (giấy phép) | Lệnh/cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Module AI có system card + phân loại | Script kiểm `docs/ai/*.md` theo nhãn module | `python scripts/ai/check-system-cards.py` | CI (PR) | thiếu = fail |
| Eval an toàn/thiên lệch | Promptfoo (MIT) / Inspect (MIT) / DeepEval (Apache-2.0) — xem `research/2026-10-13-stored-catalog-extraction.md` §3 | `promptfoo eval -c evals/safety.yaml` | CI | pass ngưỡng cấu hình |
| Red-team hành vi cấm | Bộ prompt cấm + guardrail test | `pytest tests/ai/test_prohibited.py` | CI | 100% từ chối |
| Log có `model_version` | Test đơn vị/wrapper client | pytest/vitest | CI | 100% lời gọi |
| Watermark/metadata đầu ra media | Verifier (vd C2PA tool) | test tích hợp | CI | hợp lệ |
| Kill-switch | Test tích hợp bật cờ tắt AI | E2E | CI | tính năng tắt ≤ 1 phút |

## Nguồn

- Luật Trí tuệ nhân tạo số 134/2025/QH15 (thông qua 10/12/2025, hiệu lực 01/03/2026; Công báo 40-01/2026): <https://apolatlegal.com/vi/laws/luat-tri-tue-nhan-tao-2025-so-134-2025-qh15/> và <https://hethongphapluat.com/luat-tri-tue-nhan-tao-2025.html> — xác minh 2026-10-13 (nguồn thứ cấp có đăng toàn văn; chưa đối chiếu vanban.chinhphu.vn). Kiểm tra văn bản sửa đổi trước khi áp dụng.
- Nghị định 142/2026/NĐ-CP (30/04/2026, hiệu lực 01/05/2026) quy định chi tiết Luật AI: <https://hethongphapluat.com/nghi-dinh-142-2026-nd-cp-huong-dan-luat-tri-tue-nhan-tao.html> — xác minh 2026-10-13 (số điều theo bản chép, chưa đối chiếu Công báo).
- Luật Công nghiệp công nghệ số 71/2025/QH15 (14/06/2025, hiệu lực 01/01/2026): <https://thuvienphapluat.vn/van-ban/Cong-nghe-thong-tin/Luat-Cong-nghiep-cong-nghe-so-2025-so-71-2025-QH15-621341.aspx> — xác minh 2026-10-13.
- Luật BVDLCN 91/2025/QH15 Đ.30: <https://vanban.chinhphu.vn/?pageid=27160&docid=214590> — xác minh 2026-10-13.
- EU AI Act — Regulation (EU) 2024/1689 (hiệu lực 01/08/2024; cấm + AI literacy 02/02/2025; GPAI 02/08/2025; phần còn lại, gồm minh bạch Art. 50, 02/08/2026; Annex III 02/12/2027; Annex I 02/08/2028 — hai mốc cuối theo Omnibus): <https://eur-lex.europa.eu/eli/reg/2024/1689/oj> — xác minh gián tiếp 2026-10-13 (EUR-Lex không trả nội dung qua công cụ).
- Digital Omnibus on AI — Regulation (EU) 2026/1744 (08/07/2026, OJ 24/07/2026, hiệu lực 27/07/2026): high-risk Annex III → 02/12/2027, Annex I → 02/08/2028; Art. 50 **không** bị hoãn (áp dụng 02/08/2026), riêng đánh dấu máy đọc được Art. 50(2) cho hệ thống AI tạo nội dung đã đưa ra thị trường EU trước 02/08/2026 → 02/12/2026 (xác minh qua nguồn thứ cấp nhất quán; đối chiếu EUR-Lex 2026/1744 trước khi áp dụng; **đính chính 2026-10-14**: bản trước ghi Art. 50 áp từ 02/12/2026): <https://www.hunton.com/privacy-and-cybersecurity-law-blog/eu-digital-omnibus-on-ai-enters-into-force> và <https://www.cuatrecasas.com/en/spain/intellectual-property/art/digital-omnibus-ai-has-been-published> — nguồn thứ cấp, xác minh 2026-10-13; văn bản gốc: <https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202601744> (không truy cập được qua công cụ).
- ISO/IEC 42001:2023: <https://www.iso.org/standard/42001> — xác minh 2026-10-13.
- NIST AI RMF 1.0 (26/01/2023) và AI 600-1 (26/07/2024): <https://www.nist.gov/itl/ai-risk-management-framework> — xác minh 2026-10-13.
- Nghiên cứu nền: `research/2026-10-13-ai-agent-research.md` (giao thức, guardrail); `research/2026-10-13-stored-catalog-extraction.md` §2.6, §3 (công cụ eval/guardrail nên dùng).
