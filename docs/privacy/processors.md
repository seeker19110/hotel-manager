---
title: Bên xử lý dữ liệu cá nhân (processors)
kind: privacy-register
updated: 2026-10-25
status: khung — nhiều nhà cung cấp "chưa chọn"; chờ chủ dự án chọn và pháp lý soạn DPA
---

# Bên xử lý dữ liệu cá nhân

> Sổ nhà cung cấp chạm dữ liệu cá nhân (CMP-AUDIT-007, CMP-VN-004, IND-SAAS-010). Chưa có hợp đồng/DPA nào: pháp lý soạn DPA mẫu và duyệt (việc của người). Cột dữ liệu trỏ [`data-map.yaml`](data-map.yaml). Hạ tầng tự host (ADR-0002) nên phần lớn dữ liệu nằm trên VPS của chính dự án.
> **Quy tắc:** thêm nhà cung cấp/SDK mới chạm dữ liệu cá nhân ⇒ thêm một dòng ở đây **trước** khi gộp PR (mẫu PR có mục kiểm). Máy ép: bản máy đọc `docs/compliance/vendors.yaml` (cùng danh sách tên) + `scripts/privacy-docs.mjs` ở job `new-deps` — SDK dịch vụ ngoài mới trong phụ thuộc runtime mà không có dòng ⇒ CI đỏ; bên đang dùng rà lại ≤ 12 tháng.

| Bên | Vai trò | Dữ liệu chạm | Vị trí / nước | DPA / hợp đồng | Trạng thái | Rà lần cuối |
|---|---|---|---|---|---|---|
| **VPS tại Việt Nam** | máy chủ chạy web, worker, Postgres, SeaweedFS, clamd, Caddy | toàn bộ dữ liệu trong `data-map.yaml` (tên, SĐT, email, địa chỉ, số giấy tờ mã hoá, ảnh giấy tờ, IP, nội dung thông báo) | VN (đề xuất — chưa có VPS) | chưa có (cần pháp lý) | **chưa chọn** | 2026-10-16 |
| **Kho sao lưu pgBackRest (khác máy)** | giữ bản sao lưu CSDL + WAL, mã hoá aes-256-cbc phía client | toàn bộ CSDL ở dạng mã hoá (khoá `PGBACKREST_REPO_CIPHER_PASS` giữ ngoài máy) | VN (đề xuất; chưa chọn) | chưa có | **chưa chọn** | 2026-10-16 |
| **Kho sao lưu file (khác máy)** | bản sao bucket file bằng rclone mỗi ngày (ADR-0002); gồm ảnh giấy tờ | ảnh giấy tờ, ảnh công tơ/sự cố, file xuất — **chưa mã hoá phía client** (chưa xác minh cấu hình rclone crypt) | VN (đề xuất; chưa chọn) | chưa có | **chưa chọn** | 2026-10-16 |
| **SMTP relay** | gửi email giao dịch và OTP người thuê | email + tên người nhận, nội dung thông báo (đã che SĐT/CCCD/số tài khoản; email nhắc không có số tiền) | chưa chọn — relay nước ngoài ⇒ chuyển dữ liệu ra nước ngoài, cần hồ sơ (ADR-0002) | chưa có | **chưa chọn** (adapter SMTP chờ duyệt thư viện MIT-0, D-010; hiện `FakeEmailSender`) | 2026-10-16 |
| **Prometheus / Alertmanager** | giám sát, cảnh báo | chỉ số tổng hợp không nhãn tổ chức, không PII; kênh nhận cảnh báo (email/chat) chưa chọn | tự host (đề xuất) | không cần nếu tự host | **chưa dựng** (`deploy/prometheus/alerts.yml` có sẵn) | 2026-10-16 |
| **ClamAV (clamd)** | quét mã độc file tải lên | nội dung file (kể cả ảnh giấy tờ) đi qua clamd nội bộ; chỉ tải chữ ký từ máy chủ cập nhật (không gửi dữ liệu ra ngoài — chưa xác minh cấu hình `freshclam`) | tự host trên VPS | không cần nếu tự host | **chưa dựng** | 2026-10-16 |
| **Let's Encrypt (ACME qua Caddy)** | cấp chứng chỉ TLS | tên miền, email liên hệ ACME (`HM_ACME_EMAIL`) | ngoài VN (chưa xác minh) | điều khoản dịch vụ công khai | khi có tên miền | 2026-10-16 |
| **GitHub** | lưu mã, CI | mã nguồn, dữ liệu giả; **không** dữ liệu thật (ràng buộc cứng `PROJECT.md` §8); gitleaks chặn bí mật | ngoài VN | điều khoản GitHub | đang dùng | 2026-10-16 |
| **Registry image (Docker Hub)** | kéo image ghim digest | không có dữ liệu cá nhân (chỉ kéo) | ngoài VN | điều khoản công khai | đang dùng | 2026-10-16 |
| Better Auth, Next.js, thư viện npm | thư viện chạy trong tiến trình — **không** phải bên xử lý | — | — | giấy phép phụ thuộc kiểm bởi `scripts/check-licenses.mjs` | — | 2026-10-16 |
| Ngân hàng / cổng thanh toán | **chưa tích hợp** (adapter mô phỏng) | số tài khoản nhận, nội dung chuyển khoản, tên người chuyển | VN | cần hợp đồng + threat model riêng khi bật | không dùng ở pilot | 2026-10-16 |

## Danh sách nhà cung cấp ngoài VN (CMP-VN-004)
Hiện: GitHub, registry image, Let's Encrypt — không chứa dữ liệu thật. **SMTP relay** là điểm duy nhất có thể đưa dữ liệu thật ra ngoài VN: chốt nơi đặt relay trước khi dùng dữ liệu thật; nếu ngoài VN cần hồ sơ chuyển dữ liệu ra nước ngoài (pháp lý, `.xtemplates/framework/16-compliance-privacy/vietnam-data-law.md` — chưa xác minh số điều).

## Việc cần người
1. Chọn VPS, kho sao lưu (CSDL + file), SMTP relay, kênh cảnh báo; ghi tên, nước, ngày vào bảng.
2. Pháp lý soạn DPA + điều khoản thông báo vi phạm (thời hạn ghép với [data-breach](../ops/runbooks/data-breach.md)).
3. Quyết định mã hoá phía client cho kho file sao lưu (hiện chưa có trong thiết kế).
