---
title: Sổ hoạt động xử lý dữ liệu cá nhân (ROPA) — khung
kind: privacy-register
updated: 2026-10-25
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
| DPIA | `docs/DPIA.md` 0.1.0 — **nháp kỹ thuật**, chờ DPO/pháp lý rà, ký, nộp; vẫn chặn dữ liệu thật |
| Hồ sơ chuyển dữ liệu ra nước ngoài | chưa quyết (phụ thuộc vị trí SMTP relay — `processors.md`) |

## Hoạt động xử lý
Mỗi hoạt động điền đủ cột; cột "Cơ sở pháp lý (đề xuất)" luôn chờ DPIA.

| ID | Hoạt động | Mục đích | Chủ thể | Nhóm dữ liệu (cột trong data-map) | Cơ sở pháp lý (đề xuất — chờ DPIA) | Bên nhận / xử lý | Ra nước ngoài | Hạn giữ (đề xuất) | Biện pháp bảo vệ |
|---|---|---|---|---|---|---|---|---|---|
| HĐ-01 | Quản lý hồ sơ người thuê/khách | nhận diện, liên lạc, lập hợp đồng/phiếu | người thuê, khách, người ở cùng | `persons.*` | thực hiện hợp đồng | VPS, kho sao lưu | không (nếu VPS tại VN) | đề xuất (D-116): ẩn danh 10 năm sau quan hệ cuối, job `privacy.retention` (RET-18) — chờ DPIA | RLS theo tổ chức, phân quyền theo vai trò, mã hoá đĩa/sao lưu |
| HĐ-02 | Lưu giữ giấy tờ nhận dạng cho thông báo lưu trú | nghĩa vụ thông báo lưu trú/khai báo tạm trú | khách lưu trú, người thuê | `identity_documents.*`, ảnh qua `files.storage_key` | nghĩa vụ pháp lý (nguồn luật chưa đối chiếu bản gốc) | VPS, kho file, clamd | không | đề xuất (D-116): ẩn danh 12 tháng sau quan hệ lưu trú/thuê cuối, ảnh xoá theo `files.delete_after` (RET-17) — chờ DPIA | AES-256-GCM + blind index, ảnh bucket riêng tư, URL ký ≤ 5 phút, che hiển thị, buồng phòng không thấy |
| HĐ-03 | Thu tiền, công nợ, cọc, đối soát | ghi nhận đúng tiền | người thuê, khách, người chuyển khoản | `receiving_accounts.*`, `bank_transactions.description`, `inbox.raw` | thực hiện hợp đồng | VPS; ngân hàng (chưa tích hợp) | không | chờ DPIA (sổ tiền có thể phải giữ theo luật kế toán — chưa xác minh) | sổ phụ bất biến, audit append-only |
| HĐ-04 | Tài khoản và xác thực nhân viên/người thuê | đăng nhập, MFA, phòng chống chiếm tài khoản | nhân viên, người thuê | `auth.*`, `invitations.*`, `guest_access_links.token_hash` | thực hiện hợp đồng dịch vụ; an ninh hệ thống | VPS; SMTP relay (OTP) | tuỳ relay | theo vòng đời tài khoản/phiên | mật khẩu băm, TOTP, khoá tạm, rate limit |
| HĐ-05 | Thông báo và email | nhắc thu, nhắc hết hạn, thông báo lưu trú | người thuê, nhân viên | `notifications.*`, `persons.email` | thực hiện hợp đồng; đồng ý với thư không bắt buộc (chưa quyết) | SMTP relay | tuỳ relay | chưa có hạn — chờ DPIA | che PII trong mẫu, opt-out theo loại |
| HĐ-06 | Nhập dữ liệu từ Excel/CSV | chuyển dữ liệu cũ vào hệ thống | người thuê (trong file của chủ cơ sở) | `import_rows.raw/data`, file nguồn | thực hiện hợp đồng dịch vụ với chủ cơ sở | VPS, kho file | không | 30 ngày sau commit/huỷ (đã có job) | làm rỗng dòng nhập, xoá file nguồn |
| HĐ-07 | Báo cáo và xuất dữ liệu | báo cáo công nợ/thu tiền; xuất theo yêu cầu chủ cơ sở | người thuê, khách | file xuất (không số giấy tờ/ảnh) | thực hiện hợp đồng dịch vụ | VPS, kho file | không | file hết hạn 15 phút, xoá ≤ 24 giờ | quyền xuất riêng, xác thực lại, link ngắn hạn |
| HĐ-08 | Nhật ký audit và an ninh | truy vết thao tác, điều tra sự cố | nhân viên, người thuê (người thực hiện) | `audit_events.*`, `auth.session.ipAddress/userAgent`, log; truy cập hỗ trợ `support_grants.*` (lý do, hạn, người cấp/thu hồi; T-2313) | an ninh hệ thống; nghĩa vụ truy vết (chưa xác minh) | VPS | không | audit không xoá ở pilot; log chưa chốt | append-only, che bí mật/PII |
| HĐ-09 | Sao lưu và khôi phục | phục hồi sau sự cố | mọi chủ thể ở trên | toàn bộ CSDL + file ở dạng mã hoá | an ninh hệ thống | kho sao lưu khác máy | tuỳ nhà cung cấp | retention-full 4 bản (đề xuất) | mã hoá phía client, khoá ngoài máy, diễn tập PITR |
| HĐ-10 | Phân tích sản phẩm tự host (sự kiện sản phẩm) | hiểu cách dùng sản phẩm (đăng ký tổ chức, tạo hợp đồng, phát hành kỳ thu, ghi nhận thanh toán, nhận phòng) để cải thiện; không quảng cáo, không bán/chia sẻ | nhân viên/chủ cơ sở (người thao tác, ở dạng giả danh) | `product_events.actor_key` (HMAC của id tài khoản), `product_events.props` (enum/số/bool), `product_events.organization_id` | đồng ý theo mục đích `product_analytics` — opt-in, mặc định không, rút một bước ở trang Bảo mật; sự kiện có người chỉ ghi khi đang đồng ý (D-119, T-2310; đề xuất — chờ pháp lý) | không có (tự host; không SDK, không gửi bên thứ ba, không cookie/định danh phía trình duyệt) | không | đề xuất (D-118): 13 tháng, job `privacy.retention` (RET-19); xoá ngay khi xoá tài khoản (`forgetAnalyticsActor`) — chờ DPIA | danh mục sự kiện đóng, không chuỗi tự do, danh sách đen tên trường + quét regex PII, khoá giả danh HKDF nhãn riêng, RLS theo tổ chức, chỉ-thêm (xoá qua hàm chỉ app_worker gọi) |
| HĐ-11 | Lưu bằng chứng đồng ý theo mục đích | chứng minh đồng ý (thời điểm, phiên bản văn bản, kênh, băm văn bản đã hiển thị) và xử lý theo mục đích (`service_core` bắt buộc; `product_analytics` tuỳ chọn) | nhân viên/chủ cơ sở, người thuê dùng portal (mọi tài khoản) | `consent_records.*` (id tài khoản, mục đích, cấp/rút, phiên bản, kênh, băm, thời điểm) | nghĩa vụ pháp lý — chứng minh đồng ý (Luật 91/2025/QH15 Đ.9; GDPR Art. 7(1)) (đề xuất; số điều chưa xác minh) | VPS (tự host) | không | chưa có hạn/job xoá — giữ suốt vòng đời tài khoản + thời hạn chứng minh; GIỮ khi xoá tài khoản (auth user bị ẩn danh, hàng không xoá — D-124) — chờ DPIA | chỉ-thêm (trigger chặn UPDATE/DELETE/TRUNCATE), RLS theo người dùng (`app.auth_user_id`), không email/IP, CHECK danh mục đóng, ghi ở server (chủ thể = phiên) |
| HĐ-12 | Thực hiện quyền của chủ thể dữ liệu (DSAR) | nhận, thực hiện và chứng minh đã thực hiện đúng hạn yêu cầu truy cập/xuất, xoá tài khoản, hạn chế xử lý (T-2311, D-120) | mọi tài khoản đăng nhập | `dsar_requests.*` (id tài khoản, loại, vùng, mốc nhận/hạn/xong, kết quả số dòng theo kho — không PII), `processing_restrictions.*` (id tài khoản, lúc bật) | nghĩa vụ pháp lý (Luật 91/2025/QH15 Đ.4, Đ.14; GDPR Art. 12, 15–18) (đề xuất; số điều NĐ 356/2025 chưa xác minh) | VPS (tự host) | không | RET-20: `dsar_requests` 3 năm sau khi xong (đề xuất — chưa có job); `processing_restrictions` tới khi tắt/xoá tài khoản | RLS theo người dùng; hàm xoá SECURITY DEFINER chỉ app_worker; xác thực lại ≤ 5 phút cho xuất/xoá; metric `hm_dsar_overdue` + cảnh báo `HmDsarOverdue` |

## Quyền của chủ thể (DSAR)
Tự phục vụ ở trang Bảo mật (T-2311, D-120; HĐ-12): **truy cập** — tải JSON dữ liệu của chính mình (tài khoản, phương thức đăng nhập, phiên, thành viên mọi tổ chức + hồ sơ người liên kết, đồng ý, hạn chế, yêu cầu đã gửi, số sự kiện phân tích giả danh) sau xác thực lại ≤ 5 phút; **xoá tài khoản** — xác thực lại + gõ lại email; chặn owner active duy nhất của tổ chức; pha 1 ngay (thu hồi phiên, xoá mật khẩu/2FA/mã xác minh, ẩn danh auth user), pha 2 ở worker (xoá sự kiện phân tích, kết thúc membership có audit, ẩn danh hồ sơ người không gắn chứng từ); **giữ** bản ghi đồng ý (bằng chứng, D-124), chứng từ tiền + hồ sơ người gắn chứng từ (nghĩa vụ kế toán), nhật ký kiểm toán — liệt kê kèm lý do trong `dsar_requests.result`; **hạn chế xử lý** — bật/tắt một bước, `track()` bỏ qua. Hạn theo vùng ở `packages/app/src/privacy/dsar-policy.ts` (VN 72 giờ — chưa xác minh; EU/UK 30 ngày; CA 45; SG/TH 30; vùng chưa biết = chặt nhất). Ngoài repo: bản sao lưu hết theo RET-10 (khôi phục phải áp lại yêu cầu xoá — RUNBOOK §3.13); không có bên xử lý thứ ba nhận dữ liệu tài khoản (phân tích tự host). Chỉnh sửa: tên/email qua tài khoản; dữ liệu do tổ chức nhập (hồ sơ người thuê) — tổ chức là bên kiểm soát, người dùng liên hệ tổ chức.

## Lịch sử cập nhật
| Ngày | Thay đổi | Người |
|---|---|---|
| 2026-10-16 | Tạo khung từ `data-map.yaml` (T-309); chưa có nội dung pháp lý | kỹ thuật |
| 2026-10-25 | DPIA nháp kỹ thuật 0.1.0 (`docs/DPIA.md`); nhắc rà 6 tháng có CI (`docs/privacy/CHANGELOG.md`, `scripts/privacy-docs.mjs`) | kỹ thuật |
| 2026-10-25 | T-2308 (D-116): job `privacy.retention` xoá/ẩn danh theo hạn — thông báo, phiên/mã xác minh, link khách, `inbox.raw`, giấy tờ, hồ sơ người (`docs/ops/retention-policy.md` RET-11…RET-18); hạn vẫn là đề xuất chờ DPIA | kỹ thuật |
| 2026-10-25 | T-2309 (D-118): thêm HĐ-10 phân tích sản phẩm tự host (`product_events`, RET-19); chưa có DPO/pháp lý duyệt cơ sở pháp lý | kỹ thuật |
| 2026-10-25 | T-2311 (D-120): thêm HĐ-12 DSAR (`dsar_requests`, `processing_restrictions`); mục "Quyền của chủ thể" có quy trình tự phục vụ | kỹ thuật |
| 2026-10-25 | T-2310 (D-119): thêm HĐ-11 bằng chứng đồng ý (`consent_records`); HĐ-10 chuyển sang đồng ý theo mục đích `product_analytics` (opt-in) | kỹ thuật |
| 2026-10-25 | T-2313 (D-122): HĐ-08 thêm truy cập hỗ trợ có thời hạn (`support_grants`, nhân viên hỗ trợ nền tảng chỉ xem, mọi truy cập ghi audit kèm lý do) | kỹ thuật |

> Nhắc rà: mỗi lần đổi data-map, thêm bên xử lý hoặc đổi mục đích, cập nhật bảng trên và dòng lịch sử; rà định kỳ ít nhất 6 tháng/lần (đề xuất; CI nhắc quá 6 tháng qua `docs/privacy/CHANGELOG.md`).
