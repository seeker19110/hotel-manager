---
status: proposed
implementation-status: not-started
date: 2026-10-15
decision-makers: chủ dự án (đã chọn tự host 2026-10-15; chi tiết chờ duyệt ở cổng PLAN)
consulted: nghiên cứu docs/research/2026-10-15-self-host.md
informed: đội phát triển
---

# ADR-0002: Tự host toàn bộ — Postgres 17 tự quản + pgBackRest, Better Auth trong app, SeaweedFS, Caddy; email qua SMTP relay

Thay phần hosting, xác thực, lưu file và sao lưu của [ADR-0001](0001-modular-monolith-typescript-postgres.md). Các phần còn lại của ADR-0001 giữ nguyên.

## Bối cảnh và vấn đề
Ngày 2026-10-15 chủ dự án chọn **tự host** thay cho Supabase cloud và hosting managed. Vì vậy phải chọn lại bốn thứ mà Supabase từng lo:
- xác thực + MFA;
- object storage riêng tư;
- sao lưu có PITR;
- reverse proxy/TLS.

Mục tiêu phục hồi trong kế hoạch vẫn giữ: RPO DB ≤ 15 phút, RTO ≤ 4 giờ, RPO file ≤ 24 giờ.

## Yếu tố quyết định
- Giấy phép OSI dễ dãi (MIT/Apache) cho phần nhúng vào sản phẩm SaaS. Tránh AGPL ở thành phần lưu trữ dữ liệu khách hàng.
- Dự án còn được bảo trì; có phát hành bảo mật gần đây.
- Gọn cho đội 4 FTE: ít container, chạy được bằng một `docker compose`.
- Dữ liệu và quyền nằm trong Postgres của mình (`persons`/`memberships`), không khoá vào nhà cung cấp.
- Có PITR thật với bản sao **ngoài máy chủ chính**.

## Các phương án đã cân nhắc
| Năng lực | Phương án |
|---|---|
| Xác thực | **Better Auth** · Ory Kratos · Auth.js v5 · Supabase tự host |
| Object storage | **SeaweedFS** · MinIO · Garage · Ceph RGW |
| Sao lưu PITR | **pgBackRest** · WAL-G · Barman |
| Reverse proxy | **Caddy** · Traefik |
| Email | **SMTP relay trả phí** · tự gửi từ VPS |

## Quyết định

| Thành phần | Chọn | Phiên bản ghim (xác minh 2026-10-15) | Ràng buộc bắt buộc |
|---|---|---|---|
| CSDL | PostgreSQL 17 (image chính thức) | `postgres:17.11`, ghim theo digest | Role `app_runtime`/`app_worker` không owner, không BYPASSRLS (giữ INV-G1) |
| Sao lưu | pgBackRest: full hằng tuần, diff hằng ngày, lưu trữ WAL liên tục | ≥ 2.59.3 (bản vá bảo mật mã hoá) | Repo S3/SFTP **ở nhà cung cấp hoặc máy khác**; bật mã hoá repo; diễn tập restore trước pilot (T-010) |
| Xác thực | Better Auth, chạy trong `apps/web`, adapter Kysely/`pg` dùng chung Postgres | ≥ 1.7.9 (đã gồm bản vá GHSA-965c-763c-88jm của 1.7.7) | **Chỉ bật** lõi email/mật khẩu, `twoFactor` (TOTP), quản lý/thu hồi phiên. **Không bật** magic link, OAuth proxy, SSO, SCIM, Stripe, device login (các plugin này có advisory High/Critical trong 2026). Theo dõi advisory GitHub; Dependabot bắt buộc |
| Object storage | SeaweedFS, S3 API, bucket riêng tư | 4.48 | Presigned URL ≤ 5 phút; bật versioning; đồng bộ sang storage ngoài máy mỗi ngày (rclone) để đạt RPO file ≤ 24 giờ |
| Reverse proxy | Caddy, TLS tự động | 2.11.7 | Header bảo mật (HSTS, CSP do app đặt); chặn cổng DB/S3 khỏi Internet |
| Email | SMTP relay trả phí qua adapter `EmailSender` | — | **Chọn nhà cung cấp là điểm dừng.** Tham khảo giá ~10k mail/tháng: Amazon SES ~1 USD; Postmark, Mailgun 15 USD; Resend 20 USD (gói 50k). Dev/CI dùng `FakeEmailSender` |
| Telemetry | Tắt `NEXT_TELEMETRY_DISABLED=1` | — | |

Triển khai: một VPS chạy `docker compose` (caddy, web, worker, postgres, seaweedfs) cho pilot. Staging và production tách nhau. Kho sao lưu đặt ở chỗ khác.

**Vị trí dữ liệu — điểm dừng pháp lý.** Theo nguồn thứ cấp:
- Luật 91/2025 (Đ.20/22) đòi hồ sơ [T — chưa đối chiếu văn bản gốc] đánh giá tác động chuyển dữ liệu xuyên biên giới trong 60 ngày khi lưu hoặc xử lý dữ liệu thu thập tại VN trên hệ thống ở nước ngoài.
- Luật ANM 116/2025 có thể đòi lưu dữ liệu tại VN; nghị định hướng dẫn chưa xác minh.

Vì vậy đề xuất **đặt VPS và kho sao lưu tại Việt Nam**. Lưu ý: SMTP relay nước ngoài vẫn chuyển email và tên người nhận ra nước ngoài, nên vẫn cần hồ sơ (CTIA) hoặc chọn relay trong nước. Người phụ trách pháp lý phải xác nhận trước khi đưa dữ liệu thật lên.

### Hệ quả
- Tốt:
  - Không có phí nền tảng.
  - Toàn bộ dữ liệu, kể cả tài khoản đăng nhập, nằm trong một Postgres.
  - Không có thành phần AGPL.
  - Dev/CI giống production hơn: cùng Postgres, cùng S3 API.
- Xấu / chấp nhận:
  - **Đội tự chịu vận hành**: vá OS và image, giám sát, xoay vòng log, chứng chỉ, sao lưu và diễn tập. RTO 4 giờ phụ thuộc runbook và người trực.
  - Better Auth có nhịp advisory dày, nên phải theo dõi và cập nhật nhanh.
  - pgBackRest từng gặp khủng hoảng người bảo trì (4–5/2026, nay có nhóm tài trợ). Phương án dự phòng là WAL-G (Apache-2.0); runbook ghi cả hai.
  - SeaweedFS không có S3 bucket replication API, nên phải đồng bộ ra ngoài bằng job riêng.
- Việc phải làm tiếp:
  - T-001 (cài Postgres 17/pgBackRest/SeaweedFS không cần Docker).
  - T-006 (Better Auth + MFA).
  - T-011 (SeaweedFS + URL ký).
  - T-012 (pgBackRest backup → restore → PITR thử + `deploy/compose.yaml`).
  - Task G5 mới `docker compose` cho staging (điểm dừng: mua VPS).
  - RUNBOOK vận hành ở G8.

### Xác nhận
- `package.json` có `better-auth` ≥ 1.7.9.
- Test liệt kê plugin Better Auth đang bật = {email/password, twoFactor}.
- `compose.yaml` ghim digest `postgres:17.11` và `chrislusf/seaweedfs:4.48`.
- `scripts/db-backup-restore-check.sh` chứng minh khôi phục về một thời điểm (PITR) trên dữ liệu giả.
- Không có package AGPL: CI kiểm license.

## Ưu / nhược từng phương án
- **Better Auth**:
  - Tốt: MIT; peer `next ^16`; adapter Postgres/Kysely không cần ORM; có twoFactor và quản lý phiên; nhóm này đang bảo trì cả Auth.js.
  - Xấu: nhiều advisory năm 2026, phần lớn ở plugin mà ta không bật.
- **Ory Kratos**:
  - Tốt: Apache-2.0, trưởng thành.
  - Xấu: thêm một dịch vụ Go riêng. README ghi bản OSS dành cho "unimportant workloads without SLAs".
- **Auth.js v5**: vẫn beta (`5.0.0-beta.32`), chỉ được vá bảo mật. Loại.
- **Supabase tự host**: khoảng 10 container, quá nặng so với nhu cầu. Loại.
- **MinIO**: repo archived 2026-04-25, không còn binary/image, AGPL. Loại.
- **Garage**: AGPL, chưa có versioning. Loại.
- **Ceph RGW**: quá nặng cho một VPS.
- **WAL-G**: Apache-2.0, phần lzo là GPL. Giữ làm phương án dự phòng.
- **Barman**: GPL-3.0, cần Python ≥ 3.12. Không chọn.
- **Traefik**: tốt, nhưng cấu hình dài hơn Caddy với một máy chủ.
- **Tự gửi email từ VPS**: tỉ lệ vào spam cao, khách không nhận được phiếu thu. Loại.

## Điều kiện xem lại
Mở ADR mới (thay hoặc bổ sung) khi một trong các điều kiện sau xảy ra; không sửa nội dung quyết định ở trên:
- **Phục hồi:** diễn tập PITR trên hạ tầng thật không đạt RPO DB ≤ 15 phút hoặc RTO ≤ 4 giờ, hoặc không có người trực đáp ứng RTO — xét Postgres managed.
- **Xác thực:** Better Auth có advisory mức High/Critical ở thành phần đang bật mà bản vá chậm, đổi giấy phép khỏi MIT, hoặc ngừng bảo trì — xét Ory Kratos hoặc phương án khác (RK-018 trong `docs/RISKS.md`).
- **Lưu file:** SeaweedFS đổi giấy phép, có lỗ hổng chưa vá, hoặc dung lượng file vượt đĩa VPS — xét Garage/object storage managed trong nước.
- **Sao lưu:** pgBackRest mất người bảo trì lần nữa — chuyển sang WAL-G (đã ghi làm dự phòng).
- **Email:** chọn SMTP relay đặt ngoài Việt Nam — cần hồ sơ chuyển dữ liệu ra nước ngoài (`docs/privacy/processors.md`) và có thể đổi sang relay trong nước.
- **Quy mô hạ tầng:** một VPS không còn đủ (cần chạy nhiều máy hoặc tính sẵn sàng cao) — xét lại compose, mạng nội bộ và sao lưu.

## Thông tin thêm
- Nguồn: `docs/research/2026-10-15-self-host.md` (xác minh 2026-10-15).
