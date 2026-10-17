---
title: Sổ hoạt động xử lý dữ liệu cá nhân (ROPA) — khung
kind: privacy-register
updated: 2026-10-16
status: KHUNG — chờ DPIA và pháp lý duyệt; mọi cơ sở pháp lý, hạn giữ là đề xuất
---

# ROPA — khung chờ DPIA

> Khung hồ sơ hoạt động xử lý (CMP-AUDIT-003). **Không phải hồ sơ pháp lý**: nội dung pháp lý do người soạn/duyệt; hồ sơ đánh giá tác động (DPIA, `docs/DPIA.md` — chưa có) là điều kiện trước khi dùng dữ liệu thật (`PROJECT.md` §6). Dữ liệu từng cột: [`data-map.yaml`](data-map.yaml) (có máy kiểm với catalog CSDL). Nhà cung cấp: [`processors.md`](processors.md). Rủi ro: [`../RISKS.md`](../RISKS.md).
> Vai trò (chưa xác minh — cần pháp lý): chủ cơ sở = bên kiểm soát dữ liệu của người thuê/khách của họ; nền tảng Hotel Manager = bên xử lý thay mặt chủ cơ sở; với dữ liệu tài khoản nhân viên và vận hành nền tảng, nền tảng là bên kiểm soát. Cần pháp lý xác nhận cách phân vai.

## Thông tin chung
| Mục | Giá trị |
|---|---|
| Bên kiểm soát / xử lý | (chưa gán — pháp lý) |
| Bộ phận/đầu mối bảo vệ dữ liệu | (chưa gán; miễn có thời hạn cho doanh nghiệp nhỏ — chưa xác minh) |
| Lần rà gần nhất | 2026-10-16 (khung) |
| DPIA | chưa có — chặn dữ liệu thật |
| Hồ sơ chuyển dữ liệu ra nước ngoài | chưa quyết (phụ thuộc vị trí SMTP relay — `processors.md`) |

## Hoạt động xử lý
Mỗi hoạt động điền đủ cột; cột "Cơ sở pháp lý (đề xuất)" luôn chờ DPIA.

| ID | Hoạt động | Mục đích | Chủ thể | Nhóm dữ liệu (cột trong data-map) | Cơ sở pháp lý (đề xuất — chờ DPIA) | Bên nhận / xử lý | Ra nước ngoài | Hạn giữ (đề xuất) | Biện pháp bảo vệ |
|---|---|---|---|---|---|---|---|---|---|
| HĐ-01 | Quản lý hồ sơ người thuê/khách | nhận diện, liên lạc, lập hợp đồng/phiếu | người thuê, khách, người ở cùng | `persons.*` | thực hiện hợp đồng | VPS, kho sao lưu | không (nếu VPS tại VN) | chờ DPIA; có `anonymized_at` | RLS theo tổ chức, phân quyền theo vai trò, mã hoá đĩa/sao lưu |
| HĐ-02 | Lưu giữ giấy tờ nhận dạng cho thông báo lưu trú | nghĩa vụ thông báo lưu trú/khai báo tạm trú | khách lưu trú, người thuê | `identity_documents.*`, ảnh qua `files.storage_key` | nghĩa vụ pháp lý (nguồn luật chưa đối chiếu bản gốc) | VPS, kho file, clamd | không | `retention_until` — chờ DPIA | AES-256-GCM + blind index, ảnh bucket riêng tư, URL ký ≤ 5 phút, che hiển thị, buồng phòng không thấy |
| HĐ-03 | Thu tiền, công nợ, cọc, đối soát | ghi nhận đúng tiền | người thuê, khách, người chuyển khoản | `receiving_accounts.*`, `bank_transactions.description`, `inbox.raw` | thực hiện hợp đồng | VPS; ngân hàng (chưa tích hợp) | không | chờ DPIA (sổ tiền có thể phải giữ theo luật kế toán — chưa xác minh) | sổ phụ bất biến, audit append-only |
| HĐ-04 | Tài khoản và xác thực nhân viên/người thuê | đăng nhập, MFA, phòng chống chiếm tài khoản | nhân viên, người thuê | `auth.*`, `invitations.*`, `guest_access_links.token_hash` | thực hiện hợp đồng dịch vụ; an ninh hệ thống | VPS; SMTP relay (OTP) | tuỳ relay | theo vòng đời tài khoản/phiên | mật khẩu băm, TOTP, khoá tạm, rate limit |
| HĐ-05 | Thông báo và email | nhắc thu, nhắc hết hạn, thông báo lưu trú | người thuê, nhân viên | `notifications.*`, `persons.email` | thực hiện hợp đồng; đồng ý với thư không bắt buộc (chưa quyết) | SMTP relay | tuỳ relay | chưa có hạn — chờ DPIA | che PII trong mẫu, opt-out theo loại |
| HĐ-06 | Nhập dữ liệu từ Excel/CSV | chuyển dữ liệu cũ vào hệ thống | người thuê (trong file của chủ cơ sở) | `import_rows.raw/data`, file nguồn | thực hiện hợp đồng dịch vụ với chủ cơ sở | VPS, kho file | không | 30 ngày sau commit/huỷ (đã có job) | làm rỗng dòng nhập, xoá file nguồn |
| HĐ-07 | Báo cáo và xuất dữ liệu | báo cáo công nợ/thu tiền; xuất theo yêu cầu chủ cơ sở | người thuê, khách | file xuất (không số giấy tờ/ảnh) | thực hiện hợp đồng dịch vụ | VPS, kho file | không | file hết hạn 15 phút, xoá ≤ 24 giờ | quyền xuất riêng, xác thực lại, link ngắn hạn |
| HĐ-08 | Nhật ký audit và an ninh | truy vết thao tác, điều tra sự cố | nhân viên, người thuê (người thực hiện) | `audit_events.*`, `auth.session.ipAddress/userAgent`, log | an ninh hệ thống; nghĩa vụ truy vết (chưa xác minh) | VPS | không | audit không xoá ở pilot; log chưa chốt | append-only, che bí mật/PII |
| HĐ-09 | Sao lưu và khôi phục | phục hồi sau sự cố | mọi chủ thể ở trên | toàn bộ CSDL + file ở dạng mã hoá | an ninh hệ thống | kho sao lưu khác máy | tuỳ nhà cung cấp | retention-full 4 bản (đề xuất) | mã hoá phía client, khoá ngoài máy, diễn tập PITR |

## Quyền của chủ thể (DSAR)
Chưa có quy trình. Việc cần làm (người + kỹ thuật): xác định thời hạn pháp luật yêu cầu (chưa xác minh — cần pháp lý), đường nhận yêu cầu, truy xuất theo `persons.id` qua data-map, xoá/ẩn danh (`persons.anonymized_at`) và ảnh hưởng tới sổ tiền bất biến.

## Lịch sử cập nhật
| Ngày | Thay đổi | Người |
|---|---|---|
| 2026-10-16 | Tạo khung từ `data-map.yaml` (T-309); chưa có nội dung pháp lý | kỹ thuật |

> Nhắc rà: mỗi lần đổi data-map, thêm bên xử lý hoặc đổi mục đích, cập nhật bảng trên và dòng lịch sử; rà định kỳ ít nhất 6 tháng/lần (đề xuất — chưa có CI nhắc quá hạn).
