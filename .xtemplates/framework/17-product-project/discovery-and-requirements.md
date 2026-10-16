---
title: Khám phá & yêu cầu: vấn đề, người dùng, chỉ số thành công, phạm vi không làm
kind: module
prefix: PM-REQ
applies_to: [all]
updated: 2026-10-15
---

# Khám phá & yêu cầu: vấn đề, người dùng, chỉ số thành công, phạm vi không làm

> Đầu ra của giai đoạn **G0 (Frame)**: trước khi chọn công nghệ hay viết code, dự án phải nói được *ai* đau *ở đâu*,
> *đo thành công thế nào* và *cố ý không làm gì*. Module này định nghĩa `PROJECT.md` tối thiểu
> (mẫu: [`../templates/PROJECT.md`](../templates/PROJECT.md)) và cổng G0 theo [`../00-method/lifecycle.md`](../00-method/lifecycle.md).

## Nguyên tắc

1. **Vấn đề trước giải pháp.** Phát biểu vấn đề không chứa tên công nghệ hay tính năng; nếu bỏ giải pháp đi mà câu vẫn đúng thì mới là vấn đề.
2. **Người dùng là người cụ thể, không phải "mọi người".** Dùng Jobs-to-be-Done: *"Khi <tình huống>, tôi muốn <động cơ>, để <kết quả>"* — một câu JTBD cho mỗi nhóm người dùng chính.
3. **Thành công đo được bằng số có baseline.** Chỉ số kết quả (outcome: tỷ lệ hoàn thành việc, thời gian làm xong, doanh thu, tỷ lệ quay lại) trước chỉ số đầu ra (output: số tính năng, số dòng code).
4. **"Không làm" quan trọng ngang "làm".** Phạm vi loại trừ ghi thành văn bản để không bị đưa lại bằng miệng; cơ chế chặn phình phạm vi ở [`prioritization-and-roadmap.md`](prioritization-and-roadmap.md).
5. **Giả định là nợ.** Mọi điều "chắc là đúng" ghi vào sổ giả định với cách kiểm chứng và hạn; giả định nguy hiểm nhất kiểm trước ([`risk-and-assumptions.md`](risk-and-assumptions.md)).
6. **Bằng chứng, không lời khai** (P1): "khách hàng rất cần" chỉ có giá trị khi dẫn được phỏng vấn, ticket, log, số liệu có nguồn.
7. **Yêu cầu có ID ổn định** (`R-001`…) để truy vết tới spec, task, PR, bằng chứng ([`specification.md`](specification.md)).

## Quyết định

| Tình huống | Cách khám phá khuyến nghị | Không dùng khi |
|---|---|---|
| Greenfield, tiếp cận được người dùng | Phỏng vấn ≥5 người đúng nhóm mục tiêu, hỏi về vấn đề và cách họ đang xoay sở, không bán ý tưởng; ghi JTBD | Chưa xác định được nhóm mục tiêu — quay lại nguyên tắc 2 |
| Greenfield, không tiếp cận được người dùng | Dữ liệu gián tiếp (diễn đàn, ticket công khai, đối thủ) + ghi rõ là **giả định**, đặt spike kiểm chứng trong 1–2 tuần đầu | Dữ liệu nhạy cảm, ngành bị quản lý — bắt buộc có người dùng/chuyên gia ngành thật |
| Brownfield (dự án có sẵn) | Đọc repo, issue, log, analytics hiện có để viết `PROJECT.md` "ngược"; phỏng vấn người vận hành | Không có quyền truy cập dữ liệu vận hành — ghi là "chưa biết", không suy đoán |
| Công cụ nội bộ / tự động hoá quy trình | Quan sát quy trình hiện tại từ đầu đến cuối, đo thời gian và lỗi thủ công làm baseline | Quy trình chưa ổn định — chuẩn hoá quy trình trước khi tự động hoá |
| Thư viện / SDK / API cho lập trình viên | Viết ví dụ sử dụng (README-first) và cho 2–3 người ngoài thử; đo thời gian đến lần gọi thành công đầu tiên | — |

**Mặc định:** chọn 1 chỉ số North Star + 2–4 chỉ số đầu vào (cách định nghĩa và đo ở
[`metrics-and-analytics.md`](metrics-and-analytics.md)); mục tiêu có số, baseline, hạn.

## Checklist

- [ ] `PM-REQ-001` **MUST** `PROJECT.md` có phát biểu vấn đề 1–2 câu nêu rõ ai, trong tình huống nào, đau ở đâu — không chứa tên công nghệ hay tính năng. → Kiểm: `rg -n "^## .*Vấn đề" PROJECT.md` có kết quả; review G0 xác nhận câu không chứa giải pháp.
- [ ] `PM-REQ-002` **MUST@L** Mỗi nhóm người dùng chính có ≥1 câu JTBD dạng "Khi …, tôi muốn …, để …". → Kiểm: `rg -c "Khi .*tôi muốn .*để " PROJECT.md` ≥ số nhóm người dùng.
- [ ] `PM-REQ-003` **MUST@L** Bằng chứng nhu cầu có nguồn: ghi chú phỏng vấn, ticket, log hoặc số liệu kèm link/ngày. → Kiểm: mục "Bằng chứng nhu cầu" trong `PROJECT.md` có ≥1 liên kết tới file/URL có thật; không chấp nhận "nhiều người nói".
- [ ] `PM-REQ-004` **MUST@L** Có ≥1 chỉ số thành công đo được, mỗi chỉ số có baseline (hoặc "chưa đo" + ngày sẽ đo), mục tiêu và hạn. → Kiểm: bảng "Chỉ số thành công" đủ 4 cột; mỗi chỉ số ánh xạ tới một sự kiện trong sơ đồ sự kiện (xem `PM-METRIC`).
- [ ] `PM-REQ-005` **MUST@L** Mục "Không làm" (Won't have lúc này) không rỗng và nêu lý do cho từng mục. → Kiểm: `rg -A3 "^## .*Không làm" PROJECT.md` có ≥1 dòng gạch đầu; `SCOPE.md` tồn tại khi dự án ≥ M.
- [ ] `PM-REQ-006` **MUST@L** Mọi giả định quan trọng ghi vào bảng giả định với cách kiểm chứng và hạn. → Kiểm: bảng "Giả định" trong `PROJECT.md` (hoặc `docs/RISKS.md`) đủ cột giả định · cách kiểm · hạn · trạng thái.
- [ ] `PM-REQ-007` **MUST** Mỗi yêu cầu có ID ổn định `R-NNN`, không tái sử dụng ID đã bỏ. → Kiểm: `rg -o "R-[0-9]{3}" PROJECT.md | sort | uniq -d` rỗng (không trùng ID).
- [ ] `PM-REQ-008` **MAY** Ngừng dùng 2026-10-15 — thay bằng `PM-REQ-019` (ADR-0008: câu hỏi chặn được phiên chính tự duyệt và ghi lại, không chỉ người).
- [ ] `PM-REQ-009` **MUST@M** Phân loại dữ liệu dự án sẽ xử lý ngay ở G0: có dữ liệu cá nhân không, có dữ liệu nhạy cảm (sức khoẻ, tài chính, trẻ em, định danh) không. → Kiểm: mục "Dữ liệu & pháp lý" ghi rõ có/không + loại; nếu có → gói ngành/module [`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md) được ghép vào blueprint.
- [ ] `PM-REQ-010` **SHOULD** Yêu cầu phi chức năng ghi bằng số theo hồ sơ (web: Core Web Vitals; backend: p95; CLI: thời gian chạy/kích thước; mobile: cold start) kèm nguồn ngưỡng. → Kiểm: bảng NFR có cột "ngưỡng" và "nguồn"; ngưỡng không tự nghĩ ra.
- [ ] `PM-REQ-011` **SHOULD** Ràng buộc cứng ghi rõ: hạn thật, ngân sách, nền tảng bắt buộc, tích hợp bắt buộc, luật ngành. → Kiểm: mục "Ràng buộc" phân biệt "hạn thật" và "hạn mong muốn" (xem `PM-PLAN`).
- [ ] `PM-REQ-012` **SHOULD** Có bảng giải pháp thay thế/đối thủ với dẫn chứng (URL, ngày xem) và điểm khác biệt của sản phẩm. → Kiểm: bảng ≥2 dòng, mỗi dòng có URL và ngày.
- [ ] `PM-REQ-013` **SHOULD** Cổng G0 có người duyệt (hoặc `D-NNN` của phiên chính, ADR-0008) ghi tên và ngày trong `PROJECT.md` hoặc `PROGRESS.md`; dự án một người vẫn tự ký để đóng băng phạm vi. → Kiểm: dòng "Cổng G0: duyệt bởi … ngày …" tồn tại.
- [ ] `PM-REQ-014` **SHOULD** Dự án có sẵn: `PROJECT.md` viết "ngược" từ repo (route/command/schema thật) và ghi rõ phần nào là đọc được, phần nào là suy đoán. → Kiểm: mỗi mục có nhãn *(đo được)* / *(suy luận)* / *(chưa biết)* theo [`../00-method/evidence-and-sources.md`](../00-method/evidence-and-sources.md) §1.8.
- [ ] `PM-REQ-015` **SHOULD** Luồng người dùng chính (2–5 luồng sống còn) mô tả từng bước từ điểm vào đến kết quả; đây là danh sách luồng bắt buộc có E2E sau này. → Kiểm: mục "Luồng chính" có ≥2 luồng, mỗi luồng tham chiếu `R-NNN`.
- [ ] `PM-REQ-016` **MAY** Có glossary thuật ngữ nghiệp vụ (một nghĩa cho mỗi từ) dùng chung cho spec, code và UI. → Kiểm: `docs/GLOSSARY.md` tồn tại và được spec tham chiếu.
- [ ] `PM-REQ-017` **MAY** Persona ngắn (tên, bối cảnh, thiết bị, mức kỹ năng) cho mỗi nhóm người dùng, dùng khi thiết kế UI/UX. → Kiểm: mục "Persona" hoặc file `docs/personas.md`.
- [ ] `PM-REQ-018` **MAY** Ghi lại "cách người dùng đang xoay sở" (workaround hiện tại) làm baseline so sánh sau phát hành. → Kiểm: mục "Hiện trạng" mô tả quy trình hiện có + thời gian/lỗi đo được.
- [ ] `PM-REQ-019` **MUST** Không còn câu hỏi `[chặn]` chưa trả lời khi qua cổng G0; mỗi câu có câu trả lời của người hoặc quyết định `D-NNN` của phiên chính theo tiêu chí chất lượng cuối — thiếu dữ kiện chỉ người có thì chọn giả định đảo ngược được ([`LOOP-STOP-018`](../11-autonomous-loop/stop-points-and-escalation.md)); không đoán ngầm. → Kiểm: `rg -c "\[chặn\]" PROJECT.md` = 0 tại commit đánh dấu cổng G0; mỗi câu đã đóng trỏ `D-NNN` hoặc tên người + ngày. · Nguồn: ADR-0008

## Bẫy thường gặp

| Bẫy | Dấu hiệu | Cách tránh |
|---|---|---|
| Giải pháp đội lốt vấn đề | "Vấn đề: chưa có app mobile" | Hỏi "vì sao" tới khi ra nỗi đau của người dùng; viết lại không có tên giải pháp |
| Người dùng "mọi người" | Không nêu được tên một người thật sẽ dùng | Cổng G0 của khung cũ: nêu được một người cụ thể và lý do họ dùng |
| Chỉ số đầu ra thay vì kết quả | "Thành công = ra mắt 10 tính năng" | Chỉ số kết quả gắn với JTBD; tính năng chỉ là phương tiện |
| Chỉ số không có baseline | Mục tiêu "tăng 20%" nhưng không biết hiện tại bao nhiêu | Đo baseline trước, hoặc ghi "chưa đo" + ngày đo; không ghi số đoán |
| Bán ý tưởng khi phỏng vấn | Người được hỏi gật đầu mọi thứ | Hỏi về quá khứ và cách đang làm, không hỏi "bạn có dùng không" |
| Phạm vi không làm chỉ nói miệng | Tính năng Won't quay lại sau 2 tuần | Ghi `SCOPE.md` + `.out-of-scope/`, mỗi ý bị từ chối một file có lý do (catalog 20 §3c) |
| Brownfield hỏi người điều có trong code | AI hỏi "stack là gì" dù `package.json` ở ngay đó | Đọc repo trước, chỉ hỏi điều không tra được (luật 1 và 10 trong `evidence-and-sources.md`) |
| Bỏ qua dữ liệu cá nhân ở G0 | Phát hiện cần DPIA ở G7 | Mục `PM-REQ-009`: phân loại dữ liệu ngay khi khung vấn đề |
| Yêu cầu trôi trong chat | Quyết định nằm trong tin nhắn, phiên sau không thấy | Mọi đầu ra G0 là file trong repo (`PROJECT.md`), chat chỉ là nháp (`lifecycle.md` quy tắc 2) |

## Cổng tự động

| Việc | Công cụ / lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| `PROJECT.md` đủ mục bắt buộc | `rg -c "^## " PROJECT.md` đối chiếu danh sách mục của mẫu; hoặc script `scripts/check-project-md.sh` tự viết | CI (job docs) | Thiếu mục → đỏ |
| Không còn chỗ điền | `rg -n "<ĐIỀN|\[chặn\]|TODO" PROJECT.md` | pre-commit + CI | 0 kết quả tại cổng G0 |
| ID yêu cầu không trùng | `rg -o "R-[0-9]{3}" PROJECT.md \| sort \| uniq -d` | CI | Rỗng |
| Liên kết bằng chứng còn sống | `lychee PROJECT.md docs/` (MIT/Apache-2.0) | CI hằng tuần | 0 link hỏng |
| Markdown hợp lệ | `markdownlint-cli2 "**/*.md"` (MIT) | pre-commit | 0 lỗi |

## Nguồn

- Khung cũ X-stored `01-process-and-standards.md` GĐ0–GĐ1 và `02-ai-rules-and-project-template.md` mẫu PROJECT.md (commit `1b80fe4`), đọc 2026-10-13.
- [`../00-method/lifecycle.md`](../00-method/lifecycle.md) — cổng G0; [`../00-method/evidence-and-sources.md`](../00-method/evidence-and-sources.md) — phân loại bằng chứng.
- INVEST / SMART — Bill Wake, "INVEST in Good Stories, and SMART Tasks" (2003-08-17): <https://xp123.com/articles/invest-in-good-stories-and-smart-tasks/> — xác minh 2026-10-13.
- MoSCoW (Must/Should/Could/Won't this time) — Agile Business Consortium, DSDM Project Framework: <https://www.agilebusiness.org/dsdm-project-framework/moscow-prioritisation.html> — xác minh 2026-10-13.
- Kanban Guide 2025.5 (chỉ số dòng chảy, SLE): <https://kanbanguides.org/english/> — xác minh 2026-10-13.
- `seeker19110/stored` mục 20 §3c (`SCOPE.md`, `.out-of-scope/`), mục 23 §2.4; `research/2026-10-13-stored-catalog-extraction.md` — đọc 2026-10-13.
