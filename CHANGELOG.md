# Changelog

Mọi thay đổi đáng chú ý của sản phẩm được ghi ở đây. Định dạng theo [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
phiên bản theo [SemVer](https://semver.org/lang/vi/). Chưa có bản phát hành; nguồn phiên bản duy nhất là `version` trong `package.json`.

## [Unreleased]

### Added
- Đợt 1 — nền: pnpm workspace (`apps/web`, `apps/worker`, `packages/*`), schema biến môi trường, `packages/db` (Kysely, migration,
  vai trò + RLS theo tổ chức), đăng nhập + MFA (Better Auth), `authorize()`, command pipeline (idempotency, audit, outbox),
  tồn phòng chống chồng bằng `EXCLUDE` (100 lệnh tranh một phòng → 1 allocation), lõi sổ tiền (sổ phụ bất biến, phân bổ, cọc),
  file riêng tư (URL ký ≤ 5 phút), diễn tập sao lưu/khôi phục PITR (pgBackRest), design system tối thiểu, E2E PWA xương sống.
- Đợt 2 — thuê trọ: duyệt + hạn mức, ca quầy, thanh toán, cọc và số dư khách, QR + đối soát, chốt kỳ sổ, hợp đồng (soạn/ký/phụ lục/
  bàn giao/thanh lý), dịch vụ + công tơ, engine tính tiền thuần, vòng đời kỳ thu, import Excel/CSV có xem trước, khôi phục MFA, UI trọ.
- Đợt 3 — khách sạn và vận hành: đặt phòng → giữ chỗ → nhận/trả phòng → folio; buồng phòng, phiếu sự cố có ảnh đã quét mã độc;
  thông báo trong app + email qua outbox (nhắc quá hạn/hết hạn/lưu trú, tuỳ chọn, huỷ đăng ký); portal người thuê (đăng nhập OTP
  email, xem kỳ thu/hợp đồng/công tơ, "Tôi đã chuyển") và liên kết khách; nhật ký audit, màn "Hôm nay", báo cáo công nợ/thu tiền/cọc/
  công suất, xuất dữ liệu qua job; `/api/metrics`, `/api/ready`, `docs/RUNBOOK.md`; UI khách sạn + E2E R-003.
- Đợt 4 (đang thực hiện, `docs/autopilot/PLAN.md`) — đóng mục blueprint làm được trong repo: README, `.editorconfig`,
  `.gitattributes`, `.nvmrc`, mẫu PR sản phẩm, threat model cập nhật, quy trình sự cố/runbook/SLO + rule cảnh báo Prometheus,
  sổ dữ liệu cá nhân (`docs/privacy/`) và sổ rủi ro; test kiểm link tài liệu và tài liệu vận hành.

### Changed
- Đợt 3: sửa theo các vòng review độc lập (công nợ tính từ sổ phụ gồm điều chỉnh giảm, job xuất không kẹt, claim thông báo chia đều
  theo tổ chức, phụ lục hợp đồng không thời hạn không tính trùng kỳ).

### Security
- Khoá mã hoá số giấy tờ AES-256-GCM tầng ứng dụng + blind index; quét file bằng clamd (không coi file là sạch khi chưa quét);
  RLS chặn người thuê đọc sổ cái/audit/dữ liệu người khác; `/api/metrics` dùng Bearer token dẫn xuất từ bí mật phiên.
