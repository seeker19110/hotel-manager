---
title: Tài khoản và dịch vụ cần bàn giao
kind: handover
updated: 2026-10-16
status: khung — hầu hết dịch vụ chưa có; điền khi chủ dự án mua/chọn
---

# Tài khoản và dịch vụ cần bàn giao

> PM-HANDOVER-002 (một phần của PM-HANDOVER-004/009). **Không ghi bí mật** (mật khẩu, khoá, token, chuỗi kết nối) ở đây; chỉ ghi tên dịch vụ, chủ tài khoản (vai trò), nơi lưu bí mật (tên mục trong kho bí mật) và ngày. Bí mật nạp qua môi trường theo [`deploy/README.md`](../../deploy/README.md) và xoay theo [`secret-leak.md`](../ops/runbooks/secret-leak.md).
> Dự án chưa có môi trường production; mua VPS, tên miền, SMTP và đăng ký dịch vụ trả phí là điểm dừng cần chủ dự án (AGENTS §6). Cột "Trạng thái" phản ánh hiện trạng ngày 2026-10-16.
> Chủ dự án chưa gán Product Owner, Tech Lead, vận hành (`PROJECT.md` §9): cột "Chủ" ghi vai trò, điền tên người khi gán.

| Dịch vụ / tài khoản | Dùng để | Chủ (vai trò) | Trạng thái | Ngày chuyển giao | Ngày xoay/gia hạn gần nhất | Bí mật lưu ở (tên mục) |
|---|---|---|---|---|---|---|
| Kho mã nguồn GitHub (repo, ruleset, Actions) | mã, CI, review | chủ dự án | đang dùng; ruleset `.github/rulesets/main.json` chưa import (cần chủ dự án) | (chưa) | (chưa) | tài khoản cá nhân + 2FA của chủ repo; `GITHUB_TOKEN` tự cấp mỗi lượt chạy |
| VPS tại Việt Nam | chạy compose: web, worker, Postgres, SeaweedFS, clamd, Caddy | vận hành | **chưa có** | (chưa) | (chưa) | khoá SSH, tài khoản nhà cung cấp: (chưa có kho bí mật) |
| Tên miền (`HM_DOMAIN`, `HM_FILES_DOMAIN`) | địa chỉ web và URL ký file | chủ dự án | **chưa mua** | (chưa) | hạn gia hạn: (chưa) | tài khoản nhà đăng ký tên miền |
| Chứng chỉ TLS (Let's Encrypt qua Caddy, `HM_ACME_EMAIL`) | HTTPS | vận hành | chờ có tên miền | (chưa) | tự gia hạn (Caddy) | email liên hệ ACME |
| SMTP relay | email giao dịch, OTP người thuê | vận hành | **chưa chọn** (dev/CI dùng `FakeEmailSender`) | (chưa) | (chưa) | `SMTP_URL` |
| Kho sao lưu CSDL (S3/SFTP khác máy, pgBackRest) | sao lưu + WAL, PITR | vận hành | **chưa chọn** | (chưa) | (chưa) | `deploy/secrets/pgbackrest.conf`, `PGBACKREST_REPO_CIPHER_PASS` (mất khoá = mất bản sao lưu) |
| Kho sao lưu file (rclone, khác máy) | bản sao bucket `hm-files` | vận hành | **chưa chọn**; mã hoá phía client chưa quyết | (chưa) | (chưa) | cấu hình rclone (chưa có) |
| Danh tính S3 `hotel-manager-web`, `hotel-manager-worker` | kho file riêng tư của từng service | vận hành | mẫu ở `deploy/s3.json.example`, chưa cấp | (chưa) | (chưa) | `deploy/secrets/s3.json`, `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` mỗi service |
| Vai trò CSDL `app_runtime`, `app_worker` | web, worker kết nối Postgres | vận hành | tạo bằng `packages/db/sql/bootstrap-roles.sql` khi dựng cluster | (chưa) | (chưa) | `DATABASE_URL`, `WORKER_DATABASE_URL` |
| Khoá ứng dụng | phiên, mã hoá giấy tờ | Tech Lead | chưa tạo cho production | (chưa) | (chưa) | `BETTER_AUTH_SECRET`, `HM_PII_KEYS`, `HM_PII_KEY_ID`, `HM_PII_INDEX_KEY` |
| Kênh nhận cảnh báo (email/chat) cho Prometheus | báo sự cố | vận hành | **chưa chọn**, Prometheus chưa dựng | (chưa) | (chưa) | (chưa có) |
| Kho bí mật (secret manager) | giữ mọi mục "bí mật lưu ở" | chủ dự án | **chưa có** | (chưa) | (chưa) | — |
| Pháp lý / DPIA / DPA | dữ liệu cá nhân, thông báo vi phạm | pháp lý | chưa có người; DPIA chưa soạn (`docs/DPIA.md`) | (chưa) | (chưa) | — |

## Khi bàn giao
1. Mỗi dòng đổi trạng thái sang "đã chuyển" kèm ngày và tên người nhận; xác nhận người nhận đăng nhập được và bật 2FA.
2. Xoay mọi bí mật mà người cũ biết ([`secret-leak.md`](../ops/runbooks/secret-leak.md)); thu hồi khoá SSH và quyền GitHub của người rời.
3. Đối chiếu với [`docs/privacy/processors.md`](../privacy/processors.md) (bên xử lý dữ liệu) và [`docs/RISKS.md`](../RISKS.md) (RK-013…RK-015).
4. Còn thiếu so với gói bàn giao `PM-HANDOVER-002`: `RUNBOOK.md` ở gốc repo (hiện ở `docs/RUNBOOK.md`); mẫu checklist rời dự án (PM-HANDOVER-005) và lịch gia hạn (PM-HANDOVER-009) chờ có dịch vụ thật.
