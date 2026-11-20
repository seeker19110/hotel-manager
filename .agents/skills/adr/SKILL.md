---
name: adr
description: Tạo bản ghi quyết định kiến trúc (ADR) mới từ mẫu của khung, đánh số tăng dần, không sửa ADR cũ (đổi ý → ADR mới + đổi dòng trạng thái của ADR cũ). Dùng khi chốt quyết định kiến trúc/công nghệ lớn hoặc gõ /adr.
argument-hint: "<tiêu đề quyết định>"
---

# /adr — một quyết định, một bản ghi

`<FW>` = `.xtemplates/framework` trong dự án đích, hoặc `framework` trong repo khung.

1. Mẫu: `<FW>/templates/ADR.md`. Thư mục dự án: `docs/adr/NNNN-<slug>.md` (4 chữ số, tăng dần; `ls docs/adr` để lấy số kế).
2. Viết đủ: **Bối cảnh** (vấn đề + ràng buộc + bằng chứng đã nghiên cứu, có ngày) · **Phương án đã xét** (≥ 2, ưu/nhược, chi phí) · **Quyết định** (một câu) · **Hệ quả** (tốt/xấu/nợ) · **Status** (Proposed/Accepted/Superseded by NNNN/Deprecated) · **Implementation status** (chưa/đang/đã — do code chứng minh, kèm PR).
3. Quyết định dính phiên bản/chuẩn/luật → `/research` trước, ghi nguồn + ngày.
4. **Không sửa nội dung ADR đã Accepted.** Đổi ý → ADR mới, ADR cũ chỉ đổi `Status: Superseded by NNNN`.
5. Liên kết ADR từ PR/PLAN/PROGRESS ("Quyết định quan trọng"). Commit `docs(adr): NNNN <tiêu đề>` (hook chạy cổng commit).
