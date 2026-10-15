# THREAT-MODEL — Hotel Manager · phiên bản 1 · 2026-10-15

> Chủ: (chưa gán — Tech Lead) · Duyệt: chờ · Phạm vi: web/API, worker, PostgreSQL, object storage SeaweedFS, Better Auth, Caddy, kho sao lưu pgBackRest, portal người thuê/khách, webhook mô phỏng, import/export.
> Ngoài phạm vi V1: OTA, IoT/khoá, ngân hàng thật (chưa có hợp đồng). Các mục này phải có threat model riêng khi bật.
> Kế hoạch gốc §16 xác định ba rủi ro nghiêm trọng nhất: xem nhầm dữ liệu cơ sở khác, sửa tiền không dấu vết, lộ giấy tờ nhận dạng.

## 1. Tài sản
| ID | Tài sản | Phân loại | Ảnh hưởng |
|---|---|---|---|
| A-01 | Giấy tờ nhận dạng: số và ảnh CCCD/hộ chiếu | nhạy cảm (NĐ 356/2025 — [T], chưa đối chiếu bản gốc) | pháp lý, thiệt hại cho khách |
| A-02 | Dữ liệu cá nhân cơ bản: tên, SĐT, email, địa chỉ của người thuê, khách, nhân viên | cá nhân | pháp lý, uy tín |
| A-03 | Sổ tiền: phiếu, thanh toán, phân bổ, cọc, bút toán | toàn vẹn | mất tiền, tranh chấp, gian lận |
| A-04 | Tồn phòng: allocation, booking, hợp đồng | toàn vẹn, sẵn sàng | bán trùng, khách không có phòng |
| A-05 | Ranh giới tenant (dữ liệu giữa các tổ chức) | bí mật | sự cố nghiêm trọng, chặn phát hành |
| A-06 | Secret: `BETTER_AUTH_SECRET`, khoá S3 SeaweedFS, khoá mã hoá pgBackRest, DB URL, khoá ký webhook, khoá email | bí mật | chiếm toàn hệ thống |
| A-07 | Tài khoản nhân viên có quyền tiền/quản trị | xác thực | gian lận, lộ dữ liệu hàng loạt |
| A-08 | Bản sao lưu, file xuất | bí mật | lộ dữ liệu hàng loạt |

## 2. Thành phần và ranh giới tin cậy
```text
[Trình duyệt/PWA] --(1) HTTPS--> [Next.js web/API] --(2) role app_runtime + RLS--> [PostgreSQL]
       |                              |--(3)--> [Better Auth — cùng Postgres]
       |--(4) URL ký ngắn hạn-->      |--(5)--> [Object storage riêng tư]
[Ngân hàng/mô phỏng] --(6) webhook--> [web] ; [worker] --(7)--> [Email] ; [worker] --(2')--> [PostgreSQL]
[Người dùng] --(8) file Excel/CSV--> [import] ; [export] --(9) link có hạn--> [người dùng]
TB1 Internet↔web · TB2 web/worker↔DB · TB3 ↔ dịch vụ ngoài · TB4 portal khách (link) ↔ web
```

## 3. Kẻ tấn công giả định
| Ai | Năng lực | Mục tiêu |
|---|---|---|
| Người lạ trên Internet | request tuỳ ý, bot | dò tài khoản, spam booking engine, DoS |
| Nhân viên tổ chức A | phiên hợp lệ, đổi ID trong request | đọc/sửa dữ liệu tổ chức B hoặc cơ sở ngoài phạm vi |
| Nhân viên gian lận trong cùng tổ chức | quyền lễ tân/thu ngân | sửa/hoàn tiền không dấu vết, xoá chứng từ |
| Người thuê/khách | link portal | xem phiếu của người khác, kéo dài link |
| Người gửi webhook giả | biết endpoint | tạo "đã thu" giả |
| Kẻ chiếm thiết bị | điện thoại nhân viên bị mất | đọc cache, phiên còn sống |
| Hỗ trợ nền tảng lạm quyền | tài khoản support | xem dữ liệu khách hàng ngoài yêu cầu |

## 4. Mối đe doạ (STRIDE)
| ID | Luồng | STRIDE | Mối đe doạ | Mức | Biện pháp | Bằng chứng nghiệm thu | Trạng thái |
|---|---|---|---|---|---|---|---|
| TM-01 | 2 | I | Truy vấn hoặc job thiếu điều kiện tenant, IDOR qua đổi `property_id`/`id` | Cao | INV-G1: FK ghép `organization_id`, RLS `app.org_id`, role không BYPASSRLS, `authorize()` trên mọi command; 404 cho tài nguyên ngoài scope | test chéo tenant trên API, file, tìm kiếm, báo cáo, export, worker; test role `rolbypassrls=false`, bảng `relforcerowsecurity=true` | mở |
| TM-02 | 1 | S | Chiếm tài khoản nhân viên (đoán mật khẩu, phiên bị lộ) | Cao | MFA bắt buộc cho owner/manager/accountant, rate limit đăng nhập, cookie HttpOnly/Secure/SameSite, thu hồi phiên khi đổi quyền | test MFA bắt buộc; test thu hồi membership → request kế tiếp 401/403 | mở |
| TM-03 | 1 | T/R | Sửa hoặc xoá chứng từ đã ghi sổ, hoàn tiền không duyệt | Cao | INV-G4, INV-F1, INV-F5, INV-F6: trigger chặn UPDATE/DELETE, đảo có lý do, hạn mức + duyệt, audit trước/sau | test UPDATE `journal_lines` bị từ chối; test hoàn vượt hạn mức → `APPROVAL_LIMIT_EXCEEDED` | mở |
| TM-04 | 6 | S/T | Webhook giả hoặc phát lại tạo tiền | Cao | chữ ký + timestamp, kiểm tài khoản nhận và số tiền, inbox unique, INV-F3/F4 | test chữ ký sai → 401; 100 lần cùng payload → 1 payment | mở |
| TM-05 | 1 | T | Race khi đặt phòng hoặc phân bổ tiền | Cao | EXCLUDE gist (INV-I1), khoá hàng theo thứ tự (INV-F2), idempotency (INV-G5) | 100 lệnh tranh phòng → 1 allocation; 2 phân bổ song song không vượt | mở |
| TM-06 | 4 | I | Lộ ảnh CCCD qua URL đoán được, cache PWA, log | Cao | bucket riêng tư, URL ký ≤ 5 phút, kiểm quyền mỗi lần cấp URL, SW không cache ảnh/API PII, che CCCD trong log và màn hình, tách quyền buồng phòng | test housekeeping xin URL giấy tờ → 404; test SW cache không chứa route PII; quét log fixture | mở |
| TM-07 | 4,8 | T/E | Upload độc hại: file thực thi, ảnh chứa EXIF GPS, file nén bom | TB | allowlist MIME + magic bytes, giới hạn dung lượng, bỏ EXIF, quét malware (adapter), lưu tên ngẫu nhiên | test MIME giả → 415; ảnh ra không còn EXIF | mở |
| TM-08 | 9 | I | Xuất dữ liệu vượt scope; CSV formula injection | TB | quyền xuất riêng, xác thực lại, link có hạn + audit, escape `= + - @ \t \r` | test export chỉ chứa cơ sở được phép; ô bắt đầu bằng `=` được escape | mở |
| TM-09 | 1 | T | XSS hoặc CSRF trên form tiền | TB | React escape, CSP có nonce, kiểm `Origin` cho ghi, SameSite=Lax | header CSP trong E2E; POST thiếu Origin hợp lệ → 403 | mở |
| TM-10 | — | I | Secret lọt vào client bundle, repo hoặc log | Cao | biến secret không có tiền tố `NEXT_PUBLIC_`, validate env lúc khởi động, gitleaks trong CI, che log | gitleaks CI; test build client không chứa `BETTER_AUTH_SECRET`, khoá S3, khoá pgBackRest | mở |
| TM-11 | TB4 | S/I | Link khách bị đoán hoặc chia sẻ lại | TB | token ≥ 128 bit, có hạn, phạm vi một lượt ở, có thể thu hồi, rate limit | test link hết hạn → 410; token khác stay → 404 | mở |
| TM-12 | — | E/R | Hỗ trợ nền tảng truy cập dữ liệu khách tuỳ ý | TB | quyền support tạm thời theo ticket, giới hạn phạm vi, audit mọi lượt truy cập (F-015, V1) | test quyền support hết hạn → 403 | mở (V1) |
| TM-13 | 1 | D | Spam đăng nhập, booking engine, export nặng | TB | rate limit, báo cáo lớn chạy job, timeout truy vấn, `statement_timeout` | test vượt giới hạn → 429 | mở |
| TM-14 | 7 | I | Email chứa PII nhạy cảm hoặc gửi nhầm người | TB | mẫu email không chứa CCCD/số tiền chi tiết ngoài phạm vi; kiểm người nhận theo membership/lease | test snapshot mẫu email | mở |
| TM-16 | — | E/I/D | Máy chủ tự host bị xâm nhập hoặc mất (lộ cổng DB/S3, image chưa vá, đĩa hỏng) | Cao | tường lửa, chỉ Caddy ra ngoài, image ghim digest + cập nhật định kỳ, pgBackRest + đồng bộ file ra máy khác, diễn tập restore | `ss -tlnp` trên staging chỉ 80/443/22; T-010 restore PITR đạt | mở |
| TM-15 | — | I | Thiết bị mất còn phiên và cache | TB | phiên có hạn, logout xoá cache và hàng chờ (có cảnh báo nháp), thu hồi phiên từ xa | E2E logout → Cache Storage không còn dữ liệu nghiệp vụ | mở |

## 5. Giả định và chấp nhận rủi ro
- **Tự host (ADR-0002): không còn nhà cung cấp lo lớp hạ tầng.** Đội chịu vá OS/image, tường lửa (chỉ mở 80/443 qua Caddy; DB và S3 không ra Internet), SSH bằng khoá, giám sát và sao lưu ngoài máy. Thêm TM-16 bên dưới.
- Better Auth: chỉ bật email/mật khẩu, twoFactor, quản lý phiên (+ email OTP cho portal nếu PO chọn); theo dõi advisory (nhiều lỗi High/Critical ở plugin năm 2026).
- Pilot tiết kiệm chưa bật PITR → RPO DB tối đa 24 giờ. Chỉ chấp nhận khi chủ pilot đã hiểu giới hạn này và có nguồn đối chiếu (kế hoạch §17). Người chấp nhận: chủ dự án, chờ quyết.

## 6. Hành động còn mở
| Mối đe doạ | Việc | Task |
|---|---|---|
| TM-01, TM-05 | Role DB, RLS (FORCE + WITH CHECK), EXCLUDE, test chéo tenant và đồng thời | T-005, T-007, T-009 (PLAN) |
| TM-02 | Auth + MFA + thu hồi phiên | T-006 |
| TM-03 | Sổ phụ bất biến, idempotency, audit append-only | T-008, T-010 |
| TM-04 | Inbox + bank_transactions chống trùng (T-010); chữ ký + timestamp webhook, tạo payment từ webhook, IND-FIN-004 | T-010 (phần chống trùng) · **đợt 2** F-005 (chữ ký, payment) |
| TM-09 | Kiểm `Origin` cho ghi, CSP nonce | T-008 |
| TM-13 | `statement_timeout`, rate limit | T-005 (timeout) · T-006 (rate limit đăng nhập) |
| TM-16 | Tường lửa, image ghim digest, sao lưu ngoài máy | T-012 (PITR + compose); kiểm cổng mở trên staging = **người** (mua VPS là điểm dừng) |
| TM-06, TM-07 | File riêng tư, upload | T-011 |
| TM-10 | gitleaks + validate env + test bundle không chứa secret | T-002, T-003 |
| Tất cả | DPIA + pháp lý duyệt trước dữ liệu thật | ngoài vòng tự động (người) |

## Lịch sử
| Phiên bản | Ngày | Thay đổi | Lý do |
|---|---|---|---|
| 1 | 2026-10-15 | tạo | G4 từ kế hoạch §16 |
| 1.1 | 2026-10-15 | tự host (TM-16), gán lại task theo PLAN mới, TM-04/09/13 có chủ | ADR-0002, review độc lập |
