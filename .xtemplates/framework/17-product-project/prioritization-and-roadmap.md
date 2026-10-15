---
title: Ưu tiên & lộ trình: MVP, lát dọc, RICE/MoSCoW, không phình phạm vi
kind: module
prefix: PM-PRIO
applies_to: [all]
updated: 2026-10-14
---

# Ưu tiên & lộ trình: MVP, lát dọc, RICE/MoSCoW, không phình phạm vi

> Quyết định *làm gì trước, làm gì sau, không làm gì* bằng phương pháp có công thức và có hồ sơ, thay vì theo
> người nói to nhất. Áp dụng từ **G0–G1** (cắt MVP), lặp lại ở mỗi mốc; cơ chế chống phình phạm vi
> (`SCOPE.md` + `.out-of-scope/`) chạy suốt vòng đời.

## Nguyên tắc

1. **MVP = tập nhỏ nhất đủ để người thật hoàn thành một JTBD**, không phải phiên bản "bớt tính năng" của sản phẩm trong mơ. Nếu bỏ một mục mà người dùng vẫn làm xong việc thì mục đó không thuộc MVP.
2. **Lát dọc (vertical slice) thay vì tầng ngang.** Mỗi đợt giao một luồng chạy xuyên UI → API → dữ liệu và demo được; không làm "xong toàn bộ CSDL" rồi mới tới giao diện. Lát đầu tiên là **walking skeleton**: luồng mỏng nhất đi qua mọi tầng, kèm CI và deploy (G5).
3. **Ưu tiên có công thức, công thức có đầu vào kiểm được.** RICE/MoSCoW chỉ tốt bằng số liệu đưa vào; Reach lấy từ analytics, Confidence thấp thì làm spike trước khi xếp hạng.
4. **"Không làm" được bảo vệ bằng cơ chế**, không bằng ký ức: `SCOPE.md` nêu điều kiện để một yêu cầu được xét; `.out-of-scope/<ý-tưởng>.md` ghi từng ý bị từ chối kèm lý do (catalog 20 §3c).
5. **Lộ trình là cam kết về kết quả, không phải danh sách tính năng kèm ngày.** Mỗi mốc gắn chỉ số ở [`metrics-and-analytics.md`](metrics-and-analytics.md); tính năng là giả thuyết để đạt chỉ số.
6. **Phạm vi, thời gian, chất lượng: chỉ phạm vi được co.** Hạn thật không đổi, cổng chất lượng không hạ → cắt Could/Should (quy tắc MoSCoW của DSDM).
7. **Ưu tiên lại là việc định kỳ**, có hồ sơ: bảng RICE/MoSCoW có ngày, người quyết, lý do đổi.
8. **Yêu cầu bắt buộc theo luật/bảo mật không tham gia xếp hạng** — chúng là Must mặc định; chỉ xếp hạng phần còn lại.

## Quyết định

| Phương pháp | Dùng khi | Cách tính / quy tắc | Không dùng khi |
|---|---|---|---|
| **MoSCoW** (mặc định cho MVP) | Cắt phạm vi cho một mốc có hạn cố định | Must = thiếu thì sản phẩm vô nghĩa; Should = quan trọng nhưng có cách tạm; Could = bỏ đầu tiên khi trễ; Won't (lúc này) = ghi để không quay lại ngầm. DSDM khuyến nghị **Must ≤ 60% nỗ lực**, Could ≈ 20% làm vùng đệm | Có >20 ứng viên ngang hàng cần xếp thứ tự — dùng RICE |
| **RICE** | Xếp hạng nhiều ứng viên khi đã có dữ liệu người dùng | Điểm = (Reach × Impact × Confidence) ÷ Effort; Impact thang 3/2/1/0,5/0,25; Confidence 100/80/50%; Effort tính người-tháng. Confidence < 50% → chưa xếp hạng, làm spike | Chưa có analytics (Reach là đoán) — dùng MoSCoW + phỏng vấn |
| **Rủi ro trước** | Có giả định nguy hiểm hoặc tích hợp chưa chắc chạy | Làm lát chứa rủi ro kỹ thuật/thị trường cao nhất trước, dù giá trị thấp hơn ([`risk-and-assumptions.md`](risk-and-assumptions.md)) | Rủi ro đã được spike loại bỏ |
| **Chi phí trì hoãn** (WSJF rút gọn) | Nhiều đội tranh cùng năng lực; có khoản phạt/thời hạn pháp lý | Ưu tiên việc có (giá trị + rủi ro pháp lý + thời hạn) ÷ kích thước lớn nhất | Dự án một người, một luồng |

**Mặc định:** MoSCoW cho MVP → walking skeleton → các lát dọc theo thứ tự rủi ro rồi giá trị → RICE khi backlog sau phát hành vượt vài chục mục.

**Một lát dọc hợp lệ khi:** (1) người dùng làm được một việc có nghĩa từ đầu đến cuối; (2) đi qua mọi tầng kỹ thuật sẽ dùng (UI/API/dữ liệu/hạ tầng); (3) có test và deploy được; (4) đo được bằng ≥1 sự kiện. Thiếu một điều kiện → đó là tầng ngang, chia lại.

## Checklist

- [ ] `PM-PRIO-001` **MUST** Danh sách tính năng MVP được phân loại MoSCoW, mỗi mục Must có tiêu chí chấp nhận (spec) và ID `F-NNN`. → Kiểm: bảng MoSCoW trong `PROJECT.md` có cột Mức · ID · Spec; mọi Must trỏ file spec tồn tại.
- [ ] `PM-PRIO-002` **MUST@L** Nỗ lực của mục Must không vượt 60% tổng nỗ lực mốc (ước lượng theo khoảng, lấy P50). → Kiểm: bảng có cột ước lượng; script/tay tính tổng Must ÷ tổng ≤ 0,6; vượt → cắt hoặc ghi lý do có người duyệt. · Nguồn: DSDM MoSCoW
- [ ] `PM-PRIO-003` **MUST** Lộ trình chia theo lát dọc demo được; lát đầu là walking skeleton có CI + deploy trước khi làm tính năng. → Kiểm: `PLAN.md` nhóm task theo lát; lát 1 có task `Gate:` là lệnh deploy/smoke; CI xanh trên commit skeleton (cổng G5).
- [ ] `PM-PRIO-004` **MUST** Phạm vi MVP đóng băng tại cổng G1; thay đổi sau đó đi qua `SCOPE.md` (điều kiện xét) và được ghi ngày, người quyết, mục bị đẩy ra để bù. → Kiểm: `SCOPE.md` tồn tại; mỗi thay đổi phạm vi là một commit sửa `PROJECT.md` có message `docs(scope): …` nêu mục bị đổi.
- [ ] `PM-PRIO-005` **MUST@L** Mỗi ý tưởng bị từ chối có file `.out-of-scope/<slug>.md` ghi lý do và ngày; yêu cầu trùng với file đó bị đóng bằng link, không bàn lại. → Kiểm: `ls .out-of-scope/` không rỗng khi dự án ≥ M; issue template có mục "Đã kiểm `.out-of-scope/`".
- [ ] `PM-PRIO-006` **MUST@L** Mỗi mốc lộ trình gắn ≥1 chỉ số kết quả có mục tiêu số, không chỉ danh sách tính năng. → Kiểm: bảng lộ trình có cột "Chỉ số & mục tiêu" không rỗng.
- [ ] `PM-PRIO-007` **MUST** Khi trễ hạn thật: cắt Could/Should trước, không hạ cổng chất lượng, không kéo hạn thật mà không có người quyết ghi tên. → Kiểm: `PROGRESS.md` mục Quyết định ghi "cắt X để giữ hạn Y" kèm ngày; CI không có cổng nào bị tắt (`rg -n "continue-on-error: true|--no-verify" .github/`).
- [ ] `PM-PRIO-008` **SHOULD** Khi dùng RICE: Reach lấy từ sự kiện analytics có nguồn, Confidence < 50% không xếp hạng mà tạo spike. → Kiểm: bảng RICE có cột "Nguồn Reach"; dòng Confidence < 50% có link spike. · Nguồn: Intercom RICE
- [ ] `PM-PRIO-009` **SHOULD** Thứ tự lát dọc ưu tiên rủi ro cao/giả định nguy hiểm trước giá trị cao; lý do ghi một dòng cho mỗi lát. → Kiểm: `PLAN.md` phần "Thứ tự & lý do".
- [ ] `PM-PRIO-010` **SHOULD** Backlog có "cut line" rõ: mục dưới vạch không được bắt đầu khi còn mục trên vạch dở (phối hợp WIP ở [`planning-and-estimation.md`](planning-and-estimation.md)). → Kiểm: board/`PLAN.md` có dòng `--- cut line ---` hoặc nhãn tương đương.
- [ ] `PM-PRIO-011` **SHOULD** Ưu tiên lại định kỳ (mỗi mốc hoặc mỗi 2–4 tuần) với bảng có ngày và lý do thay đổi thứ hạng. → Kiểm: lịch sử git của bảng ưu tiên ≥1 lần/mốc.
- [ ] `PM-PRIO-012` **SHOULD** Tính năng "nhỏ thôi" vẫn qua spec và tiêu chí chấp nhận; không có đường tắt bỏ cổng vì kích thước. → Kiểm: PR `feat:` không có spec bị CI chặn (xem `PM-SPEC-006`).
- [ ] `PM-PRIO-013` **SHOULD** Yêu cầu pháp lý/bảo mật bắt buộc (luật ngành, MUST của blueprint) luôn là Must bất kể giá trị người dùng. → Kiểm: `xt.py blueprint-status --strict` không mở MUST tại cổng G7.
- [ ] `PM-PRIO-014` **MAY** Dùng Kano (cơ bản / tuyến tính / gây thích thú) để nhận ra mục "cơ bản" người dùng không nêu nhưng thiếu là bỏ sản phẩm. → Kiểm: cột Kano trong bảng ưu tiên.
- [ ] `PM-PRIO-015` **MAY** Lộ trình công khai (cho người dùng) chỉ nêu mục tiêu theo quý và trạng thái "đang xét / đang làm / đã ra", không hứa ngày cho từng tính năng. → Kiểm: file `ROADMAP.md` không có cột ngày cụ thể cho mục chưa bắt đầu.
- [ ] `PM-PRIO-016` **MAY** Ghi "chi phí cơ hội" khi nhận yêu cầu ngoài kế hoạch: nêu mục nào bị đẩy ra. → Kiểm: comment/issue ghi "nhận X → đẩy Y".

## Bẫy thường gặp

| Bẫy | Dấu hiệu | Cách tránh |
|---|---|---|
| MVP là "mọi thứ nhưng nhỏ" | 80% mục là Must | Áp trần Must ≤ 60% nỗ lực; hỏi "bỏ mục này người dùng còn làm xong việc không" |
| Tầng ngang | Tuần 1–3 chỉ có schema và API, không demo được gì | Lát dọc + walking skeleton; mỗi PR là một luồng chạy được |
| Phình phạm vi qua miệng | Tính năng Won't xuất hiện lại trong PR | `SCOPE.md` + `.out-of-scope/`; PR không có spec bị chặn |
| RICE với số bịa | Reach "khoảng 1000" không nguồn | Reach bắt buộc có cột nguồn; không có analytics → MoSCoW |
| Chữa trễ bằng hạ chất lượng | Tắt test, `--no-verify`, `continue-on-error` | `PM-PRIO-007`: chỉ cắt phạm vi; grep CI chặn cờ tắt cổng |
| Lộ trình = lịch tính năng | Mỗi dòng là "tính năng X — ngày Y" | Mốc theo kết quả đo được; tính năng là giả thuyết |
| Việc "nhỏ thôi" đi tắt | Hotfix thành tính năng không spec | Mọi `feat:` có spec; "nhỏ" chỉ giảm độ dài spec, không bỏ |
| Tính năng tuân thủ bị xếp sau | DPIA, log kiểm toán "làm sau khi ra mắt" | MUST blueprint/luật = Must; cổng G7 chặn bằng `blueprint-status --strict` |
| Ưu tiên theo người nói to nhất | Thứ tự backlog đổi sau mỗi cuộc họp, không có lý do ghi lại | Bảng ưu tiên có cột lý do + ngày + người quyết; đổi thứ hạng là một commit |
| Walking skeleton "để sau" | Deploy lần đầu ở tuần cuối, lộ lỗi hạ tầng muộn | Lát 1 luôn có task deploy + smoke với Gate (`PM-PRIO-003`) |

## Cổng tự động

| Việc | Công cụ / lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Tỷ lệ nỗ lực Must | Script đọc bảng MoSCoW (cột ước lượng) trong `PROJECT.md`; ví dụ `python3 scripts/check-moscow.py` tự viết | CI (job docs) | Must ≤ 60% |
| Phạm vi bị đổi có hồ sơ | `git log --format=%s -- PROJECT.md \| rg "^docs\(scope\)"` khi diff mục MVP | CI | Diff mục MVP mà không có commit `docs(scope)` → đỏ |
| Ý tưởng từ chối có file | `ls .out-of-scope/*.md`; issue template checkbox | Issue template + CI | ≥1 file khi dự án ≥ M |
| Cổng chất lượng không bị tắt | `rg -n "continue-on-error: true\|--no-verify\|ignoreBuildErrors" .github/ package.json` | CI | 0 kết quả ngoài allowlist có lý do |
| MUST blueprint mở | `xt.py blueprint-status BLUEPRINT.md --strict` | CI trước release | exit 0 |
| Walking skeleton có deploy | `rg -n "T-00[1-3].*Gate: \`.*(deploy|smoke)" PLAN.md` | CI (job docs) | ≥1 task trong lát 1 |

## Nguồn

- MoSCoW — Agile Business Consortium (DSDM): Must ≤ 60% nỗ lực, Could ≈ 20% đệm: <https://www.agilebusiness.org/dsdm-project-framework/moscow-prioritisation.html> — xác minh 2026-10-13.
- RICE — Intercom, "RICE: Simple prioritization for product managers": <https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/> — xác minh 2026-10-13.
- Vertical slice / walking skeleton: cổng G5–G6 trong [`../00-method/lifecycle.md`](../00-method/lifecycle.md); khung cũ X-stored `01-process-and-standards.md` GĐ1 "đóng băng phạm vi MVP" (commit `1b80fe4`).
- `SCOPE.md` + `.out-of-scope/` — `seeker19110/stored` mục 20 §3c (mattpocock/skills), đọc 2026-10-13; `research/2026-10-13-stored-catalog-extraction.md`.
- Kano model, WSJF: khái niệm phổ biến trong quản lý sản phẩm — (chưa xác minh nguồn gốc chính thống ngày 2026-10-13); dùng như gợi ý MAY, không phải chuẩn.
