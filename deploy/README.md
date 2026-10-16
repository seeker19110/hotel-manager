# deploy/ — hạ tầng tự host cho VPS

> Chưa triển khai: mua VPS/tên miền/SMTP và nạp bí mật là điểm dừng cần chủ dự án duyệt (AGENTS §6). Quy trình: [`docs/ops/runbooks/deploy-rollback.md`](../docs/ops/runbooks/deploy-rollback.md).

| Tệp | Nội dung |
|---|---|
| `compose.yaml` | `postgres` (+ pgBackRest), `seaweedfs`, `caddy`; mọi image ghim digest. Chưa có service `web`/`worker` |
| `web.Dockerfile`, `worker.Dockerfile` | image ứng dụng (multi-stage, base Node ghim digest, chạy bằng người dùng `node`, không bí mật trong image). **Chưa build thật** (máy dev không có Docker) |
| `postgres/Dockerfile` | Postgres 17 + pgBackRest |
| `Caddyfile` | TLS tự động, HSTS, chuyển tiếp tới `web:3000` và kho file |
| `s3.json.example`, `pgbackrest.conf.example` | mẫu bí mật; bản thật ở `deploy/secrets/` (bị `.gitignore`) |
| `prometheus/alerts.yml` | rule cảnh báo (xem [`docs/ops/SLO.md`](../docs/ops/SLO.md)) |

## Danh tính theo service (BASE-SEC-006, SEC-INFRA-001)
Mỗi service chạy với danh tính riêng, quyền tối thiểu; không dùng chung khoá giữa web và worker. Hai danh tính S3 có cùng tập hành động vì cả hai đều đọc/ghi/xoá object trong bucket file (web: tải lên, URL ký; worker: tệp xuất, dọn file hết hạn) — tách để xoay và thu hồi độc lập, và để nhật ký của SeaweedFS phân biệt được bên thao tác.

| Service | Image | Vai trò CSDL | Biến CSDL | Danh tính S3 (`deploy/secrets/s3.json`) | Hành động S3 |
|---|---|---|---|---|---|
| web | `deploy/web.Dockerfile` | `app_runtime` (không owner, `NOBYPASSRLS`) | `DATABASE_URL` | `hotel-manager-web` | `Read`/`Write`/`List` trên bucket `hm-files` |
| worker | `deploy/worker.Dockerfile` | `app_worker` (không owner, `NOBYPASSRLS`) cho relay/job; `app_runtime` cho job xuất dữ liệu | `WORKER_DATABASE_URL` (+ `DATABASE_URL`) | `hotel-manager-worker` | `Read`/`Write`/`List` trên bucket `hm-files` |
| postgres (sao lưu) | `postgres/Dockerfile` | `postgres` (chỉ trong container, không publish cổng) | — | khoá repo sao lưu riêng (`pgbackrest.conf`), bucket khác máy | ghi repo sao lưu |
| caddy | image ghim digest | — | — | không có | — |

Khi cấp: sinh hai cặp khoá khác nhau, đặt `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` của web và của worker ở môi trường của từng service (schema `packages/app/src/config/schema.ts` giữ nguyên tên biến). Không dùng wildcard `*` ở hành động hay bucket.

## Token và khoá đang dùng, scope
| Thứ | Dùng để | Scope / phạm vi | Xoay |
|---|---|---|---|
| `GITHUB_TOKEN` của workflow | CI | `contents: read` (secret-scan thêm `pull-requests: read`); xem `.github/workflows/*.yml` | tự cấp mỗi lượt chạy |
| `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (web, worker) | file riêng tư | một bucket, `Read`/`Write`/`List` | [`secret-leak.md`](../docs/ops/runbooks/secret-leak.md) |
| `DATABASE_URL`, `WORKER_DATABASE_URL` | kết nối CSDL | vai trò `app_runtime` / `app_worker`, không owner, không `BYPASSRLS` (`packages/db/sql/bootstrap-roles.sql`) | `secret-leak.md` |
| `SMTP_URL` | gửi email | tài khoản relay (chưa chọn nhà cung cấp; hiện `FakeEmailSender`) | `secret-leak.md` |
| `PGBACKREST_REPO_CIPHER_PASS`, khoá repo S3 sao lưu | sao lưu PITR | ghi repo sao lưu khác máy | `secret-leak.md` (không đảo ngược, cần người duyệt) |
| `BETTER_AUTH_SECRET`, `HM_PII_KEYS`, `HM_PII_INDEX_KEY` | phiên, mã hoá giấy tờ | trong ứng dụng, không phải token bên thứ ba | `secret-leak.md`, RUNBOOK §5 |
