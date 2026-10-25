---
title: Thoả thuận xử lý dữ liệu (DPA) — bản mẫu
kind: legal-template
version: 0.1.0
updated: 2026-10-25
status: "bản mẫu kỹ thuật — CHƯA được pháp lý duyệt; không ký với khách trước khi pháp lý duyệt (IND-SAAS-010)"
---

# Thoả thuận xử lý dữ liệu cá nhân (bản mẫu 0.1.0)

> **Không phải tư vấn pháp lý.** Khung điều khoản do kỹ thuật soạn từ hiện trạng hệ thống để pháp lý hoàn thiện. Số điều luật trích
> dẫn là (chưa xác minh) cho tới khi pháp lý đối chiếu văn bản gốc (`PROJECT.md` §Khung pháp lý).

## 1. Các bên và vai trò
- **Bên kiểm soát dữ liệu:** khách hàng (tổ chức/chủ cơ sở lưu trú) dùng Hotel Manager.
- **Bên xử lý dữ liệu:** nhà cung cấp Hotel Manager (chủ sở hữu `LICENSE`).
- Quan hệ theo Luật 91/2025/QH15 (bên kiểm soát/bên xử lý — chưa xác minh điều) và GDPR Art. 28 khi có chủ thể EU.

## 2. Phạm vi xử lý
Loại dữ liệu, mục đích và cơ sở pháp lý theo `docs/privacy/data-map.yaml`; hoạt động xử lý theo `docs/privacy/ROPA.md`. Bên xử lý chỉ
xử lý theo chỉ thị bằng văn bản của bên kiểm soát (cấu hình và thao tác trong sản phẩm là chỉ thị).

## 3. Vị trí lưu trữ
Dữ liệu lưu tại **Việt Nam** (VPS tự host, `docs/privacy/processors.md`). Chuyển ra ngoài VN chỉ khi có hồ sơ chuyển dữ liệu và
thông báo trước theo mục 5.

## 4. Biện pháp an ninh
Mã hoá đường truyền (TLS), số giấy tờ mã hoá AES-256-GCM, cô lập tổ chức bằng RLS, nhật ký kiểm toán chỉ ghi thêm, sao lưu mã hoá ở
máy khác, quyền tối thiểu — chi tiết `docs/design/THREAT-MODEL.md`.

## 5. Bên xử lý phụ (sub-processor)
Danh sách công khai có phiên bản: [`subprocessors.md`](subprocessors.md). Thêm/thay sub-processor: **thông báo bên kiểm soát ≥ 30
ngày trước**; bên kiểm soát có quyền phản đối và chấm dứt phần dịch vụ liên quan.

## 6. Thông báo vi phạm
Bên xử lý thông báo bên kiểm soát **không chậm trễ quá 72 giờ** từ khi phát hiện (Singapore: trong **3 ngày lịch** sau khi xác định),
gồm: tính chất vi phạm, loại và số lượng ước tính chủ thể/bản ghi, hậu quả có thể, biện pháp đã/sẽ làm, đầu mối liên hệ. Quy trình:
`docs/ops/runbooks/data-breach.md`.

## 7. Hỗ trợ quyền chủ thể
Bên xử lý cung cấp chức năng trong sản phẩm để bên kiểm soát đáp ứng yêu cầu truy cập, chỉnh sửa, xoá, rút đồng ý, hạn chế xử lý
trong thời hạn luật định (`docs/privacy/`).

## 8. Chấm dứt — trả lại và xoá dữ liệu
Khi chấm dứt: bên kiểm soát xuất dữ liệu trong thời gian giữ công bố; sau đó bên xử lý xoá ở mọi kho (CSDL, kho file, bản sao lưu theo
vòng xoay) và cấp **chứng nhận xoá** (vòng đời xoá tổ chức — IND-SAAS-006).
Cụ thể (T-2312, D-121): chủ tổ chức yêu cầu xoá trong sản phẩm (xác thực lại + gõ lại tên) ⇒ **30 ngày** chờ, chỉ xem và xuất
dữ liệu, huỷ được bằng một nút; hết hạn bên xử lý xoá dữ liệu CSDL và object của tổ chức, trừ chứng từ tiền và dữ liệu chứng từ dựa vào
(giữ theo hạn kế toán 10 năm — chưa xác minh điều luật), nhật ký kiểm toán và hồ sơ thông báo lưu trú; chứng nhận xoá (JSON có SHA-256)
liệt kê số dữ liệu đã xoá theo kho và phần giữ kèm lý do.

## 9. Kiểm toán
Bên xử lý cung cấp thông tin cần thiết để chứng minh tuân thủ (nhật ký kiểm toán theo tổ chức, báo cáo đánh giá) theo yêu cầu hợp lý.

## Lịch sử phiên bản
| Phiên bản | Ngày | Thay đổi |
|---|---|---|
| 0.1.0 | 2026-10-25 | Bản mẫu kỹ thuật đầu tiên — chờ pháp lý |
