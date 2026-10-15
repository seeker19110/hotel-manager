---
title: Mẫu DPIA
kind: template
updated: 2026-10-13
---

# Mẫu DPIA.md — Hồ sơ đánh giá tác động xử lý dữ liệu cá nhân

> **Ai viết:** Bên Kiểm soát / Bên Kiểm soát và xử lý (và Bên Xử lý cho phần hợp đồng) cùng người phụ trách bảo vệ dữ liệu; luật sư rà. **Giai đoạn:** G2–G4, trước khi xử lý dữ liệu thật; cập nhật định kỳ.
> **Cổng dùng:** `PM-RISK-007`, `PM-REQ-009`, G7 GO/NO-GO (BLOCKER nếu có dữ liệu cá nhân mà chưa có DPIA), `CMP-*` ở [`../16-compliance-privacy/README.md`](../16-compliance-privacy/README.md).
> **Khung pháp lý (xác minh 2026-10-13 — kiểm tra văn bản sửa đổi trước khi dùng):** Việt Nam: **Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15** (thông qua 26/6/2025, hiệu lực **01/01/2026**) + **Nghị định 356/2025/NĐ-CP** (ký 31/12/2025, hiệu lực 01/01/2026, **thay thế Nghị định 13/2023/NĐ-CP**) — hồ sơ đánh giá tác động ở Điều 19 (lập, thành phần, gửi trong 60 ngày kể từ khi xử lý tới cơ quan chuyên trách — A05 Bộ Công an; cơ chế tiền kiểm, trả kết quả 15 ngày) và Điều 20 (cập nhật: 6 tháng/lần khi có mục đích hoặc bên mới; 10 ngày khi tái cơ cấu/giải thể/đổi nhà cung cấp) — *số điều theo bản chép tại luatvietnam.vn, đối chiếu bản gốc tại vbpl.moj.gov.vn trước khi nộp*. Quốc tế: **GDPR (EU) 2016/679 Art. 35** (DPIA khi xử lý "có khả năng gây rủi ro cao"; nội dung tối thiểu Art. 35(7)) + hướng dẫn **WP248 rev.01** được EDPB thông qua — *(văn bản Art. 35 trên EUR-Lex không đọc được ngày 2026-10-13; nội dung theo WP248)*.
> **Cách điền:** mỗi mục có bằng chứng (link cấu hình, chính sách, hợp đồng); biểu mẫu nộp cơ quan nhà nước dùng mẫu ban hành kèm Nghị định (Mẫu 10 cho báo cáo đánh giá tác động theo NĐ 356/2025) — file này là bản làm việc nội bộ ánh xạ sang mẫu đó.

````markdown
# DPIA — <Tên hệ thống/hoạt động xử lý> · phiên bản <n> · <YYYY-MM-DD>

| Trường | Giá trị |
|---|---|
| Vai trò của tổ chức | Bên Kiểm soát / Bên Kiểm soát và xử lý / Bên Xử lý (theo hợp đồng với <...>) |
| Thông tin liên hệ tổ chức | <tên pháp nhân, địa chỉ, người đại diện, email, điện thoại> |
| Người phụ trách bảo vệ dữ liệu (DPO) | <tên, chức danh, liên hệ> — đủ điều kiện theo NĐ 356/2025: <có/không> |
| Căn cứ lập | Luật 91/2025/QH15; NĐ 356/2025/NĐ-CP Điều 19–20; GDPR Art. 35 (nếu có chủ thể EU) |
| Trạng thái nộp | chưa nộp / đã nộp ngày <...> (hạn: 60 ngày kể từ <ngày bắt đầu xử lý>) / kết quả: <đạt / cần bổ sung — hạn 30 ngày> |
| Lần cập nhật kế tiếp | <ngày> (6 tháng) — sự kiện kích hoạt cập nhật 10 ngày: <...> |

## 1. Mô tả hoạt động xử lý
| Mục đích xử lý | Loại dữ liệu (cơ bản / nhạy cảm) | Chủ thể dữ liệu (nhóm, ước lượng số lượng, có trẻ em?) | Nguồn thu thập | Căn cứ pháp lý (đồng ý / hợp đồng / nghĩa vụ pháp luật / ...) |
|---|---|---|---|---|
| <mục đích 1> | | | | |

## 2. Sơ đồ luồng dữ liệu theo vai trò (bắt buộc theo NĐ 356/2025)
```text
[Chủ thể] --thu thập (đồng ý tại <màn hình>)--> [Bên Kiểm soát: <hệ thống>]
    --> [Bên Xử lý: <nhà cung cấp, vai trò, hợp đồng #>] --> [Bên thứ ba nhận: <tên, mục đích>]
    --> [Chuyển ra nước ngoài: <quốc gia, nhà cung cấp, cơ chế>] (nếu có → hồ sơ đánh giá tác động chuyển dữ liệu riêng)
```

## 3. Bên nhận dữ liệu và chuyển xuyên biên giới
| Bên nhận | Vai trò | Dữ liệu | Mục đích | Quốc gia lưu trữ | Hợp đồng/DPA (link) |
|---|---|---|---|---|---|

## 4. Đồng ý và quyền chủ thể
- Cách lấy đồng ý: <màn hình, câu chữ, tách riêng từng mục đích, bằng chứng lưu ở đâu> — kiểm: <test E2E>
- Rút đồng ý / xoá / truy cập / chỉnh sửa / hạn chế / phản đối: <luồng, thời hạn xử lý theo luật, cách chứng minh>
- Trẻ em (nếu có): <xác minh tuổi, đồng ý người giám hộ>

## 5. Thời hạn xử lý, lưu trữ và xoá
| Dữ liệu | Thời hạn | Căn cứ | Cơ chế xoá/ẩn danh (lệnh/job) | Bằng chứng |
|---|---|---|---|---|

## 6. Biện pháp bảo vệ
| Biện pháp | Mô tả | Bằng chứng (cấu hình, test, scanner) |
|---|---|---|
| Mã hoá khi truyền / lưu | | |
| Kiểm soát truy cập, quyền tối thiểu | | |
| Log kiểm toán truy cập dữ liệu nhạy cảm | | |
| Backup, khôi phục, xoá đúng hạn | | |
| Quy trình sự cố & thông báo vi phạm (thời hạn theo luật) | | |

## 7. Đánh giá rủi ro và biện pháp giảm thiểu
| ID | Rủi ro cho chủ thể dữ liệu | Khả năng | Mức độ nghiêm trọng | Biện pháp | Rủi ro còn lại | Trạng thái |
|---|---|---|---|---|---|---|
| DP-01 | lộ dữ liệu nhạy cảm do truy cập trái phép | | | TM-<NN> trong THREAT-MODEL | | |
| DP-02 | dùng dữ liệu ngoài mục đích đã thông báo | | | | | |

## 8. Tự đánh giá tuân thủ
| Yêu cầu | Đạt / Chưa / N/A | Bằng chứng |
|---|---|---|
| Thông báo xử lý cho chủ thể trước khi xử lý | | |
| Đồng ý hợp lệ cho từng mục đích | | |
| Hợp đồng với Bên Xử lý có điều khoản bảo vệ dữ liệu | | |
| Hồ sơ nộp đúng hạn, cập nhật đúng nhịp | | |
| Chuyển dữ liệu ra nước ngoài có hồ sơ riêng | | |

## 9. Tài liệu đính kèm
- Chính sách bảo vệ dữ liệu, quy trình, biểu mẫu: <link>
- Hợp đồng/thoả thuận xử lý: <link>
- Mẫu nộp (Mẫu 10 kèm NĐ 356/2025) đã điền: <link>

## 10. Ký
| Vai trò | Tên | Ngày |
|---|---|---|
| Người lập (DPO) | | |
| Đại diện pháp nhân | | |
| Luật sư rà (nếu có) | | |

## Lịch sử cập nhật
| Phiên bản | Ngày | Lý do (định kỳ 6 tháng / sự kiện 10 ngày / thay đổi mục đích) | Đã nộp bản cập nhật? |
|---|---|---|---|
````
