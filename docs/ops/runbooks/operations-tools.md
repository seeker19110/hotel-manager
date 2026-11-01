---
title: Runbook — công cụ backup, promote và rollback
kind: runbook
updated: 2026-11-01
last_drilled: chưa diễn tập trên staging/production; kiểm tự động cục bộ bằng dữ liệu giả
owner: (chưa gán — Tech Lead)
---

# Công cụ vận hành

`scripts/ops/run.mjs` dùng Docker Compose và pgBackRest hiện có; không cần nhà cung cấp riêng. Kiểm cục bộ không chứng minh offsite, thông báo trực, RPO/RTO hoặc quyền deploy production. Trước khi chạy thật phải hoàn tất điều kiện trong [deploy/rollback](deploy-rollback.md) và [restore](restore.md).

## Backup định kỳ

- Host có Node đúng `.nvmrc`, Docker Compose; tài khoản vận hành `hotel-manager-ops` có quyền chạy Docker và đọc cấu hình deploy. Mã đặt tại `/opt/hotel-manager`; chỉnh unit nếu đường dẫn Node/repo khác.
- Tạo `/var/lib/hotel-manager/backup` chỉ tài khoản vận hành được ghi; thư mục textfile `/var/lib/node_exporter/textfile_collector` cho tài khoản đó ghi và node_exporter đọc. State chứa số đếm/mốc, file `.prom` mode 0644 không chứa PII/secret. Bật textfile collector và timex collector, cấu hình Prometheus scrape host và nạp `deploy/prometheus/alerts.yml`.
- Cấu hình kho pgBackRest thật, mã hoá, quyền writer/offsite trước; `stanza-create`, `check` và full đầu tiên là bước thiết lập có chủ đích. Không tạo kho hoặc nhận secret bằng script.
- Lệnh full: `node scripts/ops/run.mjs backup full deploy/compose.yaml /var/lib/hotel-manager/backup /var/lib/node_exporter/textfile_collector`; diff thay `full` bằng `diff`. Runner gọi đúng service postgres dưới user postgres, timeout 55 phút, không in output có thể chứa URL bí mật. Journal chỉ nhận kết quả an toàn.
- Cài ba unit `deploy/systemd/hm-backup*` vào systemd sau khi đối chiếu đường dẫn/quyền. Enable hai timer full/diff: full Chủ nhật 02:00 UTC, diff thứ Hai…Bảy 02:00 UTC; độ trễ ngẫu nhiên tối đa năm phút, `Persistent=true`. Kiểm `systemctl list-timers` và chạy thử thất bại tới kênh cảnh báo thật.
- Một khoá chung chặn full/diff chạy chồng. `operation.lock` còn lại sau mất điện không bị tự cướp: kiểm tiến trình và `pgbackrest info`, chỉ gỡ đúng thư mục khoá khi chắc chắn không còn job. Lỗi cập nhật metric/state khiến service đỏ; cảnh báo metric thiếu/quá hạn vẫn phải hoạt động. Metric thành công cuối chỉ tăng khi pgBackRest exit 0; không dùng nó thay phép thử restore.

## Promote cùng digest và rollback

Chuẩn bị manifest JSON chỉ có `format`, `commit`, `version`, `web`, `worker`. `format` là `hm-release/1`, commit đủ 40 hex, version đúng phiên bản `/api/version`, cả hai image dùng `registry/path@sha256:<64 hex>`; tag như `latest` bị từ chối. CI/staging/production dùng cùng manifest đã kiểm, không dựng lại khi promote. Mẫu cấu trúc nằm ở [kiểm thử](../../../scripts/ops.test.mjs).

`node scripts/ops/run.mjs promote <manifest.json> deploy/compose.yaml <state-dir> https://<domain>` chỉ thay web/worker (`--no-deps --no-build --pull always`) và chờ Compose tối đa 120 giây. Hạ tầng phải chạy sẵn; chưa tự chạy migration. Tiếp đó runner kiểm startup worker trong tối đa 120 giây riêng: lấy đúng một container worker của project, kiểm Running/StartedAt và chỉ đọc log container đó từ StartedAt; phải có JSON `msg: worker.started` với mốc không trước lần khởi động hiện tại. Mỗi lệnh đọc Docker có timeout tối đa năm giây, kẹp theo thời gian còn lại; stdout chỉ dùng nội bộ, buffer tối đa 1 MiB, không in log/lỗi con thô. Container đã thoát, đang restart hoặc đổi ID/StartedAt đều làm phát hành lỗi, không dùng log lần chạy cũ để báo thành công.

Sau khi worker startup đạt, smoke kiểm health, ready, version chính xác và header CSP/nosniff/frame tại trang đăng nhập; mỗi request timeout năm giây, không theo redirect. Trước khi ghi lịch sử, runner kiểm worker vẫn là instance đang chạy vừa xác minh, vì worker có thể chết/restart trong lúc HTTP web vẫn xanh. `node scripts/ops/run.mjs smoke <origin> <version>` chạy riêng chỉ kiểm HTTP; nó không thay phép kiểm worker của promote/rollback. Chỉ HTTPS hoặc HTTP loopback; URL chứa tài khoản/path/query bị từ chối.

Worker phải để `LOG_LEVEL=info` hoặc `debug` và Docker phải còn startup log của instance hiện tại để checker đọc được `worker.started`. Không thấy log (kể cả đã xoay vòng hoặc vượt giới hạn buffer) thì từ chối xác nhận, dù HTTP web xanh; kiểm lại container/cấu hình và lên lịch khởi động lại có chủ đích nếu cần. Đây là kiểm startup tại thời điểm phát hành, không thay heartbeat/alert giám sát liên tục. Không tự cài collector hoặc triển khai lên hạ tầng thật.

Sau startup worker, smoke và kiểm lại instance thành công, `releases.json` được thay nguyên tử, giữ manifest hiện tại và trước đó. Nếu promote lỗi và có bản tốt, runner áp lại đúng digest cũ rồi kiểm lại startup worker, smoke và cùng instance theo cùng điều kiện; vẫn exit khác 0 để phát hành không bị ghi nhận thành công. Rollback có worker chưa startup/đã thoát không được ghi `rolled_back`. Lần đầu lỗi chưa có bản cũ thì phải phục hồi thủ công. `last-attempt.json` phân biệt passed/rolled_back/failed; `releases.json` là lần thành công gần nhất, không khẳng định trạng thái giữa chừng khi tiến trình chết.

`node scripts/ops/run.mjs rollback deploy/compose.yaml <state-dir> https://<domain>` chọn manifest trước, thực hiện cùng smoke và cập nhật lịch sử sau thành công. Rollback ứng dụng không down schema tự động; đánh giá N−1 và guard migration trước. Giữ state-dir ngoài checkout để không mất lịch sử khi thay release. Không sao chép secret vào manifest hoặc gửi response/log thô vào báo cáo.

Rollback đổi chỗ hai manifest hiện tại/trước: gọi lại lần nữa sẽ quay về manifest vừa rời đi. Đối chiếu digest trước mỗi lần chạy; không lặp lệnh chỉ vì chưa thấy giao diện cập nhật. Lỗi khoá backup có thể xảy ra trước lúc ghi metric: service vẫn exit lỗi, nhưng cảnh báo mốc cũ chỉ xuất hiện khi quá hạn. Sau timeout Docker exec, kiểm job pgBackRest trong container đã dừng trước khi gỡ khoá/thử lại.

## Căn cứ kỹ thuật

Đối chiếu 2026-11-01: [pgBackRest backup/check](https://pgbackrest.org/command.html), [lịch full/diff](https://pgbackrest.org/user-guide.html), [systemd timer Persistent/RandomizedDelaySec](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html), [textfile collector](https://prometheus.github.io/client_python/exporting/textfile/). Quy trình vẫn cần diễn tập với người/kho/kênh trực thật.
