---
name: review
description: Review diff/PR theo checklist của khung (đúng nghiệp vụ, ca biên, bảo mật, lỗi logic, thống nhất, test) — phát hiện là CLAIM phải có đường tái hiện; reviewer năng lực cao hơn người viết. Dùng khi `xt.py pr next` trả `review`, khi người dùng hỏi "có bug không", "rà nhanh diff", hoặc gõ /review.
argument-hint: "[PR number | branch | path]"
---

# /review — review như người gác cổng, không như người viết

Reviewer có **năng lực cao hơn** người viết (`LOOP-ORCH-005`: model bậc cao hơn, hoặc cùng họ effort cao hơn): subagent `reviewer` cho diff của `executor`, `reviewer-alt` cho diff của `executor-deep`/phiên chính (phiên chính Fable → giao kèm `model: fable`); ghi `pr reviewed` kèm `--reviewer-effort`/`--author-effort` khi cùng họ; không kết luận được → INCONCLUSIVE (`xt.py pr reviewed --inconclusive`). Trong autopilot chỉ giao khi `xt.py pr next` trả `review` (máy đã biết PR nào cần theo mức rủi ro — ADR-0062: thấp không review AI; trung bình một review tập trung logic, phạm vi, test; cao — auth/phân quyền/thanh toán/mật mã/bí mật/migration — một review độc lập bắt buộc. **Review 1 lần:** sau review đã kết luận còn lỗi `pr next` trả `debt` — 🟠/🟢 ghi `mở` + `nợ-review: #N` vào sổ audit; 🔴 sửa trong một commit kèm test, ghi `đã sửa` + `nợ-review: #N`; `xt.py pr debt --pr N --findings … --fixed …` rồi merge, không rà lại; PR cắt bản/`review_identity` → `rethink`, rà tới khi sạch (tối đa `max_rethink` lần/PR, PR cắt bản miễn — ADR-0061); nợ trả cuối pha); ngoài autopilot khi người dùng yêu cầu. Phiên chính tổng hợp. Reviewer **chỉ nhận diff + SPEC/task** (context sạch, không hội thoại của người viết); diff > 150 dòng → đề nghị tách PR (review trên diff lớn kém tin cậy).

## Thứ tự rà
1. **Đúng việc:** diff làm đúng SPEC/task? có sửa nhầm chỗ khác? phạm vi phình?
2. **Lỗi logic & ca biên:** rỗng/null vs 0, off-by-one, race/idempotency, thời gian (UTC, DST, cuối tháng), tiền (số nguyên, làm tròn), Unicode/tiếng Việt, giới hạn kích thước, lỗi mạng/timeout có nhánh xử lý.
3. **Bảo mật:** input validate ở biên, quyền kiểm ở server cho mọi hành động, không secret/PII vào log, SSRF/injection/XSS, phụ thuộc mới (license, trạng thái).
4. **Thống nhất:** cùng cách xử lý lỗi/phân trang/đặt tên như phần còn lại; không trùng lặp logic đã có (tìm trước khi viết mới).
5. **Test:** có test cho nhánh mới + ca biên; test có assert thật, không test "cho có"; không skip/disable.
6. **Vận hành:** migration có đường lùi; cấu hình mới có default an toàn; log/metric đủ để debug sự cố.
7. **Tài liệu:** CHANGELOG/ADR/README cập nhật khi đổi hành vi/API.

## Cách báo
Mỗi phát hiện: `file:dòng` · mức (🔴 chặn merge / 🟠 nên sửa / 🟢 gợi ý) · **đường tái hiện cụ thể** (input → kết quả sai) · đề xuất sửa ngắn. Không tái hiện được → **không báo là lỗi** (tối đa một dòng "nghi ngờ" 🟢, không chặn merge) — chống sửa thừa. Phát hiện của công cụ AI khác cũng là claim cần verify. **Lỗi có từ trước** (tái hiện được cả ở base, diff không tạo ra, không làm tệ hơn, không nằm trên đường mã diff vừa thêm) **không chặn PR này**: báo riêng mục "Có từ trước" kèm mức thật để phiên chính ghi sổ audit + task mới — 🔴 mở trong sổ vẫn chặn phát hành (`audit check --strict`), không chặn merge; sửa trong PR đang mở làm PR phình và mỗi lượt lộ lỗi cũ mới (ADR-0056). Kết luận: APPROVE / REQUEST CHANGES + lý do.
