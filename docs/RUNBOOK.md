# RUNBOOK — Hotel Manager (vận hành)

> PLAN đợt 3 T-225. Tài liệu cho người trực vận hành. Mọi lệnh trong file này **chỉ dùng dữ liệu giả** khi diễn tập; trên dữ liệu thật phải theo điểm dừng của AGENTS §6 (người duyệt trước thao tác không đảo ngược).
> Chưa có môi trường production: các mục "Khi chạy thật" là đề xuất, chờ chủ dự án quyết (xem `docs/autopilot/DECISIONS.md`, D-021).

## 1. Bản đồ nhanh

| Thành phần | Kiểm | Bình thường |
|---|---|---|
| Web (Next.js) | `GET /api/health` | `200 {"status":"ok"}` — tiến trình còn sống |
| Web + phụ thuộc | `GET /api/ready` | `200 {"status":"ready","checks":{"database":"ok","storage":"ok","scanner":"ok"}}`; thiếu ⇒ `503` kèm thành phần `fail`/`timeout` (không có chi tiết lỗi) |
| Số liệu | `GET /api/metrics` + `Authorization: Bearer <token>` | Prometheus text 0.0.4 |
| Worker | metric `hm_worker_heartbeat_age_seconds{worker=…}` | < 120 giây (worker gọi `workerHeartbeat` mỗi vòng — lập lịch ở bước triển khai) |
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

| Metric | Cảnh báo | Ý nghĩa |
|---|---|---|
| `hm_outbox_oldest_unpublished_age_seconds` | > 300 trong 5 phút | Relay outbox đứng — thông báo/xuất/đối soát không chạy |
| `hm_outbox_failing` | > 0 trong 15 phút | Có sự kiện phát lỗi lặp lại |
| `increase(notification_dead_total[1h])` | > 0 | Email hết lượt thử (nhà cung cấp lỗi kéo dài hoặc địa chỉ sai hàng loạt) |
| `hm_jobs_failed` | tăng | Job pg-boss lỗi (xem dead letter §6) |
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
3. Không sửa tay hàng outbox; sửa nguyên nhân rồi để relay phát lại (idempotent: consumer dedupe).

### 3.4 Email `dead` tăng
1. `select last_error_code, count(*) from notification_deliveries where status = 'dead' group by 1;`
2. `PROVIDER_TEMPORARY` hàng loạt ⇒ nhà cung cấp SMTP lỗi; khi đã ổn: owner/manager bấm "Gửi lại" trong lịch sử gửi (`notifications.retryDelivery` — dead/failed → queued, có audit). Không đổi trạng thái bằng SQL.
3. `RECIPIENT_INVALID` ⇒ địa chỉ sai — sửa email người nhận rồi gửi lại.

### 3.5 Xuất dữ liệu lỗi
`select id, kind, failed_reason from export_jobs where status = 'failed' order by created_at desc limit 20;` — `FORBIDDEN` = người yêu cầu bị thu hồi quyền trước khi chạy (đúng thiết kế); `TOO_LARGE` = vượt 100.000 dòng/bảng — thu hẹp khoảng; `INVALID` = bộ lọc sai. Người dùng tạo yêu cầu mới (không chạy lại job cũ).

## 4. Sao lưu và khôi phục
- Diễn tập PITR (dữ liệu giả, cluster tạm): `bash scripts/db-backup-restore-check.sh` — exit 0 = khôi phục đúng (so số dòng, Σ Nợ/Có, số policy RLS).
- Khi chạy thật (chờ quyết — PROGRESS "Chờ người"): pgBackRest repo mã hoá ở **máy khác**, giữ khoá `PGBACKREST_REPO_CIPHER_PASS` ngoài máy chủ; diễn tập khôi phục định kỳ.
- Khôi phục thật là thao tác không đảo ngược trên dữ liệu thật ⇒ người duyệt trước (AGENTS §6); khôi phục vào cluster mới, kiểm rồi mới chuyển ứng dụng sang.

## 5. Xoay khoá mã hoá giấy tờ (PII, D-004)
1. Sinh khoá mới 32 byte: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Thêm vào `HM_PII_KEYS` (giữ khoá cũ): `1:<cũ>,2:<mới>`; đặt `HM_PII_KEY_ID=2`; khởi động lại web + worker. Dữ liệu cũ vẫn đọc được (mỗi bản mã mang `key_id`).
3. Mã hoá lại dần sang khoá mới: `reencryptIdentityDocuments` (packages/app/src/identity/identity.ts) theo từng tổ chức — chạy như job vận hành, có audit.
4. Khi không còn bản mã dùng khoá cũ (`keyIdOf`), bỏ khoá cũ khỏi `HM_PII_KEYS`.
5. **Không** xoay `HM_PII_INDEX_KEY` cùng lúc (đổi khoá blind index = tính lại toàn bộ index tìm kiếm).
- Lộ khoá: coi dữ liệu giấy tờ đã lộ ⇒ quy trình sự cố dữ liệu cá nhân (pháp lý — chờ đối chiếu văn bản gốc, PROGRESS).

## 6. Dead letter (pg-boss)
- Job hết lượt thử (mặc định 5 lần, backoff) chuyển sang queue `outbox.dead_letter`.
- Xem: `select name, data, output, completed_on from pgboss.job where name = 'outbox.dead_letter' order by created_on desc limit 20;`
- Xử lý: sửa nguyên nhân (dữ liệu/cấu hình), rồi phát lại bằng cách gửi lại job vào queue gốc với cùng `data` (consumer idempotent theo dedupe). Ghi lại thao tác vào nhật ký vận hành.

## 7. Hạn giữ dữ liệu
- Job `runRetention` (worker, hằng ngày): xoá object file hết hạn (`files.delete_after`) rồi đánh dấu `deleted`; làm rỗng `import_rows.raw/data` 30 ngày sau commit/huỷ lô nhập.
- Job `expireExports` (5 phút): bản xuất quá 15 phút ⇒ `expired`.
- Lỗi xoá object ⇒ log `retention.file_delete_failed`, lượt sau thử lại (không đánh dấu `deleted` khi chưa xoá được).
