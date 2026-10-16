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

### D-006 · 2026-10-16T01:22:14+00:00 · Đêm cuối tuần cấu hình ở đâu (ERD: properties.settings; D-002/Q-03: rate_plans.weekend_nights) và báo giá dùng snapshot thế nào

- Phương án: (1) rate_plans.weekend_nights smallint[] mặc định {5,6} (0=CN…6=T7), CHECK giá trị 0..6 ở DB; báo giá: đêm có trong snapshot reservation_items.nightly_prices thì giữ, đêm mới tra bảng giá hiện hành · (2) properties.settings.weekend_nights (jsonb) như ERD
- Chọn: rate_plans.weekend_nights smallint[] mặc định {5,6} (0=CN…6=T7), CHECK giá trị 0..6 ở DB; báo giá: đêm có trong snapshot reservation_items.nightly_prices thì giữ, đêm mới tra bảng giá hiện hành
- Lý do (tiêu chí chất lượng cuối): (1) ràng buộc kiểu ở DB thay vì jsonb không kiểm; bảng giá mang luôn quy tắc nên snapshot/INV-G3 rõ; (3) một nơi cấu hình theo loại phòng, sửa ERD cho khớp
- Đường lùi: Migration thêm settings + bỏ dùng cột (cột vẫn có mặc định)

### D-007 · 2026-10-16T01:59:56+00:00 · T-204: các điểm SPEC hở khi làm booking (stays tạo sớm; xác nhận không tiền; booking nhiều phòng; no-show; phí huỷ)

- Phương án: (1) Áp như executor đã làm: stays tạo ngay ở 0025 (S-005/S-009/S-011 cần stay expected/cancelled/no_show); xác nhận không tiền mặc định TỪ CHỐI (EVIDENCE_REQUIRED), bật bằng properties.settings.reservation.confirm_without_payment; nhiều phòng tối đa 10 (mở rộng, HTTP vẫn nhận unit_id đơn); no-show khi ngày kinh doanh > ngày đến; phí huỷ qua charges trong hạn mức, vượt → duyệt · (2) Theo đề xuất SPEC Q-05: mặc định cho xác nhận không tiền; bỏ booking nhiều phòng (để F-013)
- Chọn: Áp như executor đã làm: stays tạo ngay ở 0025 (S-005/S-009/S-011 cần stay expected/cancelled/no_show); xác nhận không tiền mặc định TỪ CHỐI (EVIDENCE_REQUIRED), bật bằng properties.settings.reservation.confirm_without_payment; nhiều phòng tối đa 10 (mở rộng, HTTP vẫn nhận unit_id đơn); no-show khi ngày kinh doanh > ngày đến; phí huỷ qua charges trong hạn mức, vượt → duyệt
- Lý do (tiêu chí chất lượng cuối): (1) chặt hơn với tiền: không xác nhận giữ phòng nếu chưa có khoản thu đã xác nhận (INV-F3) — cơ sở muốn nới thì bật cờ; (2) nhiều phòng đã có test ở DB, không ảnh hưởng luồng một phòng, HTTP mặc định vẫn một phòng; stays sớm khớp SPEC
- Đường lùi: Đổi cờ cơ sở; ẩn rooms[] khỏi schema HTTP

### D-008 · 2026-10-16T01:59:57+00:00 · T-219: hạn giữ file import nguồn khi lô bị bỏ dở; production chưa có máy quét thật

- Phương án: (1) delete_after = ngày tải lên + 90 ngày (commit/huỷ đặt lại 30 ngày); production fail-closed khi chỉ có eicarOnlyScanner (upload trả 500 cho tới khi có ClamdScanner T-210) · (2) Không đặt hạn cho lô bỏ dở; production dùng eicarOnlyScanner
- Chọn: delete_after = ngày tải lên + 90 ngày (commit/huỷ đặt lại 30 ngày); production fail-closed khi chỉ có eicarOnlyScanner (upload trả 500 cho tới khi có ClamdScanner T-210)
- Lý do (tiêu chí chất lượng cuối): (1) không giữ PII vô hạn trong lô bỏ dở; không coi EICAR-only là quét thật ở production (SPEC S-015, THREAT-MODEL)
- Đường lùi: Đổi hằng số ngày; cấu hình scanner

### D-009 · 2026-10-16T02:17:21+00:00 · T-205: thời điểm ghi tiền phòng từng đêm và quy tắc giấy tờ khi nhận phòng (SPEC hở/Q-11)

- Phương án: (1) Ghi charges tiền phòng mỗi đêm ngay lúc check-in/walk-in theo snapshot giá (SPEC S-012, đề xuất Q-11), chỉ mục duy nhất mỗi đêm một khoản; giấy tờ bắt buộc mọi người lưu trú (trẻ em loại other), nước ngoài bắt buộc hộ chiếu, CCCD 9/12 số, người đại diện có SĐT; check-in chỉ trong [ngày đến, ngày đi) · (2) Để T-206 ghi tiền phòng lúc check-out/đêm; giấy tờ chỉ bắt buộc người đại diện
- Chọn: Ghi charges tiền phòng mỗi đêm ngay lúc check-in/walk-in theo snapshot giá (SPEC S-012, đề xuất Q-11), chỉ mục duy nhất mỗi đêm một khoản; giấy tờ bắt buộc mọi người lưu trú (trẻ em loại other), nước ngoài bắt buộc hộ chiếu, CCCD 9/12 số, người đại diện có SĐT; check-in chỉ trong [ngày đến, ngày đi)
- Lý do (tiêu chí chất lượng cuối): (1) khớp SPEC S-012 và ví dụ folio S-017 (đủ phí đêm trước khi trả phòng, không job theo đồng hồ — S-016 a), ràng buộc DB chống ghi trùng; giấy tờ theo D-002/Q-08 và nghĩa vụ thông báo lưu trú
- Đường lùi: Bỏ ghi charges ở checkIn, chuyển sang T-206; nới CHECK giấy tờ

### D-010 · 2026-10-16T02:19:40+00:00 · T-211: các điểm SPEC hở của thông báo (retry, mặc định opt-in, email tối thiểu, huỷ đăng ký GET, quyền xem lịch sử gửi)

- Phương án: (1) 1 lần gửi + 5 lần thử lại (1ph/5ph/30ph/2h/6h) rồi dead; chưa có preference = opted_in cho thông báo giao dịch; stay_notice_due chỉ in-app; email không ghi số tiền (params jsonb không PII); huỷ đăng ký qua GET có token HMAC 30 ngày (đảo ngược được); listDeliveries chỉ owner/manager · (2) Tổng 5 lần gửi; mặc định opted_out; huỷ đăng ký POST one-click (cần đổi cấu hình same-origin của cổng)
- Chọn: 1 lần gửi + 5 lần thử lại (1ph/5ph/30ph/2h/6h) rồi dead; chưa có preference = opted_in cho thông báo giao dịch; stay_notice_due chỉ in-app; email không ghi số tiền (params jsonb không PII); huỷ đăng ký qua GET có token HMAC 30 ngày (đảo ngược được); listDeliveries chỉ owner/manager
- Lý do (tiêu chí chất lượng cuối): (1) không đổi cấu hình cổng/bảo mật (POST khác origin đang bị chặn có chủ đích); email tối thiểu không lộ số tiền (Q-03); (3) khớp S-004 attempts 1…5
- Đường lùi: Đổi hằng số backoff; thêm route POST khi chủ dự án duyệt miễn trừ same-origin
