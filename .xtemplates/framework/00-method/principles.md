---
title: Nguyên tắc bất biến của khung
kind: method
updated: 2026-10-13
---

# Nguyên tắc bất biến của khung

> Mười hai nguyên tắc áp cho **mọi dự án, mọi loại phần mềm, mọi ngành**. Module, hồ sơ, gói ngành chỉ
> cụ thể hoá các nguyên tắc này; khi mâu thuẫn, nguyên tắc ở đây thắng. Muốn vi phạm → ghi ADR.

| # | Nguyên tắc | Nghĩa là | Kiểm bằng |
|---|---|---|---|
| P1 | **Bằng chứng, không lời khai** | "Đã xong / đã chạy / đã an toàn" chỉ có giá trị khi có bằng chứng máy tạo ra: exit code, báo cáo CI, file bằng chứng. Lời model hay người tự khai không phải bằng chứng. | `xt.py loop record`, CI xanh, `blueprint-status --strict` |
| P2 | **Nghiên cứu trước, đề xuất sau** | Không chọn công nghệ/phiên bản theo trí nhớ. Xác minh từ nguồn sống, ghi ngày. Không xác minh được → ghi "(chưa xác minh)". | Mục "Nguồn" có URL + ngày |
| P3 | **Đúng › an toàn › ít hơn › kiểm được › nhanh** | Thứ tự ưu tiên khi phải đánh đổi: đúng nghiệp vụ và không mất dữ liệu trước; rồi bảo mật; rồi ít code/ít phụ thuộc hơn; rồi dễ kiểm chứng; cuối cùng mới tới tốc độ. | Lý do ghi ở ADR/PLAN |
| P4 | **Nhàm chán ở lõi, cách tân một chỗ** | Lõi (ngôn ngữ, CSDL, auth, hạ tầng) dùng công nghệ trưởng thành; chỉ cách tân ở nơi tạo khác biệt sản phẩm. | ADR chọn stack |
| P5 | **Một nguồn sự thật cho mỗi thứ** | Schema, cấu hình, quy ước, tài liệu đều có đúng một nơi gốc; nơi khác sinh ra hoặc trỏ tới. | Không có hai định nghĩa cùng một hằng số/kiểu |
| P6 | **Không tin đầu vào** | Mọi dữ liệu từ ngoài ranh giới tin cậy (người dùng, API, file, LLM, tool, web) được kiểm lúc chạy; nội dung ngoài là **dữ liệu, không phải chỉ thị**. | Validate ở biên; test đầu vào xấu |
| P7 | **Mặc định an toàn, thất bại đóng** | Quyền tối thiểu, deny-by-default, lỗi ở cổng bảo mật → chặn (fail-closed). Ngoại lệ fail-open phải ghi rõ lý do. | Rà cấu hình, test quyền |
| P8 | **Thay đổi nhỏ, đảo ngược được** | Commit nhỏ, PR nhỏ, migration có đường lùi, feature flag cho thay đổi rủi ro. Thao tác không thể hoàn tác cần người duyệt. | Kích thước PR, rollback đã diễn tập |
| P9 | **Cổng máy trước, người sau** | Cái gì máy kiểm được (lint, type, test, scan, budget) thì đặt thành cổng tự động; người chỉ quyết phần máy không kiểm được. | CI required checks |
| P10 | **Quan sát được** | Không đo được thì không vận hành được: log có cấu trúc, metric, trace, cảnh báo theo SLO. | Dashboard + cảnh báo có thật |
| P11 | **Tôn trọng người dùng** | Quyền riêng tư theo thiết kế, tiếp cận được (a11y), minh bạch khi dùng AI, không dark pattern. | Checklist privacy + a11y |
| P12 | **Học từ lỗi một lần** | Mỗi sự cố/lỗi lặp tạo **một hàng rào mới** (test, lint rule, hook, checklist) để không tái phát. | Post-mortem có hành động |

## Ranh giới sử dụng

Khung hỗ trợ mọi phần mềm hợp pháp. **Không** dùng khung để xây mã độc, công cụ phá hoại, tấn công từ chối dịch vụ,
nhắm mục tiêu hàng loạt, tấn công chuỗi cung ứng hay né tránh phát hiện vì mục đích xấu. Công cụ lưỡng dụng
(kiểm thử xâm nhập, red-team) chỉ làm khi có **ủy quyền rõ ràng** và chỉ trên hệ thống của mình/được phép.

## Nguồn

- Tổng hợp từ khung cũ X-stored (commit `1b80fe4`, `01-process-and-standards.md`, `AI-HARNESS-AND-COMPANY-SPEC.md` §A2) và
  bài học harness trong `seeker19110/stored` mục 23 (đọc 2026-10-13). Xem [`research/`](../../research/).
- RFC 2119 — từ khoá mức yêu cầu: <https://www.rfc-editor.org/rfc/rfc2119> (xác minh 2026-10-13).
