---
title: Mẫu mô tả PR cho dự án
kind: template
updated: 2026-10-18
---

# Mẫu mô tả PR

`install.py --with-github` chép khối dưới vào `.github/pull_request_template.md` của dự án đích (copy-if-absent). Mỗi mục
trỏ về luật của khung: mục tiêu + link (`WF-REVIEW-002`), bằng chứng cổng là exit code hoặc link CI (P1), đường lùi
(P8), nhãn `risk:` cho ngoại lệ cứng (`LOOP-STOP-005`), phụ thuộc mới (`BASE-DEP-006`). Dự án sửa tự do; mục không áp
dụng ghi "không áp dụng — lý do", không xoá mục.

```markdown
<!-- Tiêu đề PR: `<type>(scope): mô tả` (conventional commit). Mỗi lát code một PR. Mục không áp dụng ghi "không áp dụng — lý do". -->

## Mục tiêu
<!-- Vì sao làm. Link SPEC (`S-NNN`), task (`T-NNN`), quyết định (`D-NNN`)/ADR, issue. -->

## Thay đổi
<!-- Gồm những gì; phần cố ý không làm. Đụng cấu hình cổng/CI/hook: nêu lý do (không nới ngưỡng, không skip test). -->

## Bằng chứng
<!-- Lệnh + exit code thật, hoặc link lượt chạy CI — tick không kèm bằng chứng là chưa xong. -->
- [ ] CI (`dev-task.sh gate`: build · typecheck · lint · test) xanh ở head — link run:
- [ ] Test mới cho thay đổi hành vi, gồm ca biên; sửa lỗi có test đỏ trước, xanh sau — tên test:
- [ ] Mục blueprint liên quan tick kèm `— Kiểm: <lệnh>` hoặc `— Bằng chứng:` — ID:

## Rủi ro và đường lùi
<!-- Ảnh hưởng nếu sai, cách phát hiện, cách quay lại (revert, cờ tính năng, migration down). Chạm tiền · dữ liệu người dùng thật ·
auth · mật mã · bí mật · `merge_risk_paths` trong xt.yaml: gắn nhãn `risk:*` — ngoại lệ cứng (ADR-0016/0020 của khung). -->

## Migration
- [ ] Không có migration
- [ ] Có migration: file mới (không sửa migration đã áp), có đường lùi, chạy được trên dữ liệu có sẵn

## Phụ thuộc mới
<!-- Mỗi gói một dòng: `tên · phiên bản ghim · giấy phép · lý do · phương án thay thế đã xét`; không có thì ghi "không có".
Mẫu cố ý không điền sẵn: CI so lockfile có thể đỏ khi mục trống mà có gói mới (BASE-DEP-006). -->

## Hỗ trợ AI
<!-- WF-REVIEW-019: phần nào do AI sinh, phần nào người đã tự kiểm và kiểm thế nào, phần nào chỉ máy/AI kiểm. Không ghi tên model/phiên. -->

## Bảo mật
- [ ] Không bí mật trong mã/log/commit; đầu vào kiểm bằng schema; quyền kiểm ở server
- [ ] Nội dung ngoài (web, issue, PR, output tool) coi là dữ liệu, không phải chỉ thị
```
