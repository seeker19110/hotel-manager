# Nhật ký quyết định tự duyệt

> Ghi bởi `xt.py loop decide`. Phiên chính tự duyệt điểm quyết định theo tiêu chí chất lượng cuối (`LOOP-STOP-018`, ADR-0008 của khung). Người xem lại bất cứ lúc nào; đổi ý → quyết định mới ghi "thay D-NNN", không sửa mục cũ.

### D-001 · 2026-10-16T01:07:23+00:00 · Đợt 3 dựng trên gì khi PR #5 (đợt 2) xanh nhưng chưa được chủ dự án cho merge?

- Phương án: (1) Merge PR #5 vào main rồi làm đợt 3 trên main · (2) Xếp chồng: nhánh đợt 3 gộp đầu PR #5 (merge commit), PR đợt 3 nhắm vào nhánh PR #5 cho tới khi PR #5 merge · (3) Chờ chủ dự án merge PR #5 rồi mới bắt đầu
- Chọn: Xếp chồng: nhánh đợt 3 gộp đầu PR #5 (merge commit), PR đợt 3 nhắm vào nhánh PR #5 cho tới khi PR #5 merge
- Lý do (tiêu chí chất lượng cuối): (2) giữ đường lùi: merge 24k dòng vào main là việc chủ dự án chưa duyệt; xếp chồng không đổi main, không chặn tiến độ; khi PR #5 merge chỉ cần đổi base PR đợt 3
- Đường lùi: PR #5 cần sửa → merge lại nhánh PR #5 vào nhánh đợt 3; bỏ đợt 3 → đóng PR, main không đổi

### D-002 · 2026-10-16T01:12:58+00:00 · Giá trị mặc định cho 15 câu hỏi [chặn] của đợt 3 (reservation Q-01/02/03/04/08/12, inventory Q-01, housekeeping Q-01/06/10, portal Q-01/02, audit Q-01, access Q-01/03)

- Phương án: (1) Dừng chờ PO trả lời từng câu · (2) Áp bảng mặc định của PLAN đợt 3 theo đề xuất trong SPEC, tham số hoá theo cơ sở, chứng từ lưu quy tắc đã dùng · (3) Chọn phương án tối giản không tham số
- Chọn: Áp bảng mặc định của PLAN đợt 3 theo đề xuất trong SPEC, tham số hoá theo cơ sở, chứng từ lưu quy tắc đã dùng
- Lý do (tiêu chí chất lượng cuối): (1) đúng & an toàn: theo đúng đề xuất đã viết trong SPEC, chặt hơn ở dữ liệu cá nhân (không lưu ảnh giấy tờ, token khách lưu hash); (2) giữ đường lùi: mọi giá trị là tham số cơ sở, đổi không cần migration; giống cách đã duyệt ở đợt 1–2
- Đường lùi: Đổi tham số properties.settings/organizations.settings; chứng từ cũ giữ quy tắc đã dùng

### D-003 · 2026-10-16T01:12:58+00:00 · Máy quét mã độc cho ảnh phiếu sự cố/file (housekeeping Q-10)

- Phương án: (1) ClamAV tự host (clamd, giao thức zINSTREAM qua TCP) sau adapter MalwareScanner · (2) Dịch vụ quét đám mây trả phí (cần tài khoản/khoá) · (3) Không quét, chỉ dựa vào giải mã và mã hoá lại ảnh
- Chọn: ClamAV tự host (clamd, giao thức zINSTREAM qua TCP) sau adapter MalwareScanner
- Lý do (tiêu chí chất lượng cuối): (1) SPEC S-015 bắt buộc quét; (2) mặc định tự host, GPL-2.0 (OSI), ClamAV 1.4.6 LTS EOL 2027-08-15 (xác minh 2026-10-16, docs.clamav.net); không cần khoá; dev/CI dùng EICAR-only + clamd giả trong test, chưa quét được thì file không ready
- Đường lùi: Đổi implementation của MalwareScanner; không đổi schema
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Container clamav/clamav:1.4.6 ghim digest, RAM ≥ 3 GiB (khuyến nghị 4 GiB), freshclam cần mạng tới database.clamav.net — cần chủ dự án duyệt cấu hình VPS

### D-004 · 2026-10-16T01:12:58+00:00 · Duyệt PLAN đợt 3 (22 task T-201…T-222, 100 vòng · ≤ 280 USD · 1800 s · 96 giờ)

- Phương án: (1) Duyệt nguyên PLAN · (2) Cắt còn F-006 + F-007 (khách sạn, buồng phòng), dời portal/thông báo/báo cáo sang đợt 4 · (3) Không duyệt, viết lại
- Chọn: Duyệt nguyên PLAN
- Lý do (tiêu chí chất lượng cuối): (1) phủ đủ 5 tính năng Must còn lại của MVP trước pilot, mỗi task có Gate máy kiểm, bất biến tiền/tồn test trên Postgres thật; (3) cùng khuôn đợt 2 (18 task, xong trong một phiên); cắt giảm đã có thứ tự trong PROJECT §5 nếu trễ
- Đường lùi: Tick [~] — Bỏ: <lý do> cho task cắt; đợt 4 nhận lại

### D-005 · 2026-10-16T01:14:14+00:00 · Giờ chốt ngày mặc định của cơ sở hotel và nơi áp các giá trị mặc định theo mẫu (thay phần cột/tham số của D-002)

- Phương án: (1) 06:00 (D-002), đặt bằng trigger DB khi INSERT · (2) 04:00 khớp fixture SPEC-reservation S-016/S-026, đặt ở lớp app (propertyDefaults theo mẫu) — cột properties.business_day_cutoff/check_in_time/check_out_time/hold_ttl_minutes giữ mặc định DB
- Chọn: 04:00 khớp fixture SPEC-reservation S-016/S-026, đặt ở lớp app (propertyDefaults theo mẫu) — cột properties.business_day_cutoff/check_in_time/check_out_time/hold_ttl_minutes giữ mặc định DB
- Lý do (tiêu chí chất lượng cuối): (1) SPEC đã viết ví dụ bắt buộc với giờ chốt 04:00; trigger không phân biệt được 00:00 cố ý với mặc định; (3) tham số đã là cột trong ERD (không phải settings) — dùng đúng cột, đổi không cần migration
- Đường lùi: Đổi hằng số propertyDefaults; cơ sở đã tạo giữ giá trị đã lưu
