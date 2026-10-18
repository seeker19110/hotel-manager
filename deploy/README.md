# deploy/ — hạ tầng tự host cho VPS

> Chưa triển khai: mua VPS/tên miền/SMTP và nạp bí mật là điểm dừng cần chủ dự án duyệt (AGENTS §6). Quy trình: [`docs/ops/runbooks/deploy-rollback.md`](../docs/ops/runbooks/deploy-rollback.md).

| Tệp | Nội dung |
|---|---|
| `compose.yaml` | `postgres` (+ pgBackRest), `seaweedfs`, `caddy`, `web`, `worker`; image ngoài ghim digest, `web`/`worker` build từ hai Dockerfile bên dưới; `stop_grace_period: 40s`, log xoay vòng ([`docs/ops/retention-policy.md`](../docs/ops/retention-policy.md)). **Chưa chạy thật** |
| `web.Dockerfile`, `worker.Dockerfile` | image ứng dụng (multi-stage, base Node ghim digest, chạy bằng người dùng `node`, không bí mật trong image). **Chưa build thật** (máy dev không có Docker) |
| `postgres/Dockerfile` | Postgres 17 + pgBackRest |
| `Caddyfile` | TLS tự động, HSTS, chuyển tiếp tới `web:3000` và kho file |
| `s3.json.example`, `pgbackrest.conf.example` | mẫu bí mật; bản thật ở `deploy/secrets/` (bị `.gitignore`) |
| `prometheus/alerts.yml`, `prometheus/alerts.test.yml` | rule cảnh báo (xem [`docs/ops/SLO.md`](../docs/ops/SLO.md)) và test của chúng (`promtool test rules`, CI job `prometheus-rules`) |
| `otel/collector.yaml` | OTel Collector (bản contrib): đọc file log JSON của container, gắn Resource `service.name`/`service.version`/`deployment.environment`, giữ cả dòng không parse được (nhãn `unparsed`). Kiểm: `otelcol-contrib validate` + `node scripts/otel-collector-e2e.mjs` (CI job `otel-collector`). Chưa có service Collector trong compose — chạy cùng máy chủ khi chọn nơi lưu log lâu dài |

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

## Biến môi trường của web và worker (T-505)
Compose chỉ ghi thẳng biến không bí mật (`NODE_ENV`, `APP_BASE_URL`, `S3_ENDPOINT`, `S3_BUCKET`, lấy từ `HM_DOMAIN`/`HM_FILES_DOMAIN` của `deploy/.env`). Bí mật nằm ở hai file riêng, ngoài git, mỗi service một file để khoá/vai trò không dùng chung. Tên biến theo schema `packages/app/src/config/schema.ts` và `worker.ts` — không có biến mới.

| File | Biến |
|---|---|
| `deploy/secrets/web.env` | `DATABASE_URL` (`app_runtime`), `BETTER_AUTH_SECRET`, `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (danh tính `hotel-manager-web`), `HM_PII_KEYS`, `HM_PII_KEY_ID`, `HM_PII_INDEX_KEY`, `CLAMD_HOST` (+ `CLAMD_PORT`), `SMTP_URL`, `SIM_WEBHOOK_SECRET` (nếu bật webhook mô phỏng) |
| `deploy/secrets/worker.env` | `WORKER_DATABASE_URL` (`app_worker`), `DATABASE_URL` (`app_runtime`, job xuất dữ liệu), `BETTER_AUTH_SECRET`, `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (danh tính `hotel-manager-worker`, **khác web**), `HM_PII_KEYS`, `HM_PII_KEY_ID`, `HM_PII_INDEX_KEY`, `CLAMD_HOST` (+ `CLAMD_PORT`), `SMTP_URL` |

Ghi chú: `web` có healthcheck `/api/ready`; `worker` không có cổng nên sức khoẻ = nhịp `worker_heartbeats`. Production không chấp nhận `http://` tới máy khác nên cả hai gọi kho file qua `https://${HM_FILES_DOMAIN}` (Caddy có bí danh mạng cho hai tên miền, chưa kiểm bằng triển khai thật). Chưa có service ClamAV trong compose (`CLAMD_HOST` trỏ tới máy chủ clamd do chủ dự án cài — `docs/privacy/processors.md`).
