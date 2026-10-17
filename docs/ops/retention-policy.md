# Chính sách hạn giữ dữ liệu vận hành (XC-GREEN-007)

> Trạng thái: **đề xuất của kỹ thuật** — hạn giữ dữ liệu cá nhân chốt cùng DPIA và pháp lý ([`docs/privacy/data-map.yaml`](../privacy/data-map.yaml), RK-019).
> Bảng này chỉ nói về dữ liệu **vận hành** (log, bảng sự kiện, hàng đợi, kho file); hạn giữ theo từng cột dữ liệu cá nhân nằm ở data-map.
> Máy kiểm: `scripts/process-docs.test.mjs` («chính sách hạn giữ») giữ bảng khớp hằng số ở `packages/app/src/retention/policy.ts`,
> cấu hình log ở `deploy/compose.yaml` và các hàm dọn của migration 0056; test CSDL: `packages/app/src/retention/retention.db.test.ts`.

## Bảng chính sách

| ID | Dữ liệu | Nơi lưu | Hạn giữ | Cơ chế dọn | Cấu hình / hằng số |
|---|---|---|---|---|---|
| RET-01 | Log container (stdout/stderr, gồm sự kiện bảo mật dạng log) | docker `json-file` của từng container | tối đa 50 MB mỗi container, xoay vòng (theo kích thước, không theo ngày) | docker log driver | `max-size=10m` · `max-file=5` (`x-logging` ở `deploy/compose.yaml`) |
| RET-02 | Outbox đã phát (`outbox.published_at` không null) | Postgres | 90 ngày | job `events.retention` (worker, mỗi giờ) → `app.purge_outbox` | `OUTBOX_PUBLISHED_RETENTION_DAYS=90` |
| RET-03 | Khoá idempotency (`idempotency_keys`) | Postgres | tới `expires_at` (7 ngày sau lúc tạo), xoá ngay khi quá hạn | job `events.retention` → `app.purge_idempotency_keys` | `IDEMPOTENCY_GRACE_DAYS=0` |
| RET-04 | Lần gửi thông báo đã xong (`sent`, `suppressed`) | Postgres | 90 ngày | job `events.retention` → `app.purge_notification_deliveries` | `DELIVERY_DONE_RETENTION_DAYS=90` |
| RET-05 | Lần gửi thông báo `failed`/`dead` (chờ người thử lại) | Postgres | 180 ngày | job `events.retention` → `app.purge_notification_deliveries` | `DELIVERY_FAILED_RETENTION_DAYS=180` |
| RET-06 | Nhật ký kiểm toán (`audit_events`) | Postgres | **không xoá** ở pilot (append-only, SPEC-audit-reporting Q-09); lịch theo DPIA | không có (trigger chặn UPDATE/DELETE/TRUNCATE) | `trg_audit_events_append_only` (migration 0003) |
| RET-07 | Dòng nhập (`import_rows.raw/data`) | Postgres | 30 ngày sau commit/huỷ lô | job `import.retention` (hằng ngày) → `app.purge_import_rows` | `IMPORT_ROW_RETENTION_DAYS=30` |
| RET-08 | Kho file riêng tư (bucket `hm-files`): file nguồn nhập, ảnh, bản xuất, object mồ côi | SeaweedFS | theo `files.delete_after` (file nhập 30 ngày; dòng `pending_scan` mồ côi 2 ngày; bản xuất hết hạn tải 15 phút) | job `import.retention` xoá object rồi đánh dấu `deleted` | `files.delete_after` (lifecycle ở tầng ứng dụng, RUNBOOK §7) |
| RET-09 | Hàng đợi pg-boss: job gốc / dead letter | Postgres (schema `pgboss`) | job gốc 14 ngày; dead letter 30 ngày | pg-boss bảo trì theo `retentionSeconds`/`deleteAfterSeconds` của queue | `DEAD_LETTER_RETENTION_SECONDS` (`apps/worker/src/relay.ts`) |
| RET-10 | Bản sao lưu CSDL (pgBackRest) | kho khác máy (chưa chọn) | 4 bản đầy đủ gần nhất; WAL kèm theo | pgBackRest `expire` | `repo1-retention-full=4` (`deploy/pgbackrest.conf.example`) |

## Điều chưa có (ghi rõ, không giả vờ đã làm)
- **Lifecycle phía SeaweedFS** (rule hết hạn object theo tuổi ở bucket): chưa dùng và **chưa xác minh** cấu hình có hỗ trợ trong phiên bản đang ghim. Hiện lifecycle nằm ở ứng dụng (RET-08). Object lọt khỏi `files` (mất dòng CSDL) sẽ không bị dọn tự động — đối chiếu bằng quy trình khôi phục (`docs/ops/runbooks/restore.md`).
- **Bảng chưa có job dọn:** `notifications` (thông báo trong ứng dụng), `inbox` (sổ phụ ngân hàng thô, tiền — có thể phải giữ theo luật kế toán, chưa xác minh), `worker_heartbeats` (rất nhỏ), phiên đăng nhập/liên kết khách hết hạn. Chốt hạn cùng DPIA rồi mới viết job (RK-019).
- **Kho log tập trung:** chưa có; sự kiện bảo mật chỉ ở log container (RET-01) tới khi có kho log thật. Nhật ký cần giữ lâu và truy vết theo người/tổ chức đi qua `audit_events` (RET-06).
- Dữ liệu đã xoá vẫn còn trong bản sao lưu tới hết RET-10 (chấp nhận — THREAT-MODEL TM-22).

## Quy tắc của job dọn (migration 0056)
- Worker (`app_worker`) không có DELETE trực tiếp; mỗi bảng có một hàm `SECURITY DEFINER` phạm vi hẹp, chỉ `app_worker` gọi.
- Xoá theo **lô** (`PURGE_BATCH=1000`, tối đa `PURGE_MAX_ROUNDS=20` lô mỗi bảng mỗi lượt, `SKIP LOCKED`); tồn đọng lớn được dọn dần qua các lượt.
- So sánh nghiêm ngặt: hàng **đúng** mốc còn giữ; hàng chưa phát/chưa xong **không bao giờ** bị xoá theo tuổi; mốc bị chặn bởi đồng hồ CSDL; số ngày tối thiểu 1.
- Outbox: `dedupe_key` của hàng bị xoá mất tác dụng. Rà tại nguồn phát (T-505): khoá gắn một sự kiện xảy ra một lần (`invoice_issued`, `tenant_invited`, `export_ready`, `bank_transaction.received:<id>`…) hoặc theo mốc/ngày (`lease_expiring` mốc ≤ 30 ngày, `invoice_overdue:<id>:<ngày>`) — không có đường phát lại cùng khoá sau 90 ngày; bảng `notifications` còn khoá dedupe riêng. Chưa có test chung chặn một nguồn phát mới có cửa sổ dedupe dài hơn 90 ngày: thêm nguồn như vậy thì phải nâng RET-02 trước.
- Vận hành: log `job.done`/`retention.events_purge_failed` (job `events.retention`); lỗi một bảng không chặn bảng khác.
