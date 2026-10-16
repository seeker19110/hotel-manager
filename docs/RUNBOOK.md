# RUNBOOK — Hotel Manager (vận hành)

> PLAN đợt 3 T-225. Tài liệu cho người trực vận hành. Mọi lệnh trong file này **chỉ dùng dữ liệu giả** khi diễn tập; trên dữ liệu thật phải theo điểm dừng của AGENTS §6 (người duyệt trước thao tác không đảo ngược).
> Chưa có môi trường production: các mục "Khi chạy thật" là đề xuất, chờ chủ dự án quyết (xem `docs/autopilot/DECISIONS.md`, D-021).
> Sự cố nghiêm trọng, thông báo vi phạm, lộ bí mật, khôi phục, deploy/rollback, SLO: xem **§8 Tài liệu vận hành liên quan** (T-308).

## 1. Bản đồ nhanh

| Thành phần | Kiểm | Bình thường |
|---|---|---|
| Web (Next.js) | `GET /api/health` | `200 {"status":"ok"}` — tiến trình còn sống |
| Web + phụ thuộc | `GET /api/ready` | `200 {"status":"ready","checks":{"database":"ok","storage":"ok","scanner":"ok"}}`; thiếu ⇒ `503` kèm thành phần `fail`/`timeout` (không có chi tiết lỗi) |
| Số liệu | `GET /api/metrics` + `Authorization: Bearer <token>` | Prometheus text 0.0.4 |
| Worker | metric `hm_worker_heartbeat_age_seconds{worker=…}` | < 120 giây (worker ghi nhịp mỗi 30 giây, tên `worker`; §8) |
| CSDL | Postgres 17, `max_connections=100`, pool ≤ 20/tiến trình | — |
| Kho file | SeaweedFS (S3), bucket riêng tư, URL ký ≤ 5 phút | — |
| Quét mã độc | clamd (ClamAV) nội bộ; dev/CI dùng bản giả EICAR | — |

### Lấy token đọc metrics
Token dẫn xuất (HKDF-SHA256, nhãn `hm-metrics-v1`) từ `BETTER_AUTH_SECRET` — không có bí mật riêng; đổi bí mật phiên ⇒ đổi token (cập nhật cấu hình Prometheus cùng lúc).

```bash
# Trên máy có biến môi trường của ứng dụng (không dán bí mật vào dòng lệnh):
node scripts/metrics-token.mjs
```

Khi chạy thật (đề xuất D-021): chặn thêm `/api/metrics` ở reverse proxy (chỉ IP mạng nội bộ của Prometheus), không public.

## 2. Ngưỡng cảnh báo đề xuất
Đã thành rule Prometheus (có `severity`, `owner`, `runbook_url`) ở [`deploy/prometheus/alerts.yml`](../deploy/prometheus/alerts.yml); bảng dưới giữ ý nghĩa từng chỉ số.


| Metric | Cảnh báo | Ý nghĩa |
|---|---|---|
| `hm_outbox_oldest_unpublished_age_seconds` | > 300 trong 5 phút | Relay outbox đứng — thông báo/xuất/đối soát không chạy |
| `hm_outbox_failing` | > 0 trong 15 phút | Có sự kiện phát lỗi lặp lại |
| `increase(notification_dead_total[1h])` | > 0 | Email hết lượt thử (nhà cung cấp lỗi kéo dài hoặc địa chỉ sai hàng loạt) |
| `hm_jobs_failed` | tăng | Job pg-boss lỗi (xem dead letter §6) |
| `hm_dead_letter_jobs` | > 0 trong 10 phút | Job nằm trong dead letter chờ người xử lý/redrive (§6) |
| `hm_export_jobs{status="failed"}` | tăng | Xuất dữ liệu lỗi (xem `export_jobs.failed_reason`) |
| `hm_worker_heartbeat_age_seconds` | > 120 | Worker treo/chết |
| `hm_holds_active` | tăng bất thường | Job nhả hold không chạy |
| `/api/ready` | 503 > 2 phút | Phụ thuộc hỏng (CSDL/kho/máy quét) |

## 3. Sự cố thường gặp

### 3.1 Web trả 5xx / `/api/ready` 503
1. Xem `checks`: `database` → §3.2; `storage` → kiểm SeaweedFS (`weed` còn chạy, đĩa đầy?), bucket tồn tại; `scanner` → clamd (`systemctl status clamav-daemon`, cập nhật chữ ký `freshclam`). Máy quét hỏng ⇒ tải file trả 503 (thiết kế: không bao giờ coi file là sạch khi chưa quét — D-003).
2. Log JSON có `correlation_id` — tra theo id người dùng báo (header `X-Correlation-Id`).

### 3.2 CSDL đầy kết nối / chậm
- `select count(*), usename, state from pg_stat_activity group by 2,3;` — mỗi tiến trình ≤ 20 kết nối; tổng không vượt `max_connections`.
- Truy vấn treo: `select pid, now()-query_start, left(query,120) from pg_stat_activity where state <> 'idle' order by 2 desc;` — huỷ bằng `pg_cancel_backend(pid)` (không `terminate` khi chưa rõ).

### 3.3 Outbox đứng (`hm_outbox_oldest_unpublished_age_seconds` tăng)
1. Worker còn nhịp không (`hm_worker_heartbeat_age_seconds`)? Không ⇒ khởi động lại worker.
2. Còn nhịp mà vẫn đứng: `select event_type, attempts, last_error from outbox where published_at is null order by created_at limit 20;` — `last_error` cho biết lỗi phát (pg-boss/kết nối).
3. `last_error = 'no_consumer'`: worker đang chạy chưa có consumer cho event_type đó (triển khai lệch phiên bản hoặc quên thêm consumer) — xem §8.
4. Không sửa tay hàng outbox; sửa nguyên nhân rồi để relay phát lại (idempotent: consumer dedupe). Hàng lỗi được lùi lần thử (`available_at`) nên có thể chờ tới 5 phút.

### 3.4 Email `dead` tăng
1. `select last_error_code, count(*) from notification_deliveries where status = 'dead' group by 1;`
2. `PROVIDER_TEMPORARY` hàng loạt ⇒ nhà cung cấp SMTP lỗi; khi đã ổn: owner/manager bấm "Gửi lại" trong lịch sử gửi (`notifications.retryDelivery` — dead/failed → queued, có audit). Không đổi trạng thái bằng SQL.
3. `RECIPIENT_INVALID` ⇒ địa chỉ sai — sửa email người nhận rồi gửi lại.

### 3.5 Xuất dữ liệu lỗi
`select id, kind, failed_reason from export_jobs where status = 'failed' order by created_at desc limit 20;` — `FORBIDDEN` = người yêu cầu bị thu hồi quyền trước khi chạy (đúng thiết kế); `TOO_LARGE` = vượt 100.000 dòng/bảng — thu hẹp khoảng; `INVALID` = bộ lọc sai. Người dùng tạo yêu cầu mới (không chạy lại job cũ).

### 3.6 Người dùng báo 429 (giới hạn tần suất)
- Mọi 429 có header `Retry-After` (giây). Nguồn: hạn mức lệnh theo tổ chức (`COMMAND_QUOTA_PER_MINUTE` = 600 lệnh mới/phút, `packages/app/src/pipeline/command.ts`; tổ chức chạy script/vòng lặp lỗi sẽ chạm), xuất dữ liệu 10 lần/giờ/người, link khách 10 lần sai/phút/IP, đăng nhập theo IP và khoá tài khoản (Better Auth). Sự kiện bảo mật `rate_limit.exceeded` ghi tổ chức/lệnh (không kèm nội dung).
- Đếm lệnh: `select count(*) from idempotency_keys where organization_id = '<org>' and created_at > now() - interval '60 seconds';`. Hạn mức cố định theo mã, chưa theo gói; muốn nâng cho một tổ chức cần đổi mã (chưa có cấu hình theo gói — F-015).

### 3.7 Kho object (S3) chậm hoặc lỗi
- Mỗi thao tác kho (`packages/app/src/files/storage.ts`): mỗi lần gọi tối đa 15 giây, thử lại ≤ 3 lần (lùi mũ + jitter, theo `Retry-After`) CHỈ với GET/HEAD/PUT/DELETE; POST không bao giờ thử lại. Cả thao tác (mọi lần thử + thời gian chờ) có trần tổng 30 giây ⇒ lỗi `quá tổng thời gian 30000 ms` (`StorageError.retryable`). `/api/ready` không thử lại, trần 3 giây.

## 4. Sao lưu và khôi phục
- Diễn tập PITR (dữ liệu giả, cluster tạm): `bash scripts/db-backup-restore-check.sh` — exit 0 = khôi phục đúng (so số dòng, Σ Nợ/Có, số policy RLS).
- Khi chạy thật (chờ quyết — PROGRESS "Chờ người"): pgBackRest repo mã hoá ở **máy khác**, giữ khoá `PGBACKREST_REPO_CIPHER_PASS` ngoài máy chủ; diễn tập khôi phục định kỳ.
- Lệnh khôi phục đầy đủ (pgBackRest PITR, kho file, dựng lại hạ tầng): [`docs/ops/runbooks/restore.md`](ops/runbooks/restore.md).
- Khôi phục thật là thao tác không đảo ngược trên dữ liệu thật ⇒ người duyệt trước (AGENTS §6); khôi phục vào cluster mới, kiểm rồi mới chuyển ứng dụng sang.

## 5. Xoay khoá mã hoá giấy tờ (PII, D-004)
1. Sinh khoá mới 32 byte: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Thêm vào `HM_PII_KEYS` (giữ khoá cũ): `1:<cũ>,2:<mới>`; đặt `HM_PII_KEY_ID=2`; khởi động lại web + worker. Dữ liệu cũ vẫn đọc được (mỗi bản mã mang `key_id`).
3. Mã hoá lại dần sang khoá mới: `reencryptIdentityDocuments` (packages/app/src/identity/identity.ts) theo từng tổ chức — chạy như job vận hành, có audit.
4. Khi không còn bản mã dùng khoá cũ (`keyIdOf`), bỏ khoá cũ khỏi `HM_PII_KEYS`.
5. **Không** xoay `HM_PII_INDEX_KEY` cùng lúc (đổi khoá blind index = tính lại toàn bộ index tìm kiếm).
- Lộ khoá: coi dữ liệu giấy tờ đã lộ ⇒ quy trình sự cố dữ liệu cá nhân ([`data-breach.md`](ops/runbooks/data-breach.md); pháp lý — chờ đối chiếu văn bản gốc, PROGRESS). Xoay mọi loại bí mật: [`secret-leak.md`](ops/runbooks/secret-leak.md).

## 6. Dead letter (pg-boss)
- Job vào queue `outbox.dead_letter` theo hai đường: (a) hết lượt thử (mặc định 5 lần, backoff mũ có jitter, trần 5 phút giữa hai lần); (b) **lỗi vĩnh viễn** (T-401, BE-JOB-003) — payload sai schema zod theo event_type (`packages/app/src/outbox/payloads.ts`) hoặc lỗi nghiệp vụ `CommandError` mã 4xx (trừ 408/429) — vào thẳng dead letter, KHÔNG retry; job gốc được hoàn tất và log `job.permanent_failure {event_type, outbox_id, reason}`. Dữ liệu dead letter là bản sao payload gốc kèm `dead_letter: {kind, message}` ở lượt (b).
- Giữ 30 ngày (dài hơn queue gốc 14 ngày). Số job còn trong dead letter = gauge `hm_dead_letter_jobs`; cảnh báo `HmDeadLetterJobs` (> 0 trong 10 phút).
- Xem: `select id, state, data, output, created_on from pgboss.job where name = 'outbox.dead_letter' and state in ('created','retry','active','failed') order by created_on desc limit 20;`
- Xử lý (redrive): sửa nguyên nhân (dữ liệu/cấu hình/mã), rồi gửi lại job vào queue gốc với cùng `data` (bỏ khoá `dead_letter`; consumer idempotent theo `outbox_id`), sau đó đóng job dead letter đã xử lý: `update pgboss.job set state = 'completed', completed_on = now() where name = 'outbox.dead_letter' and id = '<id>';` (chạy bằng vai trò owner của schema `pgboss`). Lỗi vĩnh viễn do payload sai thì sửa nguồn phát sự kiện, không redrive nguyên văn. Ghi lại thao tác vào nhật ký vận hành.

## 7. Hạn giữ dữ liệu
- Job `runRetention` (worker, hằng ngày): xoá object file hết hạn (`files.delete_after`) rồi đánh dấu `deleted`; làm rỗng `import_rows.raw/data` 30 ngày sau commit/huỷ lô nhập.
- Job `expireExports` (5 phút): bản xuất quá 15 phút ⇒ `expired`.
- Lỗi xoá object ⇒ log `retention.file_delete_failed`, lượt sau thử lại (không đánh dấu `deleted` khi chưa xoá được).
- Object mồ côi (T-303, D-025): tải lên, tải lô nhập, xuất thông báo lưu trú và bản xuất ghi object NGOÀI transaction lệnh qua dòng `files` ở `pending_scan` (`delete_after` = hôm nay + 2 ngày, giờ VN). Lệnh lỗi hoặc tiến trình sập giữa ghi object và chốt `ready` để lại object + dòng `pending_scan`; `runRetention` xoá object rồi đánh dấu `deleted` khi tới hạn (cùng đường với file `ready` hết hạn). Xem: `select id, owner_type, storage_key, delete_after from files where status = 'pending_scan' and delete_after < current_date;` — dòng tồn lâu hơn 2 ngày nghĩa là job hạn giữ không chạy (xem §8).

## 8. Worker (apps/worker) — khởi chạy, lịch, dừng
- Chạy: `node apps/worker/src/index.ts` (Node 24). Biến: toàn bộ schema web (`DATABASE_URL` = vai trò `app_runtime`, dùng cho job xuất dữ liệu) **cộng `WORKER_DATABASE_URL`** = vai trò `app_worker` (relay outbox, job nền, pg-boss). Thiếu/sai biến ⇒ thoát mã 1, stderr nêu tên biến (không giá trị). Web cũng validate lúc khởi động (`apps/web/instrumentation.ts`).
- Schema `pgboss` do migration 0047 tạo sẵn, thuộc `app_worker` (D-024); worker chạy pg-boss với `createSchema: false` nên vai trò worker KHÔNG cần `CREATE` trên CSDL — bảng của pg-boss tự dựng bên trong schema đó lần đầu. Migration down chỉ xoá được schema rỗng (còn bảng ⇒ lỗi có chủ đích; dừng worker và quyết định có bỏ hàng đợi hay không).
- Lịch (vòng lặp trong tiến trình, mỗi job không chồng lượt, lỗi chỉ ghi log `job.failed`): relay outbox 2 giây · nhịp 30 giây · gửi email đến hạn 15 giây (bỏ nếu `SMTP_URL` là `smtp(s)://` — chưa có adapter, log `email.sender_unavailable`) · nhả hold 1 phút · nhắc 15 phút · tạo kỳ thu, hợp đồng (nhắc hết hạn, quá hạn ở) 1 giờ · hết hạn bản xuất 5 phút · hạn giữ import/file 24 giờ (lượt đầu sau 60 giây). Nhiều worker chạy song song an toàn (SKIP LOCKED, khoá dedupe).
- Relay outbox (T-401, ARC-INT-003/DB-TX-003): claim NGẮN → commit → `boss.send` → đánh dấu. `app.outbox_claim` đặt lease 60 giây (`available_at = now() + 60 s`) cho hàng lấy được rồi commit ngay; `boss.send` chạy NGOÀI transaction với job id = `outbox.id` (khoá chính `(name, id)` của pg-boss ⇒ gửi lại không tạo job thứ hai); `app.outbox_mark` đánh dấu đã phát hoặc lùi lần thử khi lỗi. Worker sập giữa gửi và đánh dấu ⇒ hết lease hàng được claim lại, gửi trùng là no-op ⇒ không mất, không trùng. Log `outbox.mark_failed` = không đánh dấu được (CSDL chập chờn), tự khỏi sau lease.
- Sự kiện outbox chưa có consumer (D-026, sửa theo review lát 7): chỉ loại khai tường minh "chỉ để audit" (`AUDIT_ONLY_EVENT_TYPES` ở `apps/worker/src/relay.ts`) được đánh dấu đã phát mà không sinh job. Loại KHÁC không có consumer ở worker này thì KHÔNG đánh dấu đã phát: `last_error = 'no_consumer'`, `attempts` tăng, `available_at` lùi (5 s · 2^lần, trần 5 phút) để không kẹt đầu hàng, log WARN `outbox.no_consumer {event_type, outbox_id}`. Worker có consumer (hoặc bản triển khai sau thêm consumer) nhận được sau khi hết thời gian lùi — không mất sự kiện khi triển khai lệch phiên bản. Cảnh báo dùng chỉ số sẵn có: `hm_outbox_unpublished`, `hm_outbox_oldest_unpublished_age_seconds`, `hm_outbox_failing`. Gặp `no_consumer` kéo dài: thêm consumer hoặc (nếu thật sự chỉ để audit) thêm event_type vào danh sách audit-only — test `outbox-event-types.test.ts` chặn quên; hàng cũ sẽ được đánh dấu đã phát ở lượt kế.
- Dừng: SIGTERM/SIGINT ⇒ NGAY LẬP TỨC và song song: ngừng lập lịch (không lượt mới) + pg-boss ngừng lấy job mới; hai bên cùng chờ việc đang chạy tới MỘT hạn chót chung 25 giây → đóng pool pg-boss → đóng pool CSDL → thoát 0. Đồng hồ canh thoát mã 1 sau 35 giây (hạn chót + 10 giây). Tín hiệu lần hai ⇒ thoát ngay (mã 1). Đặt `terminationGracePeriod`/`stop_grace_period` ≥ 40 giây.

## 9. Địa chỉ IP khách sau reverse proxy (X-Forwarded-For)
- Ràng buộc triển khai: **đúng MỘT proxy tin cậy trước ứng dụng** — Caddy (`deploy/Caddyfile`), KHÔNG đặt `trusted_proxies`, KHÔNG có CDN/lớp proxy khác phía trước. Ứng dụng lấy hop **phải nhất** của `X-Forwarded-For` (`forwardedClientIp`, `packages/app/src/logging/security-events.ts` — nơi duy nhất đọc header) cho `source_ip` của log bảo mật (cắt /24 hoặc /48) và cho giới hạn tần suất liên kết khách.
- Căn cứ (tài liệu Caddy `reverse_proxy`, đọc 2026-10-16): Caddy mặc định bỏ qua `X-Forwarded-For` từ client không tin cậy và đặt/nối địa chỉ kết nối thật, nên hop phải nhất là địa chỉ Caddy thấy. Hop đầu là do client tự khai (giả được) nên không dùng.
- Thêm lớp proxy/CDN (hoặc bật `trusted_proxies`) ⇒ hop phải nhất là địa chỉ của lớp đó: mọi khách chung một IP (giới hạn tần suất gộp chung, log sai nguồn). Phải sửa `forwardedClientIp` (đếm số hop tin cậy) và cập nhật mục này TRƯỚC khi đổi hạ tầng.
- Chạy ứng dụng không qua proxy (cổng 3000 lộ ra ngoài) ⇒ client tự đặt được header ⇒ không an toàn; cổng web chỉ mở cho Caddy.

## 10. Tài liệu vận hành liên quan
| Cần làm | Tài liệu |
|---|---|
| Phân mức và xử lý sự cố (SEV1–4, thứ tự, thao tác cần người duyệt) | [`docs/ops/INCIDENT-RESPONSE.md`](ops/INCIDENT-RESPONSE.md) |
| Vi phạm dữ liệu cá nhân (thời hạn thông báo, mẫu) | [`docs/ops/runbooks/data-breach.md`](ops/runbooks/data-breach.md) |
| Lộ bí mật (xoay từng loại) | [`docs/ops/runbooks/secret-leak.md`](ops/runbooks/secret-leak.md) |
| Khôi phục CSDL/file | [`docs/ops/runbooks/restore.md`](ops/runbooks/restore.md) |
| Deploy, backup trước migrate, rollback | [`docs/ops/runbooks/deploy-rollback.md`](ops/runbooks/deploy-rollback.md) |
| Mục tiêu dịch vụ, ngân sách lỗi | [`docs/ops/SLO.md`](ops/SLO.md) |
| Rule cảnh báo | [`deploy/prometheus/alerts.yml`](../deploy/prometheus/alerts.yml) |
| Mô hình đe doạ | [`docs/design/THREAT-MODEL.md`](design/THREAT-MODEL.md) |
