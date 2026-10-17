---
title: Ứng phó sự cố — Hotel Manager
kind: incident-response
updated: 2026-10-16
owner: (chưa gán — Tech Lead)
---

# Ứng phó sự cố (SEV1–4)

> Chưa có môi trường production: các mức và thời gian phản hồi là **đề xuất khởi điểm**, chủ dự án duyệt trước khi chạy thật (`docs/autopilot/DECISIONS.md`).
> Lệnh chẩn đoán từng thành phần: [`docs/RUNBOOK.md`](../RUNBOOK.md). Quy trình chuyên biệt: [vi phạm dữ liệu](runbooks/data-breach.md) · [lộ bí mật](runbooks/secret-leak.md) · [khôi phục](runbooks/restore.md) · [deploy/rollback](runbooks/deploy-rollback.md). Cảnh báo → runbook: `deploy/prometheus/alerts.yml`; mục tiêu dịch vụ: [`SLO.md`](SLO.md).

## 1. Mức độ (SEV)
Chọn mức **cao hơn** khi do dự; hạ mức sau khi có dữ kiện.

| Mức | Tiêu chí | Ví dụ của dự án | Phản hồi (đề xuất) | Ai tuyên bố |
|---|---|---|---|---|
| SEV1 | Tiền thật, tồn phòng hoặc dữ liệu cá nhân bị ảnh hưởng nghiêm trọng, hoặc toàn hệ thống ngừng. Mọi sự cố bảo mật xác nhận là SEV1 | Tổ chức này đọc được dữ liệu tổ chức khác; lộ số/ảnh CCCD; lộ `BETTER_AUTH_SECRET`/`HM_PII_KEYS` ở production; web và CSDL ngừng > 15 phút (`/api/ready` 503); mất dữ liệu cần khôi phục | Xác nhận ≤ 15 phút; giảm thiệt hại ≤ 1 giờ; cập nhật mỗi 30 phút | Người trực đầu tiên thấy, rồi Tech Lead xác nhận |
| SEV2 | Tính năng lõi hỏng hoặc dữ liệu sai cho một số tổ chức, chưa lan toàn hệ thống | Bán trùng một phòng (hai allocation chồng); lệch sổ tiền (báo cáo công nợ ghi LỆCH SỔ, `reconciliation_break` HASH_MISMATCH); outbox đứng > 30 phút nên thanh toán từ webhook không được ghi; email phiếu thu gửi nhầm người nhận | Xác nhận ≤ 1 giờ (giờ vận hành); khắc phục ≤ 1 ngày; cập nhật mỗi 2 giờ | Người trực |
| SEV3 | Suy giảm có cách vòng, không mất dữ liệu | Email `dead` tăng vì SMTP lỗi; job xuất dữ liệu lỗi hàng loạt; clamd tắt nên tải ảnh trả 503 nhưng thao tác khác vẫn chạy; nhịp worker cũ nhưng chưa có việc đến hạn | Trong 1 ngày làm việc | Người trực |
| SEV4 | Lỗi nhỏ, không ảnh hưởng nghiệp vụ | Sai nhãn hiển thị; một người dùng mất MFA (dùng `member.resetMfa`); cảnh báo `ticket` không kèm người dùng bị ảnh hưởng | Vào backlog, theo lát kế tiếp | Bất kỳ ai |

## 2. Ai làm gì
Tên người (chưa gán — `PROJECT.md` §9): điền ở mục 8 khi có. Một người có thể giữ nhiều vai ở pilot nhưng **người tuyên bố SEV1 không tự duyệt thao tác không đảo ngược** (mục 5).

| Vai | Việc |
|---|---|
| Người chỉ huy sự cố (IC) — Tech Lead hoặc người trực | Tuyên bố và đổi mức; quyết định giảm thiệt hại; giữ dòng thời gian (mục 7); giao việc |
| Người xử lý kỹ thuật | Chẩn đoán theo RUNBOOK, thực hiện giảm thiệt hại và khắc phục qua cổng thường |
| Người liên lạc — Product Owner | Nói với chủ cơ sở/người dùng bị ảnh hưởng; không suy đoán nguyên nhân |
| Pháp lý/kế toán | Quyết nghĩa vụ thông báo (cơ quan, chủ thể), duyệt nội dung thông báo |
| Chủ dự án | Duyệt thao tác không đảo ngược, thông báo ra ngoài, chi phí |

## 3. Thứ tự xử lý (không đảo)
Giảm thiệt hại **trước**, tìm nguyên nhân gốc **sau**.

### 3.1 Phát hiện
Nguồn: cảnh báo Prometheus (`deploy/prometheus/alerts.yml`), `/api/ready`, báo cáo của người dùng, nhật ký audit bất thường. Ghi thời điểm phát hiện (UTC) — đồng hồ thông báo pháp lý tính từ đây. Giữ `correlation_id` (header `X-Correlation-Id`) của yêu cầu lỗi.

### 3.2 Phân mức
Áp bảng mục 1; ghi mức và người tuyên bố. Có dấu hiệu lộ dữ liệu cá nhân hoặc bí mật ⇒ SEV1 và chạy thêm mục 6.

### 3.3 Khoanh vùng và giảm thiệt hại
Chọn biện pháp ít rủi ro nhất đưa hệ thống về trạng thái an toàn: rollback bản triển khai ([deploy-rollback](runbooks/deploy-rollback.md)); tắt tính năng/đường dẫn; thu hồi phiên hoặc membership; tạm khoá liên kết khách (`portal.revokeGuestLink`); chặn `/api/metrics`; ngắt SMTP (đặt `SMTP_URL=fake://local`) khi gửi nhầm; dừng worker khi job gây hại. **Mọi lệnh lên dữ liệu thật theo mục 4.** Không xoá log hoặc dữ liệu để "dọn dẹp".

### 3.4 Liên lạc
SEV1/SEV2: báo người dùng bị ảnh hưởng trong thời hạn mục 1 bằng kênh đã chọn (chưa có trang trạng thái — chờ chủ dự án); nói đã biết gì, đang làm gì, lần cập nhật kế tiếp. Không nêu dữ liệu cá nhân trong kênh chung. Nghĩa vụ thông báo pháp lý: [data-breach.md](runbooks/data-breach.md).

### 3.5 Khắc phục
Sửa nguyên nhân qua cổng thường (PR nhỏ, test tái hiện đỏ trước xanh sau, CI xanh, review). Hotfix không bỏ qua cổng. Dữ liệu sai: sửa bằng bút toán đảo/lệnh nghiệp vụ có audit, không UPDATE tay sổ cái (trigger chặn).

### 3.6 Đóng và hậu kiểm
Đóng khi chỉ số trở lại bình thường ≥ 1 giờ và người bị ảnh hưởng đã được báo. SEV1/SEV2: hậu kiểm không đổ lỗi trong 5 ngày làm việc, lưu `docs/ops/POST-MORTEM-<ngày>-<slug>.md` theo [mẫu của khung](../../.xtemplates/framework/templates/POST-MORTEM.md); mỗi nguyên nhân có hàng rào mới (test/lint/cảnh báo/checklist) kèm chủ và hạn.

## 4. Trước khi chạy lệnh lên dữ liệu
Áp cho mọi lệnh ghi/xoá trên CSDL hoặc kho file thật trong lúc sự cố.
1. **Snapshot ngay trước:** `pgbackrest --stanza=hm --type=incr backup` (hoặc xác nhận bản sao lưu < 15 phút trước), ghi nhãn sao lưu từ `pgbackrest --stanza=hm info` và `select pg_create_restore_point('truoc_<mã_sự_cố>')` vào dòng thời gian.
2. **Viết sẵn lệnh hoàn tác** (hoặc điểm PITR `--type=name --target=truoc_<mã_sự_cố>`) trước khi chạy lệnh chính.
3. **Hai người xác nhận** lệnh và phạm vi (`WHERE`, tổ chức, số dòng dự kiến) bằng `SELECT` cùng điều kiện trước; nếu thao tác không đảo ngược thì cần người duyệt ở mục 5.
4. Chạy trong transaction, kiểm số dòng bị ảnh hưởng trước `COMMIT`; ghi lệnh và kết quả vào dòng thời gian.

## 5. Thao tác không đảo ngược — phải có người duyệt trước
(AGENTS §6; agent không tự làm.)
- Khôi phục CSDL đè lên dữ liệu đang chạy; xoá/sửa tay dữ liệu sổ tiền, tồn phòng, giấy tờ; xoá object file; xoá bản sao lưu.
- Xoay hoặc huỷ khoá làm mất khả năng đọc dữ liệu (`HM_PII_KEYS`, `PGBACKREST_REPO_CIPHER_PASS`); bỏ khoá cũ.
- Thông báo ra ngoài (cơ quan, chủ thể, khách hàng, báo chí); đổi DNS/chứng chỉ; mở lại dịch vụ sau khi chặn vì an ninh.
- Hoàn tiền, đảo bút toán hàng loạt, chuyển dữ liệu ra nước ngoài, bất cứ thao tác tiền thật.

## 6. Sự cố bảo mật = SEV1
Ngoài mục 3, làm đủ ba nhóm việc:
1. **Bảo toàn chứng cứ:** sao chép log (web, worker, Caddy, Postgres), nhật ký audit (`audit_events`) và `pg_stat_activity` sang nơi chỉ đọc **trước** khi khởi động lại hoặc xoay; ghi giờ và người thực hiện; không xoá, không "dọn".
2. **Thu hồi/xoay bí mật liên quan:** theo bảng từng loại ở [secret-leak.md](runbooks/secret-leak.md); thu hồi phiên và membership nghi ngờ; đặt lại MFA tài khoản bị chiếm.
3. **Đánh giá nghĩa vụ thông báo:** chuyển dữ kiện cho pháp lý ngay (loại dữ liệu, số chủ thể, thời điểm phát hiện); đồng hồ thông báo bắt đầu từ lúc phát hiện — [data-breach.md](runbooks/data-breach.md).

Đầu mối pháp lý: (chưa gán — chủ dự án cung cấp trước khi chạy thật).

## 7. Mẫu dòng thời gian
Ghi theo giờ UTC, từ nguồn máy (log, audit, ảnh chụp cảnh báo); mốc "giảm thiệt hại" phải đứng trước mốc "nguyên nhân gốc".

| Giờ (UTC) | Sự kiện | Nguồn | Người |
|---|---|---|---|
| hh:mm | Cảnh báo/báo cáo đầu tiên (phát hiện) | alert `<tên>` / người dùng | |
| hh:mm | Tuyên bố SEV`<n>`, IC = `<tên>` | | |
| hh:mm | Snapshot/điểm khôi phục `<nhãn>` | `pgbackrest info` | |
| hh:mm | **Giảm thiệt hại:** `<hành động>` | | |
| hh:mm | Liên lạc người dùng/pháp lý | | |
| hh:mm | Nguyên nhân gốc xác định | | |
| hh:mm | Khắc phục qua cổng (PR `<số>`), chỉ số bình thường | CI, `/api/ready` | |
| hh:mm | Đóng; hậu kiểm hẹn `<ngày>` | | |

## 8. Liên hệ và leo thang
| Vai | Tên | Kênh | Giờ | Thay thế |
|---|---|---|---|---|
| Trực chính / IC | (chưa gán) | (chưa chọn) | (chưa có lịch trực) | (chưa gán) |
| Product Owner | (chưa gán) | | | |
| Pháp lý/kế toán | (chưa gán) | | | |
| Chủ dự án | (chưa gán) | | | |
| Nhà cung cấp VPS, kho sao lưu, SMTP | (chưa chọn — `docs/privacy/processors.md`) | | | |

Onboarding người mới: đọc tài liệu này, [RUNBOOK](../RUNBOOK.md) và diễn tập bàn (tabletop) ít nhất mỗi năm một lần cho SEV1 lộ dữ liệu.
