---
status: Approved
approved_by: "phiên chính (D-139, AGENTS §5)"
approved_at: "2026-11-01"
---

# Công cụ vận hành trước khi có VPS

## 1. Mục tiêu

Người vận hành dùng cùng artifact bất biến qua staging/production, có backup định kỳ và có đường về bản tốt khi phát hành lỗi. Chủ dự án ngày 2026-11-01 chọn hoàn tất mã và PR trước vì chưa có VPS/tên miền. Kiểm cục bộ bằng dữ liệu giả; các MUST yêu cầu môi trường/kênh trực/diễn tập thật vẫn mở.

## 2. Tiêu chí chấp nhận

### S-001 — Manifest bất biến
- Given manifest có commit đủ 40 hex, phiên bản semver và web/worker bằng digest SHA-256.
- When promote, hoặc nhận tag/kiểu mảng/trường lạ/đầu vào sai.
- Then chỉ manifest hợp lệ được đưa vào Compose, không dựng lại hoặc thay dịch vụ nền; dữ liệu sai bị chặn trước lệnh ngoài.

### S-002 — Promote và rollback
- Given có bản tốt A rồi promote B.
- When B lỗi readiness/version/header hoặc ghi bằng chứng/lịch sử thất bại.
- Then áp lại A, smoke A, trả lỗi phát hành; lịch sử không tiến lên B. Chưa có bản tốt thì ghi cần phục hồi, không tự khai rollback thành công. Promote lặp B giữ bản trước A; rollback rõ ràng trở về A. Chạy chồng bị khoá.

### S-003 — Backup có bằng chứng
- Given lịch full hằng tuần/diff các ngày còn lại và state/metric riêng.
- When pgBackRest thành công/thất bại, kể cả umask 0027.
- Then runner có timeout, loại backup đóng, không in URL/lỗi thô; thất bại giữ mốc thành công trước và phát metric lỗi; state 0600, metric 0644 thay nguyên tử. Lock chung chặn chạy chồng, state hỏng không bị ghi đè im lặng.

### S-004 — Smoke đúng trạng thái
- Given origin HTTPS hoặc HTTP loopback và version mong đợi.
- When smoke health/ready/version/đăng nhập.
- Then chỉ 200, version đúng và CSP chặn object/frame cùng nosniff/DENY mới qua; từ chối redirect, URL chứa credentials/path/query, CSP giả bằng tiền tố/nguồn phụ/directive lặp. Request có timeout.

### S-005 — Startup worker thuộc đúng instance
- Given Compose đã chạy web/worker và HTTP web có thể đang xanh trong khi worker còn chờ kết nối.
- When promote hoặc rollback chờ worker startup, rồi chạy HTTP smoke.
- Then trong tối đa 120 giây riêng phải thấy container worker Running, không restart, có JSON `worker.started` từ log sau StartedAt của chính instance đó; query đọc có timeout/buffer giới hạn và không in đầu ra thô. Marker cũ, container thoát, đổi ID/StartedAt, thiếu log hoặc hết hạn không được tiến lịch sử. Sau HTTP smoke phải kiểm lại cùng instance còn chạy; worker lỗi trong rollback không được khai rollback thành công. Cấu hình logger phải giữ mức info/debug cho marker, kiểm startup không thay giám sát heartbeat liên tục.

## 3. Bằng chứng và giới hạn

`scripts/ops.test.mjs` kiểm hành vi S-001…S-005, gồm lỗi đĩa sau smoke, promote lặp, worker pending dù web xanh, marker cũ/restart/đổi container, deadline từng query và worker chết trong lúc smoke; `deploy/prometheus/host-operations.test.yml` kiểm ngưỡng cảnh báo bằng promtool. `scripts/ops/local-images-check.mjs` dựng/chạy image thật: tài khoản không root, npm absent, PostgreSQL/SeaweedFS tạm, clamd giả, readiness/version/header, worker.started và SIGTERM exit 0. Bằng chứng image ghi ID/digest cục bộ, không khẳng định đã push registry hoặc triển khai thật.

Không tự chạy migration khi promote, không down schema khi rollback ứng dụng, không mua dịch vụ hoặc nạp secret thật. Ngưỡng backup 26 giờ/tám ngày và lịch chỉ là mặc định kỹ thuật, chưa thay quyết định RPO/RTO, offsite IAM, escrow hoặc diễn tập restore.
