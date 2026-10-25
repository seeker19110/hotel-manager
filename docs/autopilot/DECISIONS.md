# Nhật ký quyết định tự duyệt

> Ghi bởi `xt.py loop decide`. Phiên chính tự duyệt điểm quyết định theo tiêu chí chất lượng cuối (`LOOP-STOP-018`, ADR-0008 của khung). Người xem lại bất cứ lúc nào; đổi ý → quyết định mới ghi "thay D-NNN", không sửa mục cũ.

### D-001 · 2026-10-16T03:41:16+00:00 · Đợt 3 bắt đầu khi PR #5 (đợt 2) xanh, mergeable nhưng chưa merge — nối nhánh thế nào?

- Phương án: (1) Chờ chủ dự án merge PR #5 rồi mới làm · (2) Nhánh đợt 3 xếp chồng trên đầu PR #5, PR đợt 3 đặt base = nhánh PR #5 · (3) Nhánh đợt 3 từ main, làm lại phần phụ thuộc
- Chọn: Nhánh đợt 3 xếp chồng trên đầu PR #5, PR đợt 3 đặt base = nhánh PR #5
- Lý do (tiêu chí chất lượng cuối): Đợt 3 phụ thuộc lõi tiền/hợp đồng/kỳ thu của PR #5; chờ thì đứng việc, làm từ main thì trùng lặp và xung đột. Xếp chồng giữ diff review nhỏ, merge PR #5 trước rồi đổi base về main (merge main vào nhánh, không rebase).
- Đường lùi: Nếu PR #5 bị đổi lớn hoặc đóng: merge nhánh PR #5 mới vào nhánh đợt 3 hoặc cherry-pick các commit đợt 3 lên main.

### D-002 · 2026-10-16T03:41:16+00:00 · Câu hỏi [chặn] đợt 3 (reservation-stay Q-01/02/03/04/08/12/14/15, housekeeping Q-01/06, portal Q-01/02) — chờ PO hay mặc định tham số hoá?

- Phương án: (1) Dừng chờ PO trả lời từng câu · (2) Áp đề xuất của chính SPEC làm mặc định, tham số hoá theo cơ sở/tổ chức (đổi không cần migration), chứng từ lưu quy tắc đã dùng
- Chọn: Áp đề xuất của chính SPEC làm mặc định, tham số hoá theo cơ sở/tổ chức (đổi không cần migration), chứng từ lưu quy tắc đã dùng
- Lý do (tiêu chí chất lượng cuối): Giống đợt 2 đã được chủ dự án duyệt; mọi giá trị là tham số nên đổi ý không mất dữ liệu; cách hiểu chặt hơn ở bảo mật/pháp lý (không lưu ảnh giấy tờ, không đặt hạn thông báo lưu trú mặc định, không phạt huỷ tự động, giá niêm yết là giá cuối).
- Đường lùi: Đổi giá trị tham số trong properties.settings/organizations.settings; chứng từ cũ giữ quy tắc đã snapshot.

### D-003 · 2026-10-16T03:41:16+00:00 · Máy quét mã độc cho file tải lên (housekeeping Q-10, treo từ đợt 1)

- Phương án: (1) Giữ eicarOnlyScanner (chỉ nhận chuỗi EICAR) · (2) Adapter clamd INSTREAM (ClamAV tự host, GPL-2.0, tiến trình riêng) + bản giả trong dev/CI + contract test với clamd giả; không có scanner thật thì file không sang ready · (3) Dịch vụ quét đám mây trả phí
- Chọn: Adapter clamd INSTREAM (ClamAV tự host, GPL-2.0, tiến trình riêng) + bản giả trong dev/CI + contract test với clamd giả; không có scanner thật thì file không sang ready
- Lý do (tiêu chí chất lượng cuối): Tự host mặc định (ADR-0002, AGENTS §5); ClamAV là chuẩn tự host phổ biến, giao tiếp qua socket nên không thêm phụ thuộc npm; mặc định an toàn: cấu hình prod thiếu scanner → khởi động lỗi.
- Đường lùi: Đổi implementation MalwareScanner (một interface) sang dịch vụ khác; dữ liệu files không đổi.
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Chạy container clamav/clamav cạnh app trên VPS, cập nhật chữ ký freshclam hằng ngày; đặt CLAMD_HOST/CLAMD_PORT.

### D-004 · 2026-10-16T03:41:16+00:00 · Mã hoá cột số giấy tờ identity_documents.doc_number (treo từ đợt 2)

- Phương án: (1) Không mã hoá, chỉ RLS + che khi hiển thị · (2) Mã hoá tầng app AES-256-GCM (khoá từ env, có key_id để xoay khoá) + blind index HMAC-SHA256 để tra trùng; DB chỉ thấy ciphertext · (3) pgcrypto trong CSDL (khoá đi qua câu SQL)
- Chọn: Mã hoá tầng app AES-256-GCM (khoá từ env, có key_id để xoay khoá) + blind index HMAC-SHA256 để tra trùng; DB chỉ thấy ciphertext
- Lý do (tiêu chí chất lượng cuối): Dữ liệu cá nhân nhạy cảm (NĐ 356/2025): lộ bản sao lưu/CSDL không lộ số giấy tờ; khoá không đi qua SQL/log như pgcrypto; node:crypto có sẵn, không thêm phụ thuộc.
- Đường lùi: Giải mã toàn bộ bằng script migration ngược (khoá còn giữ) về cột văn bản.
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Khoá HM_PII_KEY lưu ở secret manager/biến môi trường của VPS, sao lưu khoá tách khỏi bản sao lưu CSDL.

### D-005 · 2026-10-16T03:41:30+00:00 · Người thuê đăng nhập portal bằng gì (portal Q-01)

- Phương án: (1) OTP email qua plugin emailOTP của Better Auth (đã cài 1.7.9) · (2) Mật khẩu như nhân viên · (3) OTP SMS (nhà cung cấp trả phí)
- Chọn: OTP email qua plugin emailOTP của Better Auth (đã cài 1.7.9)
- Lý do (tiêu chí chất lượng cuối): Không cần nhà cung cấp SMS trả phí; người thuê không phải nhớ mật khẩu; plugin có sẵn trong bản đã ghim; tự host qua SMTP relay (ADR-0002); OTP có hạn + giới hạn thử.
- Đường lùi: Bật thêm phương thức khác trong cấu hình Better Auth; membership tenant không đổi.
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Dùng SMTP relay đã chọn cho email giao dịch; OTP SMS xem lại sau pilot nếu tỷ lệ người thuê có email thấp.

### D-006 · 2026-10-16T03:41:30+00:00 · Xác thực liên kết khách lưu trú (portal Q-02)

- Phương án: (1) Chỉ token trong liên kết · (2) Token ngẫu nhiên 256 bit (chỉ lưu hash) + nhập 4 số cuối SĐT người đặt; sai 5 lần thì khoá liên kết; giới hạn theo IP
- Chọn: Token ngẫu nhiên 256 bit (chỉ lưu hash) + nhập 4 số cuối SĐT người đặt; sai 5 lần thì khoá liên kết; giới hạn theo IP
- Lý do (tiêu chí chất lượng cuối): Liên kết bị chuyển tiếp/lộ vẫn cần yếu tố thứ hai; đúng đề xuất SPEC; không cần dịch vụ ngoài.
- Đường lùi: Tắt bước 4 số cuối bằng cờ cơ sở (portal.guest_link_second_factor=false).

### D-007 · 2026-10-16T03:41:30+00:00 · Hợp đồng không thời hạn đã ký không đổi giá được (phụ lục chồng hiệu lực — treo từ review đợt 2)

- Phương án: (1) Giữ nguyên, bắt thanh lý và ký hợp đồng mới · (2) Cho phụ lục sửa effective_to của phiên bản mở cuối · (3) Thêm cột superseded_on (chỉ NULL → ngày, đặt một lần bởi phụ lục, trigger chặn mọi đổi khác); điều khoản đã ký + SHA-256 giữ nguyên; hiệu lực thực = least(effective_to, superseded_on − 1)
- Chọn: Thêm cột superseded_on (chỉ NULL → ngày, đặt một lần bởi phụ lục, trigger chặn mọi đổi khác); điều khoản đã ký + SHA-256 giữ nguyên; hiệu lực thực = least(effective_to, superseded_on − 1)
- Lý do (tiêu chí chất lượng cuối): Giữ bất biến INV-G4 (điều khoản đã ký không đổi byte nào) mà vẫn đổi giá được; ràng buộc ở CSDL, có audit; phương án 2 phá băm điều khoản.
- Đường lùi: Migration down đóng phiên bản đã bị thay (`effective_to = superseded_on − 1`, tắt riêng trigger bất biến quanh đúng câu UPDATE đó, cùng transaction) rồi mới bỏ cột và dựng lại EXCLUDE; phụ lục đã tạo vẫn là phiên bản hợp lệ, chỉ cần chặn tạo mới (test `lease-supersede-down.db.test.ts`).

### D-008 · 2026-10-16T03:41:31+00:00 · Quản lý có được đặt giá dịch vụ (SPEC-metering nói có, ma trận quyền SPEC-access nói không)

- Phương án: (1) Theo SPEC-metering: owner + manager · (2) Theo ma trận quyền (nguồn duyệt quyền): chỉ owner; sửa SPEC-metering cho khớp
- Chọn: Theo ma trận quyền (nguồn duyệt quyền): chỉ owner; sửa SPEC-metering cho khớp
- Lý do (tiêu chí chất lượng cuối): Tiêu chí (1): cách hiểu chặt hơn ở quyền tiền; ma trận là nguồn duyệt quyền có test đồng bộ; mở thêm quyền sau là đổi một dòng ma trận + SPEC.
- Đường lùi: Đổi dòng pricing/service price trong MATRIX + bảng SPEC-access 5.3 thành yes cho manager.

### D-009 · 2026-10-16T03:43:18+00:00 · Duyệt PLAN đợt 3 (26 task T-201…T-226, 7 lát, 130 vòng/≤320 USD/1800 s/120 giờ)

- Phương án: (1) Duyệt như soạn · (2) Thu hẹp: chỉ F-006 + F-007, để portal/thông báo/báo cáo sang đợt 4 · (3) Dừng chờ chủ dự án duyệt
- Chọn: Duyệt như soạn
- Lý do (tiêu chí chất lượng cuối): Đủ mọi Must của pilot theo backlog chủ dự án đã chọn (PROJECT §3); mỗi task ≤ 1–2 ngày có Gate máy kiểm; đường găng tiền (check-out) tách 2 task + review lát; phụ thuộc ngoài đều có bản giả tự host; cắt phạm vi theo thứ tự PROJECT §19 nếu trễ.
- Đường lùi: Chủ dự án bỏ/đổi task trong PLAN (đánh [~] — Bỏ: lý do); task đã xong là commit riêng, revert được từng cái.

### D-010 · 2026-10-16T03:46:54+00:00 · Kênh email (notifications Q-01): adapter SMTP thật khi thư viện SMTP phổ biến nhất (nodemailer 10.1.1, 0 phụ thuộc, đã vá mọi advisory ≥ 10.0.13) mang giấy phép MIT-0 — ngoài danh sách cho phép của cổng giấy phép

- Phương án: (1) Thêm MIT-0 vào allowlist rồi dùng nodemailer ngay · (2) Tự viết client SMTP (STARTTLS, AUTH, dot-stuffing) · (3) Đợt 3 dùng interface EmailSender + FakeEmailSender (dev/CI) + contract test; adapter SMTP bằng nodemailer chờ chủ dự án duyệt thêm MIT-0 vào allowlist (loop defer)
- Chọn: Đợt 3 dùng interface EmailSender + FakeEmailSender (dev/CI) + contract test; adapter SMTP bằng nodemailer chờ chủ dự án duyệt thêm MIT-0 vào allowlist (loop defer)
- Lý do (tiêu chí chất lượng cuối): Đổi allowlist giấy phép là đổi cấu hình cổng — điểm dừng bắt buộc (AGENTS §6); tự viết SMTP có lịch sử lỗi CRLF/command injection dày (xem advisory nodemailer) — rủi ro bảo mật cao hơn lợi ích. Interface + bản giả đủ cho mọi kịch bản SPEC, đổi sang thật chỉ là thêm một adapter.
- Đường lùi: Chủ dự án duyệt MIT-0 → thêm adapter SmtpEmailSender (nodemailer ≥ 10.1.1, requireTLS) chạy cùng contract test hiện có.
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): SMTP relay tự host hoặc dịch vụ email giao dịch có DPA; nodemailer ≥ 10.1.1 với requireTLS, không opportunisticTLS.

### D-011 · 2026-10-16T03:46:54+00:00 · Cấu hình plugin emailOTP cho người thuê (sau khi xác minh GHSA-qq9h-g4jm-xgf3 pre-account hijack)

- Phương án: (1) Mặc định plugin (storeOTP plain, cho tự đăng ký) · (2) storeOTP hashed, disableSignUp=true (người thuê chỉ vào qua lời mời portal.inviteTenant), allowedAttempts 3, OTP 6 số hạn 5 phút, rateLimit 3/60 s
- Chọn: storeOTP hashed, disableSignUp=true (người thuê chỉ vào qua lời mời portal.inviteTenant), allowedAttempts 3, OTP 6 số hạn 5 phút, rateLimit 3/60 s
- Lý do (tiêu chí chất lượng cuối): Không lưu OTP rõ trong CSDL; chặn tự đăng ký loại bỏ điều kiện khai thác pre-account hijack; giữ mặc định chặt của plugin cho số lần thử.
- Đường lùi: Đổi option trong packages/app/src/auth/auth.ts.

### D-012 · 2026-10-16T06:04:35+00:00 · Cho nợ khi trả phòng: SPEC-reservation-stay S-019 cần lễ tân gửi lại kèm duyệt của quản lý, nhưng ma trận quyền ghi lễ tân '—' cho 'Check-out còn công nợ' (không lập được yêu cầu)

- Phương án: (1) Giữ ma trận: chỉ quản lý/owner tự trả phòng còn nợ · (2) Lễ tân 'Đề nghị' (lập yêu cầu allow_balance, không duyệt); quản lý/owner duyệt; check-out dùng yêu cầu đã duyệt đúng một lần, đủ số, đúng lượt ở
- Chọn: Lễ tân 'Đề nghị' (lập yêu cầu allow_balance, không duyệt); quản lý/owner duyệt; check-out dùng yêu cầu đã duyệt đúng một lần, đủ số, đúng lượt ở
- Lý do (tiêu chí chất lượng cuối): Khớp S-019 và ghi chú '(cần manager duyệt)' của chính ma trận; không mở quyền tiền nào (đề nghị không thực hiện gì), người duyệt khác người lập, dùng một lần bằng unique ở CSDL.
- Đường lùi: Đổi ô lễ tân về '—' trong MATRIX + bảng SPEC-access 5.3; yêu cầu cũ vẫn chỉ quản lý duyệt được.

### D-013 · 2026-10-16T07:51:39+00:00 · Trả phòng sớm (review lát khách sạn R1): phòng đã nhả và bán lại được nhưng mọi đêm vẫn tính tiền → REV_ROOM hai lần

- Phương án: (1) Huỷ phí phòng các đêm chưa bắt đầu (giờ nhận phòng của đêm ≥ giờ trả thực) trong cùng transaction trả phòng, luôn giữ đêm đầu; phí trả sớm/trả muộn ghi tay qua postCharge · (2) Không nhả các đêm còn lại khi vẫn tính tiền (phòng trống nhưng không bán được)
- Chọn: Huỷ phí phòng các đêm chưa bắt đầu (giờ nhận phòng của đêm ≥ giờ trả thực) trong cùng transaction trả phòng, luôn giữ đêm đầu; phí trả sớm/trả muộn ghi tay qua postCharge
- Lý do (tiêu chí chất lượng cuối): Đúng S-020 (trả sớm nhả phòng ngay) và không thu tiền đêm chưa ở; tránh ghi doanh thu hai lần cho một đêm; mốc giờ nhận phòng theo múi giờ cơ sở nên khách ở qua nửa đêm vẫn bị tính đêm đó; có audit danh sách đêm bỏ
- Đường lùi: Bỏ releaseUnusedNights trong checkout.ts; các đêm đã huỷ có void_reason 'Trả phòng sớm — đêm chưa ở' để truy
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Chủ cơ sở có thể muốn phí trả sớm tự động (vd 50% đêm kế) — đề xuất thêm cấu hình early_checkout_fee_pct ở đợt sau

### D-014 · 2026-10-16T08:18:03+00:00 · Huỷ việc dọn (review buồng phòng R6): previous_housekeeping_status là trạng thái trước khi khách ở — huỷ việc sinh từ check-out trả phòng về inspected dù chưa ai dọn

- Phương án: (1) Chỉ việc tạo tay (manual) mới khôi phục trạng thái trước; việc từ check-out/đổi phòng/sự cố/hợp đồng huỷ thì phòng giữ dirty · (2) Bắt người huỷ chọn trạng thái đích + lý do
- Chọn: Chỉ việc tạo tay (manual) mới khôi phục trạng thái trước; việc từ check-out/đổi phòng/sự cố/hợp đồng huỷ thì phòng giữ dirty
- Lý do (tiêu chí chất lượng cuối): Mặc định an toàn: không bao giờ báo phòng sẵn sàng khi chưa có người dọn/kiểm; đơn giản, không thêm trường nhập; người có quyền vẫn đánh dấu sạch qua việc dọn mới
- Đường lùi: Đổi điều kiện source_type trong setUnitStatus (housekeeping/tasks.ts)

### D-015 · 2026-10-16T09:06:20+00:00 · Mặc định nhận email thông báo khi người dùng chưa chọn (SPEC-notifications S-001 giả định 'An đã đồng ý'; không có trạng thái 'chưa chọn' trong ERD)

- Phương án: (1) Email giao dịch (phiếu thu, nhắc quá hạn, hợp đồng, sự cố, xuất dữ liệu) mặc định nhận; mọi email có liên kết huỷ đăng ký một chạm (token ký 30 ngày); loại bắt buộc account_security luôn gửi · (2) Mặc định không gửi email cho tới khi người dùng bật (opt-in tường minh)
- Chọn: Email giao dịch (phiếu thu, nhắc quá hạn, hợp đồng, sự cố, xuất dữ liệu) mặc định nhận; mọi email có liên kết huỷ đăng ký một chạm (token ký 30 ngày); loại bắt buộc account_security luôn gửi
- Lý do (tiêu chí chất lượng cuối): Đây là thông báo dịch vụ về hợp đồng/khoản phải trả của chính người nhận, không phải quảng cáo (NĐ 91/2020 điều chỉnh tin quảng cáo); opt-in tường minh khiến người thuê không nhận phiếu/nhắc — trái mục tiêu SPEC; mọi email có huỷ đăng ký một chạm + tuỳ chọn theo loại, không gửi số tiền (Q-03); pháp lý vẫn rà ở G7 (chưa xác minh văn bản gốc)
- Đường lùi: Đổi mặc định trong getPreferences + điều kiện opted_out ở send.ts thành 'không có hàng opted_in'
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Pháp lý xác nhận cơ sở gửi email giao dịch không cần đồng ý riêng; nếu cần, thu đồng ý lúc ký hợp đồng/mời portal (source=system)

### D-016 · 2026-10-16T09:37:59+00:00 · Người thuê vào portal (T-216): mời + đăng nhập OTP email (D-011 disableSignUp) mà không mở đường cho nhân viên đăng nhập bằng OTP lách mật khẩu + TOTP

- Phương án: (1) inviteTenant cấp ngay tài khoản auth (email, không mật khẩu) + membership tenant active; OTP chỉ cho tài khoản mà MỌI membership còn hiệu lực đều là tenant (kiểm ở hook + không gửi mã); tắt các luồng OTP khác (quên mật khẩu, đổi email, xác minh); hết hạn xem lại bằng trigger đặt valid_to khi hợp đồng closed · (2) Lời mời có token qua email, người thuê bấm chấp nhận mới tạo tài khoản; OTP mở cho mọi email
- Chọn: inviteTenant cấp ngay tài khoản auth (email, không mật khẩu) + membership tenant active; OTP chỉ cho tài khoản mà MỌI membership còn hiệu lực đều là tenant (kiểm ở hook + không gửi mã); tắt các luồng OTP khác (quên mật khẩu, đổi email, xác minh); hết hạn xem lại bằng trigger đặt valid_to khi hợp đồng closed
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: email chỉ được chứng minh sở hữu bằng OTP lúc đăng nhập (tương đương token mời); chặn MFA bypass cho nhân viên (cờ twoFactorEnabled vẫn true nên resolveActor không phân biệt được cách đăng nhập); ít bảng/luồng hơn; người có cả vai trò nhân viên dùng mật khẩu + TOTP cho mọi ngữ cảnh (S-012); hạn xem lại 30 ngày (Q-04) đúng ở mọi đường đóng hợp đồng
- Đường lùi: Bỏ emailOTP khỏi createAuth + hook; membership tenant vẫn dùng được với mật khẩu

### D-017 · 2026-10-16T11:17:15+00:00 · Phạm vi đọc audit và thẻ 'Hôm nay' theo vai trò (SPEC-audit-reporting S-004, S-007 để hở: 'cấp tổ chức được phép', nhóm tiền, thẻ của lễ tân/kế toán/kỹ thuật, hạn thông báo lưu trú)

- Phương án: (1) Chỉ lọc ở app; manager thấy mọi sự kiện cấp tổ chức; mọi vai trò nhân viên thấy đủ thẻ trừ tiền · (2) RLS RESTRICTIVE trên audit_events (owner toàn bộ; manager theo phạm vi + sự kiện cấp tổ chức do chính mình; accountant chỉ nhóm tiền payment/payment_claim/invoice/deposit/period/billing/ledger/reconciliation/shift/folio) + app lọc lại; thẻ theo vai trò: owner/manager đủ, lễ tân việc trong ca (không kỳ thu), kế toán công nợ + kỳ thu, buồng phòng dọn + sự cố, kỹ thuật sự cố; thông báo lưu trú chưa nộp hạn ≤ 24 giờ
- Chọn: RLS RESTRICTIVE trên audit_events (owner toàn bộ; manager theo phạm vi + sự kiện cấp tổ chức do chính mình; accountant chỉ nhóm tiền payment/payment_claim/invoice/deposit/period/billing/ledger/reconciliation/shift/folio) + app lọc lại; thẻ theo vai trò: owner/manager đủ, lễ tân việc trong ca (không kỳ thu), kế toán công nợ + kỳ thu, buồng phòng dọn + sự cố, kỹ thuật sự cố; thông báo lưu trú chưa nộp hạn ≤ 24 giờ
- Lý do (tiêu chí chất lượng cuối): Tiêu chí 1 (an toàn): cách hiểu chặt hơn cho dữ liệu nhạy cảm, quyền kiểm ở CSDL; sự kiện cấp tổ chức (mời/đổi vai trò) không lộ cho manager trừ việc của chính họ; thẻ đếm trên chính truy vấn danh sách nên số khớp
- Đường lùi: Đổi policy audit_read_by_role bằng migration mới; CARDS_BY_ROLE/RESIDENCE_NOTICE_HORIZON_HOURS ở packages/app/src/today/today.ts

### D-018 · 2026-10-16T11:38:18+00:00 · Cách tính báo cáo khi SPEC-audit-reporting để hở: ngày chốt công nợ, đối chiếu sổ, nhóm thu tiền, quyền báo cáo, mốc tính công suất

- Phương án: (1) Đọc trạng thái hiện tại của bảng nghiệp vụ, không đối chiếu sổ; quyền mới riêng cho báo cáo · (2) Mỗi báo cáo một câu SQL (một snapshot); công nợ tại ngày chốt = tổng − phân bổ có bút toán ≤ ngày chốt (chưa đảo) và trả kèm số dư AR + matchesLedger; cọc so DEPOSIT_LIAB; thu tiền chỉ confirmed theo business_date nhóm phương thức/ngày/người xác nhận; quyền = money.read mức Có (người thuê 403), công suất cho owner/manager/front_desk/accountant; công suất theo đêm lúc 23:59:59 giờ cơ sở, allocation lease/stay hiệu lực lúc đó, khả dụng trừ block; khoảng ≤ 366 ngày
- Chọn: Mỗi báo cáo một câu SQL (một snapshot); công nợ tại ngày chốt = tổng − phân bổ có bút toán ≤ ngày chốt (chưa đảo) và trả kèm số dư AR + matchesLedger; cọc so DEPOSIT_LIAB; thu tiền chỉ confirmed theo business_date nhóm phương thức/ngày/người xác nhận; quyền = money.read mức Có (người thuê 403), công suất cho owner/manager/front_desk/accountant; công suất theo đêm lúc 23:59:59 giờ cơ sở, allocation lease/stay hiệu lực lúc đó, khả dụng trừ block; khoảng ≤ 366 ngày
- Lý do (tiêu chí chất lượng cuối): Tiêu chí 1: số liệu tiền phải khớp sổ và lộ chênh lệch nếu có thay vì giấu; dùng dòng ma trận đã duyệt (Xem số tiền, folio, công nợ) thay vì tự đặt quyền mới; một câu SQL tránh đọc lệch giữa chi tiết và tổng
- Đường lùi: Sửa packages/app/src/reports/reports.ts (REPORT_MAX_DAYS, mốc 23:59:59, danh sách vai trò công suất)

### D-019 · 2026-10-16T11:57:03+00:00 · Xuất dữ liệu (SPEC-audit-reporting S-013…S-018, Q-06 đề xuất): cách xác thực lại, hạn link, nơi kiểm quyền lúc chạy, nhóm kế toán được xuất, nội dung xuất toàn tổ chức

- Phương án: (1) Hỏi lại mật khẩu bằng endpoint riêng + cờ trong phiên; worker đọc dữ liệu bằng vai trò worker; URL ký 15 phút · (2) Xác thực lại = phiên đăng nhập ≤ 5 phút (session.createdAt, như auth_time/max_age OIDC; đăng nhập lại để làm mới); worker dựng lại actor của người yêu cầu lúc chạy và đọc bằng kết nối runtime trong ngữ cảnh người đó (RLS + phạm vi; thu hồi ⇒ failed FORBIDDEN); bản xuất tải được 15 phút, URL ký ≤ 5 phút (trần MAX_SIGNED_URL_SECONDS của repo); kế toán chỉ receivables/collections/deposits; org_full chỉ owner, ZIP CSV 25 bảng nghiệp vụ, bỏ identity_documents/files/memberships và cột bí mật/băm/khoá/số giấy tờ; 10 yêu cầu/giờ/người
- Chọn: Xác thực lại = phiên đăng nhập ≤ 5 phút (session.createdAt, như auth_time/max_age OIDC; đăng nhập lại để làm mới); worker dựng lại actor của người yêu cầu lúc chạy và đọc bằng kết nối runtime trong ngữ cảnh người đó (RLS + phạm vi; thu hồi ⇒ failed FORBIDDEN); bản xuất tải được 15 phút, URL ký ≤ 5 phút (trần MAX_SIGNED_URL_SECONDS của repo); kế toán chỉ receivables/collections/deposits; org_full chỉ owner, ZIP CSV 25 bảng nghiệp vụ, bỏ identity_documents/files/memberships và cột bí mật/băm/khoá/số giấy tờ; 10 yêu cầu/giờ/người
- Lý do (tiêu chí chất lượng cuối): Tiêu chí 1: không mở đường đọc dữ liệu rộng hơn người yêu cầu (worker không BYPASS, RLS quyết), không thêm endpoint xác thực mới tự viết; giữ trần URL ký 5 phút đã chốt; tiêu chí 3: dùng thời điểm đăng nhập có sẵn của Better Auth
- Đường lùi: Hằng REAUTH_MAX_AGE_SECONDS/EXPORT_TTL_MINUTES/EXPORT_RATE_PER_HOUR/ORG_EXPORT_TABLES ở packages/app/src/exports/exports.ts; migration 0043 có down

### D-020 · 2026-10-16T12:10:46+00:00 · Lưu 'cơ sở đang chọn' của session.switchOrganization ở đâu và hạn giữ dữ liệu nhập chạy thế nào (việc treo đợt 2)

- Phương án: (1) Cookie riêng từng thiết bị cho cơ sở; xoá file bằng cách xoá hàng files · (2) Cột memberships.selected_property_id (theo người, mọi thiết bị) ghi qua hàm hẹp app.select_property kiểm phạm vi, chỉ là lựa chọn — mọi request vẫn resolveActor, ngoài phạm vi thì bỏ qua; hạn giữ: worker xoá object trước rồi đánh dấu files.status='deleted' (+deleted_at, giữ hàng để FK/audit), làm rỗng import_rows.raw/data của lô commit/huỷ quá 30 ngày theo ngày giờ cơ sở, qua hàm SECURITY DEFINER chỉ app_worker gọi
- Chọn: Cột memberships.selected_property_id (theo người, mọi thiết bị) ghi qua hàm hẹp app.select_property kiểm phạm vi, chỉ là lựa chọn — mọi request vẫn resolveActor, ngoài phạm vi thì bỏ qua; hạn giữ: worker xoá object trước rồi đánh dấu files.status='deleted' (+deleted_at, giữ hàng để FK/audit), làm rỗng import_rows.raw/data của lô commit/huỷ quá 30 ngày theo ngày giờ cơ sở, qua hàm SECURITY DEFINER chỉ app_worker gọi
- Lý do (tiêu chí chất lượng cuối): Tiêu chí 1: lựa chọn không thành quyền, kiểm phạm vi ở CSDL; giữ hàng files cho tham chiếu/audit thay vì xoá cứng; xoá object trước đánh dấu sau để chạy lại an toàn
- Đường lùi: Migration 0045 có down (file đã xoá → rejected deleted_by_retention); bỏ đọc selected_property_id trong organizationContext

### D-021 · 2026-10-16T12:18:01+00:00 · Bảo vệ /api/metrics 'chỉ nội bộ' khi chưa có môi trường thật và không thêm được biến môi trường mới (phiên không đọc được .env*)

- Phương án: (1) Thêm METRICS_TOKEN vào schema + .env.example · (2) Bearer token dẫn xuất HKDF-SHA256 (nhãn hm-metrics-v1) từ BETTER_AUTH_SECRET, so sánh thời gian hằng, sai ⇒ 401; script scripts/metrics-token.mjs in token từ môi trường; số liệu chỉ tổng hợp toàn hệ thống (không nhãn tổ chức) qua hàm SECURITY DEFINER; /api/ready trả ok/fail/timeout từng thành phần, không chi tiết lỗi
- Chọn: Bearer token dẫn xuất HKDF-SHA256 (nhãn hm-metrics-v1) từ BETTER_AUTH_SECRET, so sánh thời gian hằng, sai ⇒ 401; script scripts/metrics-token.mjs in token từ môi trường; số liệu chỉ tổng hợp toàn hệ thống (không nhãn tổ chức) qua hàm SECURITY DEFINER; /api/ready trả ok/fail/timeout từng thành phần, không chi tiết lỗi
- Lý do (tiêu chí chất lượng cuối): Tiêu chí 1–3: không bí mật mới cần quản lý, không lộ dữ liệu tổ chức qua nhãn metric, theo mẫu khoá dẫn xuất đã có (huỷ đăng ký email); không đụng file .env* bị chặn
- Đường lùi: Đổi metricsAuthorized sang so với METRICS_TOKEN riêng khi chủ dự án duyệt; migration 0046 có down
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Chặn /api/metrics ở reverse proxy chỉ cho IP Prometheus nội bộ; cân nhắc METRICS_TOKEN riêng để xoay độc lập với bí mật phiên

### D-022 · 2026-10-16T13:22:41+00:00 · Rà blueprint đợt 3 (T-226): xử lý 373 MUST còn mở — miễn trừ nào chấp nhận, khoảng trống trong repo làm ngay hay để đợt sau

- Phương án: (1) Làm ngay mọi khoảng trống nhỏ trong đợt 3 (mở rộng phạm vi PLAN) · (2) Tick 48 mục đạt có bằng chứng file git/CI (bỏ tham chiếu không được git theo dõi), chấp nhận 18 miễn trừ có dữ kiện + điều kiện mở lại, loop defer 46 mục cần người/production, lập docs/autopilot/BLUEPRINT-GAPS.md cho 261 mục thiếu làm đề xuất PLAN đợt 4
- Chọn: Tick 48 mục đạt có bằng chứng file git/CI (bỏ tham chiếu không được git theo dõi), chấp nhận 18 miễn trừ có dữ kiện + điều kiện mở lại, loop defer 46 mục cần người/production, lập docs/autopilot/BLUEPRINT-GAPS.md cho 261 mục thiếu làm đề xuất PLAN đợt 4
- Lý do (tiêu chí chất lượng cuối): Tiêu chí 2–3: không phình phạm vi đợt đã duyệt (D-009), giữ minh bạch — GO-NO-GO ghi NO-GO đúng thực tế; nhiều khoảng trống cần quyết của chủ dự án (giấy phép, kênh báo lỗ hổng, pháp lý)
- Đường lùi: Mục [x]/[~] đổi lại [ ] bằng một commit; danh sách thiếu chỉ là đề xuất

### D-023 · 2026-10-16T13:38:29+00:00 · Đợt 4: 261 mục MUST còn thiếu (BLUEPRINT-GAPS.md) — làm gì trong repo, phần nào là điểm dừng của người, sắp lát thế nào?

- Phương án: (1) Làm mọi mục, kể cả sửa workflow CI/cấu hình cổng (coverage, forbidOnly, biome rule, Lighthouse, SAST, SBOM) ngay trong đợt · (2) Chỉ làm mục sửa được trong mã/tài liệu/test mà không đổi cấu hình cổng-CI-hook (bộ kiểm mới viết thành test chạy trong pnpm test sẵn có); cấu hình cổng/CI/hook, giấy phép, kênh SECURITY, pháp lý (DSAR/đồng ý), analytics → loop defer có đề xuất sẵn · (3) Dừng đợt 3, bàn giao 261 mục cho người
- Chọn: Chỉ làm mục sửa được trong mã/tài liệu/test mà không đổi cấu hình cổng-CI-hook (bộ kiểm mới viết thành test chạy trong pnpm test sẵn có); cấu hình cổng/CI/hook, giấy phép, kênh SECURITY, pháp lý (DSAR/đồng ý), analytics → loop defer có đề xuất sẵn
- Lý do (tiêu chí chất lượng cuối): (1) đúng và an toàn: AGENTS §6 coi đổi cấu hình cổng/CI/hook là điểm dừng bắt buộc — phương án 1 vi phạm; worker hiện chưa chạy thật (main chỉ in thông báo) và chưa xử lý SIGTERM là lỗi đúng-sai nên phải làm trước. (2) giữ đường lùi: DSAR/đồng ý phụ thuộc cơ sở pháp lý từng hoạt động xử lý (DPIA chờ người) — làm data map trước để người quyết. (3) kiểm máy được: rào mới viết thành test vitest/unittest nên chạy ngay trong cổng hiện có mà không đổi cấu hình. Phương án 3 bỏ việc làm được.
- Đường lùi: Mỗi lát một PR riêng (7 runtime, 8 tài liệu/hồ sơ, 9 UX); bỏ lát nào thì revert PR đó; mục đã defer vẫn có đề xuất trong BLUEPRINT-GAPS.md để người bật sau.

### D-024 · 2026-10-16T14:21:42+00:00 · T-301: pg-boss tự dựng schema pgboss nên app_worker cần quyền CREATE trên database — cấp quyền thế nào?

- Phương án: (1) GRANT CREATE ON DATABASE cho app_worker (sửa bootstrap-roles.sql) · (2) Migration 0047 tạo sẵn schema pgboss AUTHORIZATION app_worker bằng vai trò owner; app_worker chỉ có quyền trong schema đó · (3) Chạy pg-boss bằng vai trò owner
- Chọn: Migration 0047 tạo sẵn schema pgboss AUTHORIZATION app_worker bằng vai trò owner; app_worker chỉ có quyền trong schema đó
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: quyền tối thiểu — app_worker không được tạo schema tuỳ ý trong database (CREATE ON DATABASE cho phép tạo schema bất kỳ, kể cả che search_path); vai trò owner trong worker trái nguyên tắc NOBYPASSRLS. (3) đơn giản: một migration có đường lùi (DROP SCHEMA khi down chỉ nếu rỗng).
- Đường lùi: Migration down xoá schema pgboss nếu rỗng; đổi sang phương án 1 bằng một GRANT.

### D-025 · 2026-10-16T14:21:42+00:00 · T-303: đưa quét clamd + storage.put (và ghi file export) ra ngoài transaction lệnh, dọn object mồ côi thế nào?

- Phương án: (1) A: dòng files staging pending_scan (transaction ngắn) → quét + put ngoài transaction → transaction lệnh chuyển ready/rejected; id/key suy từ Idempotency-Key; job hạn giữ dọn pending_scan quá hạn (migration 0047 sửa hàm hạn giữ) · (2) B: put trước transaction, xoá bù trong finally; sập tiến trình để lại object mồ côi, cần job quét bucket · (3) C: chỉ đưa bước quét ra ngoài, giữ put trong transaction
- Chọn: A: dòng files staging pending_scan (transaction ngắn) → quét + put ngoài transaction → transaction lệnh chuyển ready/rejected; id/key suy từ Idempotency-Key; job hạn giữ dọn pending_scan quá hạn (migration 0047 sửa hàm hạn giữ)
- Lý do (tiêu chí chất lượng cuối): (1) đúng và an toàn: retry S3 (T-302) có thể kéo put tới ~60 s > idle_in_transaction_session_timeout 30 s của app_runtime — C và hiện trạng làm Postgres cắt kết nối giữa lệnh; B để lại object mồ côi không ai dọn khi sập. A có bản ghi DB cho mọi object nên job hạn giữ dọn được, replay idempotent. (3) dùng trạng thái pending_scan đã có trong CHECK; áp cho cả export ở worker.
- Đường lùi: Revert commit T-303 + migration down 0047 (khôi phục hàm hạn giữ của 0045); luồng cũ vẫn chạy được.

### D-026 · 2026-10-16T14:21:42+00:00 · T-301: sự kiện outbox chưa có consumer — giữ ở hàng đợi hay đánh dấu đã phát? (sửa theo review lát 7)

- Phương án: (1) Đánh dấu đã phát không sinh job cho MỌI event_type không consumer (consumer thêm sau/worker khác không nhận sự kiện cũ — sự kiện có thể MẤT khi triển khai lệch phiên bản) · (2) Tạo queue lười cho mọi event_type, job chất đống trong pgboss.job tới khi có consumer · (3) Để nguyên ở outbox không lùi (chặn đầu hàng vì claim lấy cũ nhất trước) · (4) Chỉ bỏ qua có chủ đích loại khai tường minh "chỉ để audit"; loại khác không consumer ⇒ không đánh dấu đã phát, `last_error = 'no_consumer'`, lùi lần thử (`outbox.available_at`, backoff trong `app.outbox_mark`), log `outbox.no_consumer`
- Chọn: (4). Bản đầu chọn (1) — sửa theo review lát 7: (1) làm mất sự kiện khi hai worker lệch phiên bản (worker không có handler đánh dấu đã phát hàng mà worker kia đáng lẽ xử lý) và không để lại dấu vết
- Lý do (tiêu chí chất lượng cuối): (1) đúng và an toàn: không mất sự kiện, hàng chưa xử lý còn đó để worker có consumer nhận và để cảnh báo `hm_outbox_unpublished`/`hm_outbox_oldest_unpublished_age_seconds`/`hm_outbox_failing` thấy. (3) bền: danh sách audit-only là hằng có comment (`AUDIT_ONLY_EVENT_TYPES`, `apps/worker/src/relay.ts`) + test quét mã chặn thêm event_type mà quên cả consumer lẫn khai báo; lùi `available_at` (migration 0047, chưa merge) giữ claim "cũ nhất trước" không kẹt đầu hàng; lỗi gửi pg-boss cũng được lùi (trước đó thử lại mỗi nhịp). Phương án 2 tích job không giới hạn.
- Đường lùi: Migration 0047 down khôi phục `outbox_claim/outbox_mark` của 0003 và bỏ cột `available_at`; thêm event_type vào danh sách audit-only để dọn hàng `no_consumer` cũ (được đánh dấu đã phát ở lượt kế).

### D-027 · 2026-10-16T14:28:08+00:00 · roomType.create/update luôn 422 vì idempotency_keys.command CHECK '^[a-z_]+(\.[a-zA-Z_]+)+$' (0003) không nhận đoạn đầu có chữ hoa — sửa tên lệnh hay nới CHECK?

- Phương án: (1) Đổi tên lệnh thành room_type.create/update (khớp quy ước snake_case đoạn đầu của mọi lệnh khác + tên bảng room_types), thêm test mọi lệnh registry khớp CHECK · (2) Migration mới nới regex CHECK cho phép camelCase đoạn đầu
- Chọn: Đổi tên lệnh thành room_type.create/update (khớp quy ước snake_case đoạn đầu của mọi lệnh khác + tên bảng room_types), thêm test mọi lệnh registry khớp CHECK
- Lý do (tiêu chí chất lượng cuối): (1) đúng: mọi lệnh khác đều snake_case đoạn đầu; chưa client nào gọi roomType.* (UI chưa có màn loại phòng, lệnh luôn lỗi) nên đổi tên không phá ai. (3) đơn giản: không đụng schema; test registry ↔ CHECK chặn tái phát.
- Đường lùi: Đổi lại tên trong registry + chạy pnpm openapi.

### D-028 · 2026-10-16T15:18:24+00:00 · Đợt 5: 115 MUST còn thiếu làm được trong repo — phạm vi, thứ tự, cách chia lát?

- Phương án: (1) Làm hết 115 trong một đợt 13 task, 3 lát (runtime/bảo mật, dữ liệu/CSDL/kiến trúc, UX/tài liệu), mục cần CI/người/pháp lý/hạ tầng đã defer · (2) Dừng ở đợt 4, bàn giao 115 mục · (3) Chỉ làm mục bảo mật/đúng-sai, để UX/tài liệu cho người
- Chọn: Làm hết 115 trong một đợt 13 task, 3 lát (runtime/bảo mật, dữ liệu/CSDL/kiến trúc, UX/tài liệu), mục cần CI/người/pháp lý/hạ tầng đã defer
- Lý do (tiêu chí chất lượng cuối): (1) đúng và an toàn: còn lỗi thật (relay gửi trong transaction, web chưa dừng êm, ma trận quyền chưa phủ toàn registry) nằm trong nhóm này — dừng là để lại rủi ro biết trước. (3) mọi mục có Gate máy kiểm; ngân sách còn (vòng 19/130). Phương án 3 bỏ việc làm được.
- Đường lùi: Mỗi lát một PR; bỏ lát nào thì revert PR đó.

### D-029 · 2026-10-16T16:17:33+00:00 · T-403: cookie phiên Better Auth dùng tiền tố __Host- (khi https) thay __Secure-?

- Phương án: (1) __Host-hm.session_token: Secure, Path=/, không Domain (cookiePrefix + defaultCookieAttributes) · (2) Giữ __Secure- mặc định
- Chọn: __Host-hm.session_token: Secure, Path=/, không Domain (cookiePrefix + defaultCookieAttributes)
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: __Host- chặn subdomain/đường dẫn khác ghi đè cookie phiên (cookie tossing) — chuẩn OWASP cho cookie phiên; Better Auth 1.7.9 hỗ trợ sạch, có test db. Hệ quả: đổi APP_BASE_URL http↔https làm mất phiên cũ (đã ghi RUNBOOK §8b) — chấp nhận được vì chưa có production.
- Đường lùi: Bỏ cookiePrefix/defaultCookieAttributes trong auth.ts; người dùng đăng nhập lại một lần.

### D-030 · 2026-10-16T16:17:34+00:00 · T-404: 4 truy vấn (report.financialSummary, reconciliation.previewMatches, payment.listClaims, notifications.listDeliveries) nhận bộ lọc/id của tổ chức khác trả 200 rỗng — đổi sang 404?

- Phương án: (1) Giữ 200 rỗng (RLS lọc, không lộ dữ liệu; test khẳng định rỗng/0), ghi ngoại lệ có lý do · (2) Đổi sang 404 khi bộ lọc không thuộc tổ chức/phạm vi
- Chọn: Đổi sang 404 khi bộ lọc không thuộc tổ chức/phạm vi
- Lý do (tiêu chí chất lượng cuối): (1) đúng: quy ước dự án (SPEC-access-and-property, exports, reports) là cơ sở/đối tượng ngoài phạm vi ⇒ 404; 200 rỗng khiến người dùng tưởng không có dữ liệu thay vì sai cơ sở và là ngoại lệ phải nhớ. (3) thống nhất, test được bằng ma trận. Không lộ dữ liệu ở cả hai cách nên đổi rủi ro thấp.
- Đường lùi: Bỏ kiểm phạm vi bộ lọc ở 4 truy vấn; ma trận đưa lại vào ngoại lệ.

### D-031 · 2026-10-16T16:23:35+00:00 · T-410: thư viện Argon2id cho mật khẩu (Better Auth password.hash/verify)?

- Phương án: (1) node:crypto argon2 dựng sẵn (Node ≥ 24.7; dự án ghim 24.22) + tự mã hoá chuỗi PHC $argon2id$v=19$m=19456,t=2,p=1$… và so sánh timingSafeEqual; băm scrypt cũ verify bằng hàm mặc định của Better Auth rồi băm lại khi đăng nhập · (2) @node-rs/argon2 2.2.2 (MIT, 0 dependency, binary napi dựng sẵn, có PHC + verify) · (3) argon2 (node-argon2) 0.45.1 (MIT, install script node-gyp-build)
- Chọn: node:crypto argon2 dựng sẵn (Node ≥ 24.7; dự án ghim 24.22) + tự mã hoá chuỗi PHC $argon2id$v=19$m=19456,t=2,p=1$… và so sánh timingSafeEqual; băm scrypt cũ verify bằng hàm mặc định của Better Auth rồi băm lại khi đăng nhập
- Lý do (tiêu chí chất lượng cuối): (1) an toàn chuỗi cung ứng: không thêm binary native/install script của bên thứ ba vào luồng xác thực; crypto.argon2 có trong Node 24 LTS, docs không đánh dấu experimental (nguồn nodejs.org/docs/latest-v24.x, 2026-10-16). Tham số OWASP m=19456 KiB, t=2, p=1 (cheatsheet, 2026-10-16). Phần tự viết chỉ là mã hoá/giải mã PHC + so sánh hằng thời gian — nhỏ, test được bằng vector. (3) ít phụ thuộc. Phương án 2 hợp lệ nếu crypto.argon2 có vấn đề.
- Đường lùi: Đổi hàm hash/verify sang @node-rs/argon2 (cùng định dạng PHC nên băm đã lưu vẫn verify được).

### D-032 · 2026-10-16T16:30:49+00:00 · T-411: loading.tsx ở nhóm route có [id]/notFound làm 404/500 thành HTTP 200 (streaming) — đặt loading ở đâu?

- Phương án: (1) A: chỉ nhóm danh sách thuần (thu-tien, su-co, doi-soat, thong-bao, thong-bao-luu-tru); error.tsx mọi nhóm; test chặn loading ở nhóm có [id]/notFound · (2) B: loading mọi nhóm, chấp nhận 404/500 thành 200 · (3) C: chuyển trang danh sách vào route group (danh-sach) để có loading mà [id] không bị bọc
- Chọn: A: chỉ nhóm danh sách thuần (thu-tien, su-co, doi-soat, thong-bao, thong-bao-luu-tru); error.tsx mọi nhóm; test chặn loading ở nhóm có [id]/notFound
- Lý do (tiêu chí chất lượng cuối): (1) đúng: mã trạng thái HTTP đúng (404/500) là hợp đồng với client, metric SLO (T-406) và bảo mật (không lộ tồn tại qua 200); B phá điều đó. (3) đơn giản: C đổi cấu trúc file nhiều route để đổi lấy skeleton — lợi ích UX nhỏ so với rủi ro; A có rào test.
- Đường lùi: Thêm loading.tsx theo C khi cần skeleton cho trang chi tiết.

### D-033 · 2026-10-17T02:06:15+00:00 · Xuất toàn tổ chức (S-018, IND-SAAS-007): nhúng file đính kèm nào? SPEC S-018/Q-05 ghi 'không gồm file ảnh và số giấy tờ', blueprint IND-SAAS-007 đòi dữ liệu xuất được đầy đủ

- Phương án: (1) Allowlist owner_type không chứa số giấy tờ: work_order, handover, meter_reading, task, payment_claim, lease_settlement; loại identity_document, residence_notice, import_batch, export_job (danh sách trong MANIFEST kèm lý do); cập nhật SPEC S-018/Q-05 · (2) Không nhúng file nào (giữ S-018 cũ), IND-SAAS-007 để mở · (3) Nhúng mọi file ready, chỉ loại identity_document (hiện trạng — lộ CCCD qua residence_notice/import_batch)
- Chọn: Allowlist owner_type không chứa số giấy tờ: work_order, handover, meter_reading, task, payment_claim, lease_settlement; loại identity_document, residence_notice, import_batch, export_job (danh sách trong MANIFEST kèm lý do); cập nhật SPEC S-018/Q-05
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: số giấy tờ chỉ đi ra qua luồng thông báo lưu trú có kiểm soát; allowlist đóng mặc định (owner_type mới không tự lọt). Q-05 cấm số giấy tờ — ảnh công tơ/sự cố/biên bản không chứa số giấy tờ nên cho phép theo đúng mục đích quyền mang dữ liệu đi (IND-SAAS-007). (2) đường lùi: một hằng số.
- Đường lùi: Đặt allowlist rỗng ⇒ quay về không nhúng file.

### D-034 · 2026-10-17T02:23:29+00:00 · BE-API-008/ARC-INT-002: cùng Idempotency-Key khác payload hiện trả 409 IDEMPOTENCY_CONFLICT; chuẩn khung và draft IETF httpapi-idempotency-key-header đòi 422

- Phương án: (1) Đổi sang 422 (giữ code IDEMPOTENCY_CONFLICT), cập nhật API-CONTRACT/OpenAPI/test; client xử lý theo code nên không vỡ · (2) Giữ 409, miễn trừ BE-API-008 có lý do
- Chọn: Đổi sang 422 (giữ code IDEMPOTENCY_CONFLICT), cập nhật API-CONTRACT/OpenAPI/test; client xử lý theo code nên không vỡ
- Lý do (tiêu chí chất lượng cuối): (3) theo chuẩn: draft IETF (httpapi-idempotency-key-header) ghi 422 khi tái dùng khoá với payload khác (chưa xác minh lại bản mới nhất — ghi nguồn khi sửa); use-command.ts xử lý theo code IDEMPOTENCY_CONFLICT chứ không theo status nên không vỡ client; chưa có client ngoài.
- Đường lùi: Đổi lại status 409 ở một chỗ (pipeline/problem.ts).

### D-035 · 2026-10-17T02:23:29+00:00 · DB-MODEL-004: ~240 FK mặc định NO ACTION (không ghi hành động) + 74 FK thiếu index trong nền — làm tường minh thế nào?

- Phương án: (1) Migration mới: đổi FK NO ACTION không DEFERRABLE sang ON DELETE RESTRICT (cùng ngữ nghĩa khi không trì hoãn); FK DEFERRABLE giữ NO ACTION + ghi danh sách ngoại lệ có lý do trong rào; thêm index cho FK còn thiếu trừ nhóm có lý do (cột người thao tác bảng ít xoá) — rào ratchet về 0 hoặc ngoại lệ tường minh · (2) Miễn trừ DB-MODEL-004 · (3) Viết lại toàn bộ FK kể cả DEFERRABLE thành RESTRICT
- Chọn: Migration mới: đổi FK NO ACTION không DEFERRABLE sang ON DELETE RESTRICT (cùng ngữ nghĩa khi không trì hoãn); FK DEFERRABLE giữ NO ACTION + ghi danh sách ngoại lệ có lý do trong rào; thêm index cho FK còn thiếu trừ nhóm có lý do (cột người thao tác bảng ít xoá) — rào ratchet về 0 hoặc ngoại lệ tường minh
- Lý do (tiêu chí chất lượng cuối): (1) đúng: RESTRICT và NO ACTION chỉ khác khi FK trì hoãn được — đổi phần không trì hoãn giữ nguyên hành vi, làm hành động tường minh trong catalog; phương án 3 phá FK DEFERRABLE đang dựa vào kiểm cuối transaction. (3) kiểm máy được bằng catalog.
- Đường lùi: Down của migration đổi lại NO ACTION (danh sách FK ghi cố định trong tệp migration 0051 — down chỉ hoàn nguyên đúng các FK đó), drop index đã thêm.
- Ghi chú 2026-10-17 (T-610): nhóm A đã có index ở migration 0060 (`0060_fk_operator_indexes`); rào schema-guards không còn danh sách ngoại lệ FK thiếu index.

### D-036 · 2026-10-17T02:24:00+00:00 · Đợt 6: 26 MUST còn thiếu làm được trong repo — làm hết hay dừng?

- Phương án: (1) Làm hết trong 8 task T-501…T-508 (cùng luật D-023) · (2) Dừng, bàn giao 26 mục
- Chọn: Làm hết trong 8 task T-501…T-508 (cùng luật D-023)
- Lý do (tiêu chí chất lượng cuối): (1) đúng/an toàn: gồm rào transaction, retry có jitter, FK tường minh, sự kiện bảo mật còn thiếu — lỗi tiềm ẩn thật; (3) mỗi mục có Gate máy; ngân sách còn (vòng 33/130).
- Đường lùi: Mỗi task một commit; revert theo task.

### D-037 · 2026-10-17T04:44:22+00:00 · T-504: hạn mức tần suất upload/webhook (BE-REL-006) — giá trị và kiểu cửa sổ?

- Phương án: (1) Cửa sổ cố định 60 s trong Postgres (khoá advisory): upload 30/phút/thành viên + 120/phút/tổ chức, import 10/30, webhook đã xác thực 600/phút/tài khoản, chữ ký sai 300/phút/nhà cung cấp; hằng số trong rate-limit.ts · (2) Cửa sổ trượt (log từng lượt) — chặt hơn ở ranh giới nhưng ghi nhiều hàng hơn · (3) Thêm biến môi trường cấu hình hạn mức
- Chọn: Cửa sổ cố định 60 s trong Postgres (khoá advisory): upload 30/phút/thành viên + 120/phút/tổ chức, import 10/30, webhook đã xác thực 600/phút/tài khoản, chữ ký sai 300/phút/nhà cung cấp; hằng số trong rate-limit.ts
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: chặn trước khi đọc thân/quét/ghi object, bộ đếm chung giữa mọi tiến trình (test hai pool), lượt từ chối không tăng bộ đếm; ranh giới lọt tối đa 2× trong thời gian ngắn là chấp nhận được cho chống lạm dụng. (2) đường lùi: đổi hằng số. (3) không thêm biến môi trường (không cập nhật được .env.example).
- Đường lùi: Đổi hằng trong packages/app/src/http/rate-limit.ts; muốn cửa sổ trượt thì thay hàm app.rate_limit_hit bằng migration mới.

### D-038 · 2026-10-17T05:09:16+00:00 · T-502: jitter cho lịch gửi lại email (ARC-RES-002) — full jitter hay cộng thêm?

- Phương án: (1) Cộng thêm tối đa 20% (thực tế ∈ [mốc, 1,2·mốc]) — không bao giờ sớm hơn lịch Q-05 · (2) Full jitter [0, mốc] — rải đều hơn nhưng có thể gửi lại sớm hơn lịch đã hứa
- Chọn: Cộng thêm tối đa 20% (thực tế ∈ [mốc, 1,2·mốc]) — không bao giờ sớm hơn lịch Q-05
- Lý do (tiêu chí chất lượng cuối): (1) đúng: giữ lịch Q-05 (1/5/30/120/360 phút) đã ghi trong SPEC; vẫn tránh dồn cùng thời điểm. (3) đơn giản, một hằng RETRY_JITTER_RATIO.
- Đường lùi: Đổi RETRY_JITTER_RATIO hoặc spreadDelayMs trong notifications.

### D-039 · 2026-10-17T05:09:16+00:00 · T-505: số ngày giữ bảng sự kiện (XC-GREEN-007) khi DPIA chưa có?

- Phương án: (1) outbox đã phát 90 ngày; idempotency xoá khi hết hạn; deliveries sent/suppressed 90 ngày, failed/dead 180 ngày; audit không xoá · (2) outbox 30 ngày (sát cửa sổ dedupe 30 ngày của nhắc hợp đồng) · (3) 180 ngày cho tất cả
- Chọn: outbox đã phát 90 ngày; idempotency xoá khi hết hạn; deliveries sent/suppressed 90 ngày, failed/dead 180 ngày; audit không xoá
- Lý do (tiêu chí chất lượng cuối): (1) đúng: lớn hơn mọi cửa sổ dedupe/điều tra hiện có, không xoá hàng chưa phát/chưa xong, audit giữ nguyên. (2) đường lùi: hằng trong retention/policy.ts + tài liệu RET-01…10 có test đồng bộ; DPIA quyết số cuối.
- Đường lùi: Đổi hằng trong packages/app/src/retention/policy.ts và docs/ops/retention-policy.md.
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Chủ dự án + pháp lý chốt số ngày giữ theo DPIA (RK-019).

### D-040 · 2026-10-17T07:25:15+00:00 · T-507: Problem gợi ý phòng thay thế — trường riêng 'alternatives' (SPEC-inventory S-002) hay dùng chung 'items' như reservation.hold?

- Phương án: (1) Giữ cả hai: 'alternatives' cho allocation.createHold đúng spec, 'items' là danh sách chung (BLOCK_CONFLICT, reservation.hold); ghi API-CONTRACT · (2) Thống nhất về 'items' và sửa SPEC-inventory
- Chọn: Giữ cả hai: 'alternatives' cho allocation.createHold đúng spec, 'items' là danh sách chung (BLOCK_CONFLICT, reservation.hold); ghi API-CONTRACT
- Lý do (tiêu chí chất lượng cuối): (1) đúng spec đã ghi, không đổi hợp đồng reservation.hold đang có client dùng; (3) hai trường có kiểu khác nhau rõ ràng, tài liệu hoá trong API-CONTRACT §2.
- Đường lùi: Đổi createHold trả 'items' và sửa S-002 + API-CONTRACT.

### D-041 · 2026-10-17T08:39:48+00:00 · T-508: tick các mục MUST chỉ đạt một phần (UX-STATE-001 không có Storybook; DB-MODEL-004 còn 52 FK nhóm A thiếu index là ngoại lệ D-035 trong khi Kiểm đòi đỏ khi > 0; XC-GREEN-007 chưa khớp pháp lý vì DPIA chưa có; DB-PERF-001 EXPLAIN không ANALYZE)?

- Phương án: (1) Chặt: bỏ tick UX-STATE-001, DB-MODEL-004, XC-GREEN-007 (đạt một phần, ghi GAPS); giữ DB-PERF-001 vì Kiểm chỉ đòi file explain + test chặn Seq Scan, đã đủ · (2) Giữ cả 4 tick kèm lưu ý
- Chọn: Chặt: bỏ tick UX-STATE-001, DB-MODEL-004, XC-GREEN-007 (đạt một phần, ghi GAPS); giữ DB-PERF-001 vì Kiểm chỉ đòi file explain + test chặn Seq Scan, đã đủ
- Lý do (tiêu chí chất lượng cuối): (1) đúng và an toàn: luật bằng chứng — tick chỉ khi Kiểm đạt đủ; cách hiểu chặt hơn. (2) đường lùi: tick lại khi có Storybook/index nhóm A/DPIA.
- Đường lùi: Đổi [ ] thành [x] ở 3 dòng BLUEPRINT.md.

### D-042 · 2026-10-17T09:05:05+00:00 · Đợt 7: 8 MUST còn mở làm được trong repo + 26 S-NNN của spec đã Approved chưa có tính năng — làm hết hay dừng ở done-pending-human?

- Phương án: (1) Làm hết theo T-601…T-610 (đề xuất T-508), mỗi nhóm một PR, cùng luật merge từng lát · (2) Dừng: đưa vào báo cáo cho người
- Chọn: Làm hết theo T-601…T-610 (đề xuất T-508), mỗi nhóm một PR, cùng luật merge từng lát
- Lý do (tiêu chí chất lượng cuối): (1) đúng: spec đã Approved là ý định đã ghi (org.create, member.invite, tồn…) — thiếu là lỗi sản phẩm, không phải phạm vi mới; D-036 làm hết; còn ngân sách (36/130 vòng, hạn 2026-10-21).
- Đường lùi: Bỏ task chưa làm khỏi PLAN, ghi vào BLUEPRINT-GAPS.

### D-043 · 2026-10-17T09:05:05+00:00 · BE-API-008: request đồng thời cùng Idempotency-Key khi lần đầu chưa commit — 409 ngay hay chờ khoá rồi replay?

- Phương án: (1) 409 IDEMPOTENCY_IN_PROGRESS (Retry-After 1) khi hàng in_progress chưa commit — theo draft IETF httpapi-idempotency-key-header và Kiểm của mục · (2) Giữ chờ-rồi-replay (đúng 1 hiệu lực) và sửa mục
- Chọn: 409 IDEMPOTENCY_IN_PROGRESS (Retry-After 1) khi hàng in_progress chưa commit — theo draft IETF httpapi-idempotency-key-header và Kiểm của mục
- Lý do (tiêu chí chất lượng cuối): (1) đúng chuẩn đã ghi trong blueprint; không giữ kết nối CSDL chờ khoá (pool ≤ 20); client đã xử lý theo code + Retry-After. (2) đường lùi một nhánh trong pipeline.
- Đường lùi: Bỏ nhánh 409, quay lại chờ khoá advisory.

### D-044 · 2026-10-17T09:05:05+00:00 · UX-STATE-001 đòi Storybook 4 story/component; dự án dùng Server Component, 4 trạng thái theo route đã có rào máy (route-states.test.mjs) + E2E — thêm Storybook hay miễn?

- Phương án: (1) Miễn [~] có lý do + điều kiện mở lại (khi có thư viện component client dùng chung); giữ rào route-states làm kiểm tương đương · (2) Thêm Storybook (phụ thuộc dev lớn, RSC còn thử nghiệm)
- Chọn: Miễn [~] có lý do + điều kiện mở lại (khi có thư viện component client dùng chung); giữ rào route-states làm kiểm tương đương
- Lý do (tiêu chí chất lượng cuối): (3) đơn giản, không thêm phụ thuộc lớn cho kiểm đã có máy tương đương; (2) đường lùi: thêm Storybook sau. Miễn cần chủ dự án xác nhận cùng các miễn trừ khác.
- Đường lùi: Bỏ [~], thêm Storybook + script đếm story.

### D-045 · 2026-10-17T10:56:14+00:00 · S-025: lễ tân chưa mở/đã đóng ca xác nhận tiền mặt của chính mình — SPEC-access S-025 đòi 403 FORBIDDEN, SPEC-ledger-payments S-028 + mã trả 409 SHIFT_NOT_OPEN

- Phương án: (1) Giữ 409 SHIFT_NOT_OPEN, sửa SPEC-access S-025 (lần 3) cho khớp + test gắn S-025 · (2) Đổi sang 403 FORBIDDEN theo SPEC-access, sửa ledger S-028 + test + API
- Chọn: Giữ 409 SHIFT_NOT_OPEN, sửa SPEC-access S-025 (lần 3) cho khớp + test gắn S-025
- Lý do (tiêu chí chất lượng cuối): (1) đúng: thiếu ca là trạng thái nghiệp vụ, không phải thiếu quyền — 403 làm lẫn hai nghĩa; mã đã nhất quán ở deposit/settlement/payment. (3) chỉ sửa tài liệu + một test.
- Đường lùi: Đổi payment.confirm trả 403 khi không có ca mở, sửa S-028.

### D-046 · 2026-10-17T11:04:47+00:00 · T-604: tên sự kiện giữ chỗ — spec §9 ghi allocation.hold_created, mã phát allocation.held

- Phương án: (1) Sửa SPEC-inventory §9 thành allocation.held (khớp mã, không đụng sự kiện đã phát) · (2) Đổi mã thành allocation.hold_created (cần chuyển sự kiện cũ trong outbox)
- Chọn: Sửa SPEC-inventory §9 thành allocation.held (khớp mã, không đụng sự kiện đã phát)
- Lý do (tiêu chí chất lượng cuối): (3) đơn giản, không migrate dữ liệu; chưa có consumer ngoài phụ thuộc tên cũ.
- Đường lùi: Đổi tên trong mã + AUDIT_ONLY_EVENT_TYPES.

### D-047 · 2026-10-17T11:04:47+00:00 · T-604: resizeAllocation đang là lệnh HTTP cho manager nhưng không đồng bộ booking/hợp đồng/giá/folio

- Phương án: (1) Hàm nội bộ, không đăng ký registry — chỉ lệnh nghiệp vụ (đổi ngày booking/gia hạn lượt ở/phụ lục) gọi; sửa SPEC-inventory §5 · (2) Giữ lệnh HTTP cho manager
- Chọn: Hàm nội bộ, không đăng ký registry — chỉ lệnh nghiệp vụ (đổi ngày booking/gia hạn lượt ở/phụ lục) gọi; sửa SPEC-inventory §5
- Lý do (tiêu chí chất lượng cuối): (1) an toàn dữ liệu: lệnh rời làm allocation lệch booking/folio (tiền); quyền và đồng bộ thuộc lệnh nghiệp vụ sở hữu. (2) đường lùi: đăng ký lại khi có nhu cầu.
- Đường lùi: Đăng ký lại inventory.resizeAllocation trong registry + authz-matrix.

### D-048 · 2026-10-17T11:04:47+00:00 · T-604: truy cập cơ sở khác trong cùng tổ chức — SPEC-inventory §3 ghi 403, quy ước authorize trả 404

- Phương án: (1) Giữ 404 NOT_FOUND (không lộ sự tồn tại tài nguyên ngoài phạm vi, D-030), sửa SPEC-inventory §3 · (2) Đổi sang 403 theo spec
- Chọn: Giữ 404 NOT_FOUND (không lộ sự tồn tại tài nguyên ngoài phạm vi, D-030), sửa SPEC-inventory §3
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: thống nhất với quy ước toàn hệ thống và API-CONTRACT (404 cho ngoài phạm vi); 403 chỉ khi đọc được tài nguyên nhưng không được thao tác.
- Đường lùi: Trả 403 ở authorize cho inventory.

### D-049 · 2026-10-17T11:37:45+00:00 · housekeeping S-016: bộ bỏ EXIF xoá cả Orientation — ảnh dọc hiển thị lệch chiều

- Phương án: (1) Giữ thẻ Orientation: dựng lại APP1/eXIf/EXIF tối thiểu chỉ chứa Orientation từ giá trị gốc (lỗi parse ⇒ bỏ hẳn), không GPS/model/thời điểm; test Orientation 6 và 8 · (2) Xoay điểm ảnh rồi Orientation=1 (cần thư viện decode/encode mới) · (3) Lưu orientation ở cột CSDL, xoay bằng CSS (ảnh tải xuống vẫn lệch)
- Chọn: Giữ thẻ Orientation: dựng lại APP1/eXIf/EXIF tối thiểu chỉ chứa Orientation từ giá trị gốc (lỗi parse ⇒ bỏ hẳn), không GPS/model/thời điểm; test Orientation 6 và 8
- Lý do (tiêu chí chất lượng cuối): (1) đúng + an toàn: bản phục vụ hiển thị đúng chiều, không giữ metadata nhận dạng; (3) không thêm phụ thuộc, pixel không đổi.
- Đường lùi: Quay về bỏ toàn bộ APP1 trong stripJpeg.

### D-050 · 2026-10-17T11:37:45+00:00 · S-024 (housekeeping tải lại trạng thái trước khi cho bấm lại) mâu thuẫn SPEC-pwa S-006 (bấm lại được ngay khi có mạng)

- Phương án: (1) Khi offline→online: router.refresh() rồi mới mở nút (khoá ~1 round-trip) — thoả cả hai · (2) S-006 thắng toàn cục, sửa S-024 · (3) S-024 thắng riêng cho form buồng phòng
- Chọn: Khi offline→online: router.refresh() rồi mới mở nút (khoá ~1 round-trip) — thoả cả hai
- Lý do (tiêu chí chất lượng cuối): (1) đúng: không thao tác trên trạng thái cũ, vẫn bấm lại được khi có mạng; (3) một cơ chế chung trong useCommand.
- Đường lùi: Bỏ refresh khi online; sửa S-024.

### D-051 · 2026-10-17T12:35:00+00:00 · T-604/T-605: migration mới 0057/0058 đứng trước 0060 đã có trên main — Kysely mặc định từ chối migration chèn trước bản đã áp

- Phương án: (1) Đổi số thành 0061 (T-604) và 0062 (T-605) để luôn đứng sau bản cuối trên main · (2) Bật `allowUnorderedMigrations` cho migrator
- Chọn: Đổi số thành 0061 (T-604) và 0062 (T-605) để luôn đứng sau bản cuối trên main
- Lý do (tiêu chí chất lượng cuối): (1) đúng: CSDL đã áp 0060 sẽ báo lỗi sổ migration nếu nhận 0057; (3) giữ thứ tự tuyến tính đơn giản, không nới cấu hình migrator.
- Đường lùi: Đổi tên file/khoá migration về số cũ khi chưa áp ở đâu.

### D-052 · 2026-10-17T13:10:00+00:00 · T-605: `org.create` không bị hạn mức (bộ đếm theo tổ chức/người suy ra từ key luôn bằng 0) — chặn thế nào?

- Phương án: (1) 10 lần tạo thành công/giờ/người dùng qua `app.rate_limit_hit` (0053) trong bootstrap, cùng transaction; vượt → 429 RATE_LIMITED + `retry_after` · (2) Trần tổng số tổ chức mỗi người · (3) Chỉ dựa vào giới hạn IP của Better Auth
- Chọn: 10 lần tạo thành công/giờ/người dùng qua `app.rate_limit_hit` (0053) trong bootstrap, cùng transaction; vượt → 429 RATE_LIMITED + `retry_after`
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: chặn tài khoản rác làm đầy CSDL, chỉ tính lượt thành công (lỗi rollback), replay không tính; (3) dùng cơ chế sẵn có, không thêm bảng/biến môi trường. (3) bị loại vì giới hạn IP chỉ áp `/api/auth/*`. Cửa sổ cố định theo giờ có thể lọt tới 2× sát ranh giới — chấp nhận.
- Đường lùi: Đổi hằng `ORG_CREATE_PER_USER_PER_HOUR` hoặc bỏ lời gọi `rateLimitHit` trong bootstrap của `org.create`.
- Khi chạy thật: chủ dự án xem lại mức 10/giờ và cân nhắc bật xác minh email khi đăng ký (`requireEmailVerification`, cần SMTP — chống chiếm trước email của nhân viên/người thuê được mời).

### D-053 · 2026-10-17T17:22:57+00:00 · Đợt 8: làm mục MUST nào trong 169 mục mở (đã phân loại: 12 làm trọn trong repo, 90 một phần, 67 cần người)?

- Phương án: (1) 10 mục làm trọn, không mở rộng phạm vi sản phẩm: UX-A11Y-001, UX-A11Y-002, UX-DS-003, QA-COV-004, QA-STATIC-005, XC-PERF-003, DB-MIG-001, CMP-LIC-002, OPS-COST-004, PM-HANDOVER-002 · (2) Cả 12 mục, gồm IND-SAAS-009 (quyền hỗ trợ tạm thời) và CMP-RIGHTS-001 (bảng consents)
- Chọn: 10 mục làm trọn, không mở rộng phạm vi sản phẩm: UX-A11Y-001, UX-A11Y-002, UX-DS-003, QA-COV-004, QA-STATIC-005, XC-PERF-003, DB-MIG-001, CMP-LIC-002, OPS-COST-004, PM-HANDOVER-002
- Lý do (tiêu chí chất lượng cuối): (1) đúng/an toàn: IND-SAAS-009 mở tính năng truy cập hỗ trợ (F-015, auth) cần quyết định sản phẩm/bảo mật; CMP-RIGHTS-001 cần danh mục mục đích từ pháp lý — tick lúc này là hình thức. (3) phần còn lại có bằng chứng máy đầy đủ.
- Đường lùi: Thêm hai mục vào đợt sau khi chủ dự án quyết F-015 và danh mục mục đích

### D-054 · 2026-10-17T17:22:58+00:00 · UX-A11Y-002 đòi kiểm tương phản 'cả hai theme' nhưng sản phẩm chỉ có theme sáng (color-scheme: light)

- Phương án: (1) Kiểm tương phản cho theme sáng; ghi điều kiện mở lại: thêm theme tối thì token tối phải qua cùng script · (2) Làm thêm theme tối chỉ để kiểm
- Chọn: Kiểm tương phản cho theme sáng; ghi điều kiện mở lại: thêm theme tối thì token tối phải qua cùng script
- Lý do (tiêu chí chất lượng cuối): (3) đơn giản, không xây tính năng ngoài PROJECT.md; script kiểm áp cho mọi khối token :root nên theme tối thêm sau tự bị kiểm
- Đường lùi: Thêm theme tối + khối token prefers-color-scheme: dark; script tự kiểm

### D-055 · 2026-10-17T17:22:58+00:00 · QA-STATIC-005 đòi lint chặn code comment-out/console; dự án dùng test quét mã (no-console.test.ts) thay rule lint

- Phương án: (1) Test quét mã trong project unit (chạy trong pnpm test của cổng và CI), cùng kiểu rào sẵn có · (2) Sửa biome.json thêm rule (đổi cấu hình cổng — điểm dừng)
- Chọn: Test quét mã trong project unit (chạy trong pnpm test của cổng và CI), cùng kiểu rào sẵn có
- Lý do (tiêu chí chất lượng cuối): (3) theo quy ước rào máy của dự án; không đổi cấu hình cổng; cổng commit/CI đều chạy
- Đường lùi: Chuyển sang rule Biome khi chủ dự án duyệt đổi biome.json

### D-056 · 2026-10-17T17:22:58+00:00 · PM-HANDOVER-002 đòi 'clean clone build' — có cần workflow riêng?

- Phương án: (1) Job quality của CI (checkout sạch + pnpm install --frozen-lockfile + build) là bằng chứng clean clone build; thêm RUNBOOK.md ở gốc trỏ docs/RUNBOOK.md · (2) Thêm workflow riêng (đổi CI — điểm dừng)
- Chọn: Job quality của CI (checkout sạch + pnpm install --frozen-lockfile + build) là bằng chứng clean clone build; thêm RUNBOOK.md ở gốc trỏ docs/RUNBOOK.md
- Lý do (tiêu chí chất lượng cuối): (3) job quality đã đúng định nghĩa clone sạch trên runner mới; không nhân đôi CI
- Đường lùi: Thêm workflow clean-clone riêng khi chủ dự án duyệt

### D-057 · 2026-10-17T17:22:58+00:00 · CMP-LIC-002 đòi file policy giấy phép (allow/deny/review + ngoại lệ có hạn); định dạng?

- Phương án: (1) license-policy.json (đọc bằng JSON.parse, không thêm phụ thuộc) · (2) YAML (cần thêm thư viện đọc YAML — phụ thuộc mới)
- Chọn: license-policy.json (đọc bằng JSON.parse, không thêm phụ thuộc)
- Lý do (tiêu chí chất lượng cuối): (3) không thêm phụ thuộc; script check-licenses.mjs đọc trực tiếp
- Đường lùi: Đổi sang YAML khi có thư viện YAML sẵn

### D-058 · 2026-10-17T17:49:59+00:00 · T-709 OPS-COST-004: ngân sách email theo ngày nào, trần bao nhiêu, 100% có chặn cả thư bảo mật tài khoản?

- Phương án: (1) Ngày UTC; 1000 lượt/tổ chức/ngày (hằng @hm/domain); 80% cảnh báo, 90% chỉ account_security + lời mời, 100% dừng mọi loại (trần cứng), hoãn sang 00:00 UTC hôm sau; alert mức ticket · (2) Ngày kinh doanh theo cơ sở; thư account_security vượt trần
- Chọn: Ngày UTC; 1000 lượt/tổ chức/ngày (hằng @hm/domain); 80% cảnh báo, 90% chỉ account_security + lời mời, 100% dừng mọi loại (trần cứng), hoãn sang 00:00 UTC hôm sau; alert mức ticket
- Lý do (tiêu chí chất lượng cuối): (1) an toàn chi phí: trần cứng đúng tiêu chí mục; ngân sách là chi phí hệ thống theo tổ chức (nhiều cơ sở khác múi giờ) nên dùng UTC như rate_limit_hit; (2) đường lùi: đổi hằng/hàm một chỗ
- Đường lùi: Đổi hằng EMAIL_BUDGET_PER_ORG_PER_DAY hoặc cho account_security vượt trần trong app.email_budget_take
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Chủ dự án xác nhận trần/ngày theo gói và có cho thư bảo mật tài khoản vượt trần không; OTP người thuê chưa qua ngân sách (chờ adapter SMTP thật, D-010)

### D-059 · 2026-10-17T23:46:44+00:00 · Đợt 9: phạm vi sau khi chủ dự án duyệt sửa CI/file cổng và thêm công cụ kiểm (trả lời 'Duyệt CI + công cụ', 2026-10-17)

- Phương án: (1) 67 mục MUST 'một phần' cần CI/file cổng/công cụ, chia 7 lát theo chủ đề (pr-policy+lịch sử, chuỗi cung ứng, quét bảo mật, frontend perf/test, chất lượng test, API/vận hành, phát hành/DX); bỏ 4 mục cần biến môi trường mới và 19 mục pháp lý · (2) Chỉ các mục sửa workflow, chưa thêm công cụ
- Chọn: 67 mục MUST 'một phần' cần CI/file cổng/công cụ, chia 7 lát theo chủ đề (pr-policy+lịch sử, chuỗi cung ứng, quét bảo mật, frontend perf/test, chất lượng test, API/vận hành, phát hành/DX); bỏ 4 mục cần biến môi trường mới và 19 mục pháp lý
- Lý do (tiêu chí chất lượng cuối): (1) đúng phạm vi người duyệt; (3) mỗi lát một PR có test/CI chứng minh; công cụ chọn tự host, giấy phép OSI, action ghim SHA (ci-check); phụ thuộc mới theo license-policy.json
- Đường lùi: Revert PR của lát tương ứng; cấu hình cổng trở về bản trước

### D-060 · 2026-10-18T00:08:06+00:00 · WF-REVIEW-007: thay đổi .github/.claude/.githooks có bắt buộc người merge (thêm vào merge_risk_paths) không?

- Phương án: (1) Giữ CODEOWNERS (@seeker19110) nhưng không thêm vào merge_risk_paths; WF-REVIEW-007 chưa tick, chờ chủ dự án quyết · (2) Thêm .github/*, .claude/*, .githooks/* vào merge_risk_paths (mọi PR CI/công cụ phải người merge)
- Chọn: Giữ CODEOWNERS (@seeker19110) nhưng không thêm vào merge_risk_paths; WF-REVIEW-007 chưa tick, chờ chủ dự án quyết
- Lý do (tiêu chí chất lượng cuối): (2) đường lùi: chủ dự án đã duyệt đợt 9 sửa CI/công cụ và muốn tự merge từng lát; thêm vào merge_risk_paths đổi chính sách merge (điểm dừng) nên để chủ dự án quyết
- Đường lùi: Thêm glob vào merge_risk_paths trong xt.yaml

### D-061 · 2026-10-18T00:08:36+00:00 · T-802: chọn công cụ chuỗi cung ứng

- Phương án: (1) grype (anchore/scan-action, only-fixed, chặn high/critical; lỗ hổng chưa có bản sửa theo dõi trong VULN-SLA.md) + SBOM CycloneDX 1.6 tự sinh (scripts/sbom.mjs) + syft cho image + new-deps chỉ chặn phụ thuộc trực tiếp · (2) trivy + cdxgen, chặn cả lỗ hổng chưa có bản sửa
- Chọn: grype (anchore/scan-action, only-fixed, chặn high/critical; lỗ hổng chưa có bản sửa theo dõi trong VULN-SLA.md) + SBOM CycloneDX 1.6 tự sinh (scripts/sbom.mjs) + syft cho image + new-deps chỉ chặn phụ thuộc trực tiếp
- Lý do (tiêu chí chất lượng cuối): (3) ít phụ thuộc, OSI, action ghim SHA; chặn cái sửa được, theo dõi cái chưa sửa được có SLA — không đỏ vĩnh viễn vì việc ngoài tầm
- Đường lùi: Đổi only-fixed=false hoặc thay action quét
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Chủ dự án quyết ngoại lệ giấy phép LGPL-3.0 của @img/sharp-libvips (dynamic link, dùng cho tối ưu ảnh Next) khi mở rộng licenses:check quét toàn workspace (148 gói)

### D-062 · 2026-10-18T00:10:24+00:00 · T-801: lychee/oasdiff không tải được qua proxy — dùng công cụ nào để kiểm liên kết và breaking change OpenAPI; luật breaking API chặt tới đâu?

- Phương án: (1) Tự viết script Node (scripts/check-external-links.mjs) kiểm liên kết (cache + thử lại) và so OpenAPI với nhánh gốc (scripts/check-openapi-breaking.mjs); breaking bắt buộc bump MAJOR + 'BREAKING CHANGE:' · (2) Chờ người cho phép tải binary lychee/oasdiff · (3) Bỏ kiểm, ghi miễn trừ
- Chọn: Tự viết script Node (scripts/check-external-links.mjs) kiểm liên kết (cache + thử lại) và so OpenAPI với nhánh gốc (scripts/check-openapi-breaking.mjs); breaking bắt buộc bump MAJOR + 'BREAKING CHANGE:'
- Lý do (tiêu chí chất lượng cuối): Chạy được ngay trong repo, có unittest, không thêm phụ thuộc nhị phân; luật chặt an toàn hơn cho client
- Đường lùi: Thay script bằng lychee/oasdiff trong cùng job khi proxy cho phép; nới luật bằng sửa scripts/check-openapi-breaking.mjs
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Cân nhắc thay bằng lychee/oasdiff bản ghim checksum khi CI ra mạng được

### D-063 · 2026-10-18T00:13:50+00:00 · T-805 QA-COV-008: 'PR diff cấu hình cổng cần reviewer' — thực thi bằng gì trong repo?

- Phương án: (1) Thêm vitest/playwright config, biome.json, tsconfig, xt.yaml vào merge_risk_paths (merge-check trả hard, người merge) + job coverage-ratchet · (2) Chỉ dựa CODEOWNERS + required review (cần người bật ruleset) · (3) Chỉ job coverage-ratchet, agent vẫn tự merge
- Chọn: Thêm vitest/playwright config, biome.json, tsconfig, xt.yaml vào merge_risk_paths (merge-check trả hard, người merge) + job coverage-ratchet
- Lý do (tiêu chí chất lượng cuối): Chặt nhất chạy được ngay trong repo, khớp chữ MUST; ratchet chặn hạ ngưỡng còn merge_risk_paths chặn nới cấu hình khác; giảm tự chủ merge chỉ ở file cổng
- Đường lùi: Bỏ các glob cấu hình khỏi merge_risk_paths trong xt.yaml
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Thêm CODEOWNERS cho các file cấu hình cổng và bật required review ở ruleset
- Bổ sung sau review (2026-10-18): thêm vào merge_risk_paths cả `scripts/check-coverage-ratchet.mjs`, `scripts/fix-requires-test.mjs`, `.github/workflows/test-quality.yml` (đường nới ngưỡng ngoài vitest.config) + rào cấm cờ `--coverage.thresholds*` trong workflow; KHÔNG thêm `.github/workflows/*` chung (ADR-0018 của khung: sửa CI cho chạy, lớp đỡ là review độc lập + required check của ruleset).

### D-064 · 2026-10-18T00:27:40+00:00 · T-806: otelcol-contrib 0.161.0 không có file checksum chính thức cho gói contrib — ghim SHA-256 tự đo có chấp nhận được? Job schema-compat (~6 phút) chạy mỗi PR hay theo lịch?

- Phương án: (1) Chấp nhận SHA-256 tự đo (trust-on-first-use, ghim cứng, đổi bản phải đo lại có review) + schema-compat chạy mỗi PR · (2) Không ghim, tải bản mới nhất · (3) schema-compat chạy theo lịch để PR nhanh hơn
- Chọn: Chấp nhận SHA-256 tự đo (trust-on-first-use, ghim cứng, đổi bản phải đo lại có review) + schema-compat chạy mỗi PR
- Lý do (tiêu chí chất lượng cuối): Ghim cứng vẫn chặn tráo binary sau lần đo; OPS-DEPLOY-003 cần chặn vỡ N-1 TRƯỚC merge nên phải chạy trên PR; 6 phút song song với e2e không kéo dài tổng thời gian CI đáng kể
- Đường lùi: Đổi trigger schema-compat sang schedule trong .github/workflows/api-ops.yml; thay SHA trong scripts/ops-tools.sh
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Xác minh otelcol-contrib bằng chữ ký cosign của bản phát hành (hoặc build từ nguồn) trước khi dùng collector ở môi trường thật

### D-065 · 2026-10-18T00:38:43+00:00 · Đợt 9: job cổng mới (pr-policy, commit-lint, new-deps, sbom, image-scan, coverage, coverage-ratchet, fix-requires-test, sast, dast, openapi, schema-compat…) chưa là required check nên chưa chặn auto-merge; đổi ruleset trên GitHub là điểm dừng của người — xử lý thế nào?

- Phương án: (1) Mỗi lát giữ job, KHÔNG sửa .github/rulesets/main.json; một PR cuối đợt (T-808) gom mọi context mới vào main.json (chỉ job chạy trên MỌI PR, không lọc paths); dòng Bằng chứng ghi 'chặn merge khi ruleset được import (người)'; defer việc import · (2) Mỗi lát tự thêm context vào main.json · (3) Bỏ tick các mục cho tới khi ruleset được import
- Chọn: Mỗi lát giữ job, KHÔNG sửa .github/rulesets/main.json; một PR cuối đợt (T-808) gom mọi context mới vào main.json (chỉ job chạy trên MỌI PR, không lọc paths); dòng Bằng chứng ghi 'chặn merge khi ruleset được import (người)'; defer việc import
- Lý do (tiêu chí chất lượng cuối): Tránh xung đột main.json giữa 6 lát; job đỏ vẫn hiện trên PR và review độc lập chặn merge tay; tick ghi đúng mức chặn thật; import ruleset là việc người
- Đường lùi: Xoá context khỏi main.json ở PR cuối; bỏ ghi chú trong Bằng chứng
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Chủ dự án import .github/rulesets/main.json sau khi mọi job mới xanh ít nhất một lần trên PR

### D-066 · 2026-10-18T01:16:12+00:00 · T-804: (a) FE-TEST-001 'getByTestId ≤ 10%' áp cho test nào? (b) FE-BUILD-003 có giữ skipLibCheck không? (c) hook pre-commit dùng husky hay .githooks của T-807?

- Phương án: (1) (a) chỉ test Testing Library — E2E Playwright đọc giá trị qua test id là hợp lệ; (b) giữ skipLibCheck có lý do (d.ts happy-dom lệch @types/node 24), test khoá không có .d.ts tự viết; (c) bỏ husky, dồn 'biome check --staged' vào .githooks/pre-commit của T-807 (một cơ chế, không đặt core.hooksPath) · (2) Áp ≤10% cho cả E2E và refactor; bỏ skipLibCheck bằng cách đổi sang jsdom (MIT-0 cần thêm vào license-policy)
- Chọn: (a) chỉ test Testing Library — E2E Playwright đọc giá trị qua test id là hợp lệ; (b) giữ skipLibCheck có lý do (d.ts happy-dom lệch @types/node 24), test khoá không có .d.ts tự viết; (c) bỏ husky, dồn 'biome check --staged' vào .githooks/pre-commit của T-807 (một cơ chế, không đặt core.hooksPath)
- Lý do (tiêu chí chất lượng cuối): Đúng tinh thần mục (truy vấn theo vai trò trong test component); jsdom kéo giấy phép mới cần chủ dự án; hai cơ chế hook xung đột (bộ cài T-807 bỏ qua khi có core.hooksPath)
- Đường lùi: Gỡ skipLibCheck khi happy-dom/@types/node khớp; đổi sang jsdom nếu chủ dự án duyệt MIT-0
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Chủ dự án quyết MIT-0 nếu muốn jsdom thay happy-dom



### D-067 · 2026-10-18T01:17:15+00:00 · T-802 image-scan: lỗ hổng high/critical có bản sửa thượng nguồn nhưng chưa có image vá (Go stdlib/x-net trong caddy & seaweedfs, npm đi kèm node, zlib alpine của caddy) — xử lý thế nào?

- Phương án: (1) Ngoại lệ CÓ HẠN trong .grype.yaml (đúng mã+gói+phiên bản; critical ≤ 7 ngày, high ≤ 30 ngày), theo dõi ở VULN-SLA.md; xoá npm khỏi runtime web/worker; zlib caddy: ngoại lệ 14 ngày (caddy là Go thuần, không dùng zlib hệ thống); kiểm hạn ở job image-scan (PR + hằng tuần), KHÔNG ở unit test (cổng không phụ thuộc ngày chạy) · (2) Image dẫn xuất FROM caddy/seaweedfs + apk upgrade (đổi compose sang build:) · (3) Hạ severity-cutoff/tắt only-fixed
- Chọn: Ngoại lệ CÓ HẠN trong .grype.yaml (đúng mã+gói+phiên bản; critical ≤ 7 ngày, high ≤ 30 ngày), theo dõi ở VULN-SLA.md; xoá npm khỏi runtime web/worker; zlib caddy: ngoại lệ 14 ngày (caddy là Go thuần, không dùng zlib hệ thống); kiểm hạn ở job image-scan (PR + hằng tuần), KHÔNG ở unit test (cổng không phụ thuộc ngày chạy)
- Lý do (tiêu chí chất lượng cuối): Không sửa được từ repo (thượng nguồn chưa build lại); ngoại lệ hẹp tự hết khớp khi nâng; image dẫn xuất đổi cách triển khai mà Go stdlib vẫn phải ngoại lệ; hạ ngưỡng bị cấm
- Đường lùi: Xoá luật trong .grype.yaml khi có image vá; bỏ RUN rm npm trong deploy/*.Dockerfile
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Chủ dự án theo dõi bảng 'Theo dõi' của VULN-SLA.md; cân nhắc image dẫn xuất nếu thượng nguồn chậm quá hạn

### D-068 · 2026-10-18T01:41:43+00:00 · T-804: @lhci/cli kéo parse-cache-control@1.0.1 khai giấy phép 'BSD' (không có SPDX id) → licenses:check đỏ. Dùng lockfile riêng tools/lhci hay ngoại lệ giấy phép?

- Phương án: (1) Ngoại lệ có hạn cho đúng parse-cache-control@1.0.1 ('BSD' — mọi biến thể BSD đều thuộc allow), giữ MỘT lockfile pnpm (FE-BUILD-001 MUST), @lhci/cli vào devDependencies gốc · (2) Lockfile npm riêng tools/lhci (vi phạm FE-BUILD-001 'một lockfile') · (3) Bỏ Lighthouse CI
- Chọn: Ngoại lệ có hạn cho đúng parse-cache-control@1.0.1 ('BSD' — mọi biến thể BSD đều thuộc allow), giữ MỘT lockfile pnpm (FE-BUILD-001 MUST), @lhci/cli vào devDependencies gốc
- Lý do (tiêu chí chất lượng cuối): MUST FE-BUILD-001 thắng tiện lợi; 'BSD' chung chung vẫn là họ giấy phép đã cho phép; ngoại lệ hẹp đúng gói+phiên bản, có hạn rà lại; lockfile gốc có integrity, đi qua SBOM/grype/new-deps
- Đường lùi: Gỡ exception trong license-policy.json và @lhci/cli khỏi package.json; quay lại tools/lhci
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Chủ dự án xác nhận ngoại lệ BSD của parse-cache-control khi rà giấy phép trước phát hành

### D-069 · 2026-10-18T06:01:19+00:00 · Khung 3.0.0 cài .github/workflows/merge-gate.yml dùng pull_request_target, trái luật WF-CI-004 của dự án (test cấm + zizmor dangerous-triggers đỏ). Nhận hay bỏ?

- Phương án: (1) Nhận merge-gate: chú thích zizmor ignore có lý do ở đúng dòng trigger; test đổi từ cấm hẳn sang chỉ cho merge-gate.yml kèm kiểm cấu trúc (không ref: ở checkout, permissions chỉ read, không secrets.); thêm merge-gate vào required checks · (2) Bỏ merge-gate.yml, giữ cấm pull_request_target; dựa vào luật tắt auto-merge trước mỗi push (ADR-0025 của khung)
- Chọn: Nhận merge-gate: chú thích zizmor ignore có lý do ở đúng dòng trigger; test đổi từ cấm hẳn sang chỉ cho merge-gate.yml kèm kiểm cấu trúc (không ref: ở checkout, permissions chỉ read, không secrets.); thêm merge-gate vào required checks
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn (tiêu chí 1): dự án có ngoại lệ cứng về tiền/lưu trú; auto-merge của GitHub không ghim head nên không có merge-gate thì PR vô hại bật auto-merge rồi push commit chạm ledger vẫn tự merge — luật lời không chặn được. Rủi ro của pull_request_target là chạy code PR với quyền ghi/secret; merge-gate không checkout code PR, token chỉ đọc, không secret, và test mới giữ đúng các bất biến đó máy kiểm thay cho lệnh cấm chung.
- Đường lùi: Xoá .github/workflows/merge-gate.yml, bỏ merge-gate khỏi .github/rulesets/main.json + FRAMEWORK_GATES, khôi phục test cấm pull_request_target

### D-070 · 2026-10-18T09:55:33+00:00 · UX-VIZ-002 (MUST mới của khung 3.1.0, biểu đồ có bảng/mô tả thay thế, không mã hoá chỉ bằng màu): áp dụng hay không cho V1?

- Phương án: (1) Không áp dụng: app không có biểu đồ (báo cáo dạng bảng; SVG chỉ icon/QR), khoá điều kiện bằng test rào · (2) Miễn (hoãn) chờ chủ dự án duyệt · (3) Làm ngay: dựng hạ tầng biểu đồ a11y dù chưa có biểu đồ
- Chọn: Không áp dụng: app không có biểu đồ (báo cáo dạng bảng; SVG chỉ icon/QR), khoá điều kiện bằng test rào
- Lý do (tiêu chí chất lượng cuối): Đúng thực trạng (grep không có thư viện/thành phần biểu đồ; SPEC/PROJECT không yêu cầu biểu đồ); LOOP-STOP-024 cho agent ghi 'Không áp dụng' với điều kiện kiểm được; test scripts/no-charts.test.mjs đỏ khi thêm gói biểu đồ (danh sách + mẫu tên chart/plot/sparkline/graph) hoặc giao diện vẽ svg/canvas, thanh style inline, meter/progress, role=img ngoài icon/QR (mở rộng sau review PR #55); còn lọt: biểu đồ vẽ trong chính icon.tsx/qr-code.tsx hoặc bằng className CSS thuần không style — chấp nhận, review PR bắt
- Đường lùi: Bỏ [~] UX-VIZ-002 về [ ] và làm mục khi có biểu đồ đầu tiên (test rào sẽ báo)

### D-071 · 2026-10-18T11:52:12+00:00 · Duyệt PLAN đợt 10 (T-901…T-909, 10 mục MUST làm được trong repo)

- Phương án: (1) Làm cả 10 mục theo 8 lát, mỗi lát một PR, thứ tự nhỏ→lớn (SBOM, hook, log PII, xoay mật khẩu, ngân sách, k6, Lighthouse, i18n) · (2) Chỉ làm 6 mục nhỏ, để i18n/k6/Lighthouse cho người
- Chọn: Làm cả 10 mục theo 8 lát, mỗi lát một PR, thứ tự nhỏ→lớn (SBOM, hook, log PII, xoay mật khẩu, ngân sách, k6, Lighthouse, i18n)
- Lý do (tiêu chí chất lượng cuối): Người dùng yêu cầu làm theo đề xuất 10 mục; thứ tự nhỏ→lớn cho PR sớm vào main, i18n lớn nhất để cuối; mỗi lát có Gate máy kiểm
- Đường lùi: Dừng ở lát bất kỳ; lát chưa merge thì đóng PR

### D-072 · 2026-10-18T11:52:12+00:00 · QA-PERF-002/CMP-PRIV-008 đòi chạy trên staging nhưng chưa có VPS/staging

- Phương án: (1) Dùng môi trường CI tạm dựng như job e2e (CSDL seed, dữ liệu giả) làm đích nightly/quét log; không tick phần 'staging' nếu Kiểm đòi staging thật · (2) Hoãn cả hai mục chờ staging
- Chọn: Dùng môi trường CI tạm dựng như job e2e (CSDL seed, dữ liệu giả) làm đích nightly/quét log; không tick phần 'staging' nếu Kiểm đòi staging thật
- Lý do (tiêu chí chất lượng cuối): Có giá trị ngay (bắt hồi quy hiệu năng/PII), an toàn (không đụng production, dữ liệu giả), đường lùi rõ: đổi BASE_URL sang staging khi có
- Đường lùi: Đổi BASE_URL/secret sang staging thật; hoặc tắt schedule
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Khi có staging: đặt BASE_URL của workflow k6 tới staging (biến môi trường repo, không phải domain production)

### D-073 · 2026-10-18T12:18:58+00:00 · XC-I18N-001/009: 2.329 chuỗi tiếng Việt viết thẳng trong 190 tệp (UI, lỗi, email; đo bằng scripts/i18n-literals.mjs, ước ban đầu ~6.000 gồm cả mã không phải giao diện); làm thế nào trong đợt 10?

- Phương án: (1) Hạ tầng + chặn tăng: messages/vi.json + hàm t() + validator khoá/ICU/tham số/HTML (XC-I18N-009, chạy CI) + lint ratchet: số chuỗi literal theo file chỉ được giảm, chuỗi mới phải qua t(); chuyển trước nhóm nhỏ (thông báo lỗi chung) làm mẫu; XC-I18N-001 chưa tick tới khi baseline = 0 · (2) Chuyển toàn bộ ~6.000 chuỗi ngay trong một lát · (3) Hoãn cả hai mục
- Chọn: Hạ tầng + chặn tăng: messages/vi.json + hàm t() + validator khoá/ICU/tham số/HTML (XC-I18N-009, chạy CI) + lint ratchet: số chuỗi literal theo file chỉ được giảm, chuỗi mới phải qua t(); chuyển trước nhóm nhỏ (thông báo lỗi chung) làm mẫu; XC-I18N-001 chưa tick tới khi baseline = 0
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: không đụng hàng loạt UI/tiền trong một PR; ngăn nợ tăng ngay (ratchet như coverage); XC-I18N-009 đạt thật; đường chuyển dần rõ ràng, test được
- Đường lùi: Bỏ rào ratchet và messages/ (không ảnh hưởng runtime ngoài các chuỗi đã chuyển)

### D-074 · 2026-10-18T23:27:38+00:00 · LOOP-OPT-001…004 (MUST mới của khung 3.4, vòng tối ưu hiệu năng do máy quyết): áp dụng thế nào khi PLAN chưa có task tối ưu?

- Phương án: (1) Không áp dụng có điều kiện: PLAN chưa có task tối ưu (ngân sách hiệu năng CI xanh); test rào đỏ khi PLAN thêm task tối ưu mà Gate không lấy script từ commit gốc/không có mục tiêu số · (2) Dựng sẵn scripts/perf-gate.sh + PERF-LOG.md và một task tối ưu mẫu · (3) Miễn chờ chủ dự án duyệt
- Chọn: Không áp dụng có điều kiện: PLAN chưa có task tối ưu (ngân sách hiệu năng CI xanh); test rào đỏ khi PLAN thêm task tối ưu mà Gate không lấy script từ commit gốc/không có mục tiêu số
- Lý do (tiêu chí chất lượng cuối): Đúng thực trạng: mọi ngân sách (bundle, Lighthouse, image, thời gian CI, k6 thresholds) đang xanh nên LOOP-OPT-001 cấm mở task tối ưu; dựng task mẫu là tối ưu không có số (trái chính LOOP-OPT-001). Test rào scripts/perf-optimization-tasks.test.mjs giữ điều kiện và ép Gate đúng vòng khi có task thật
- Đường lùi: Bỏ [~] LOOP-OPT-001…004 về [ ] khi có task tối ưu đầu tiên (test rào báo); khi đó viết scripts/perf-gate.sh theo optimization-loop.md

### D-075 · 2026-10-19T01:22:40+00:00 · Duyệt PLAN đợt 12 (T-1101…T-1104): mọi MUST còn mở cần người; phần agent còn làm được trong repo là các mục 🟢 treo sau review đợt 10

- Phương án: (1) Làm 3 lát gia cố CMP-PRIV-008/XC-I18N-001 đã ghi treo (Semgrep bắt log.child/JSON.stringify object người; E2E server chờ tiến trình con đóng trước khi kết thúc để không mất log; ratchet i18n bắt chữ JSX có biểu thức/'//') + rà PROGRESS/GAPS; mỗi lát một PR · (2) Dừng ở done-pending-human, không làm thêm · (3) Chuyển hàng loạt chuỗi i18n (XC-I18N-001) sang messages/vi.json
- Chọn: Làm 3 lát gia cố CMP-PRIV-008/XC-I18N-001 đã ghi treo (Semgrep bắt log.child/JSON.stringify object người; E2E server chờ tiến trình con đóng trước khi kết thúc để không mất log; ratchet i18n bắt chữ JSX có biểu thức/'//') + rà PROGRESS/GAPS; mỗi lát một PR
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: lấp lỗ rào đã biết (PII lọt log, ratchet bỏ sót) mà không đụng tiền/auth; nhỏ, test được, đảo ngược được. Chuyển i18n hàng loạt rủi ro UI cao, D-073 đã chọn chuyển dần theo màn
- Đường lùi: Revert từng PR; luật Semgrep/ratchet mới chỉ thêm phát hiện

### D-076 · 2026-10-19T01:27:27+00:00 · T-1103: bộ đếm i18n mới bắt thêm 26 chuỗi JSX dạng '{x} chữ' ở 16 tệp; rào 'baseline không nới so với main' cấm nâng ngưỡng

- Phương án: (1) Chuyển đúng 26 đoạn đó sang t() trong cùng PR (hiển thị giữ nguyên); 5 tệp thuộc merge_risk_paths (thu-tien, ky-thu, hop-dong) nên PR do người merge · (2) Nới rào: cho nâng baseline khi script đếm đổi trong cùng PR · (3) Hoãn T-1103
- Chọn: Chuyển đúng 26 đoạn đó sang t() trong cùng PR (hiển thị giữ nguyên); 5 tệp thuộc merge_risk_paths (thu-tien, ky-thu, hop-dong) nên PR do người merge
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: không nới cổng (AGENTS §4), bộ đếm chặt hơn và nợ i18n giảm thật; đổi chỉ là chuỗi hiển thị giống hệt. Phương án 2 mở kẽ nới ratchet; phương án 3 để lỗ rào đã biết
- Đường lùi: Đóng/revert PR; bộ đếm cũ và baseline cũ vẫn ở main

### D-077 · 2026-10-19T08:07:09+00:00 · CMP-LIC-003 'license không null ≥ 99%': SBOM image (syft) liệt kê cả mục type=file (hàng nghìn tệp trong image) và operating-system, không có trường license — tính tỉ lệ trên tập nào?

- Phương án: (1) Tính trên component là gói (library/application/framework…), bỏ type file và operating-system: v0.2.0 đạt 1487/1491 ≈ 99,7% · (2) Tính trên mọi component kể cả file: v0.2.0 chỉ 2–73% với image — không bao giờ đạt nếu không bỏ mục file khỏi SBOM
- Chọn: Tính trên component là gói (library/application/framework…), bỏ type file và operating-system: v0.2.0 đạt 1487/1491 ≈ 99,7%
- Lý do (tiêu chí chất lượng cuối): Đúng ý NTIA Minimum Elements: license là thuộc tính của thành phần phần mềm (gói), mục file chỉ là danh mục tệp/băm; vẫn giữ mục file trong SBOM để truy vết. Lệnh kiểm ghi rõ tập tính và ngưỡng
- Đường lùi: Đổi bộ lọc trong scripts/check-github-live.mjs (sbomCoverage) và bỏ tick CMP-LIC-003

### D-078 · 2026-10-19T11:27:43+00:00 · Duyệt PLAN đợt 13 (T-1201…T-1203): mọi MUST còn mở cần người; phần agent còn làm được là mục 🟢 treo sau review #78 (bộ đếm i18n bằng regex đếm sai, tham số t() không được kiểm)

- Phương án: (1) Làm 2 lát: T-1201 đổi bộ đếm chuỗi viết thẳng sang trình phân tích AST (@babel/parser, plugin typescript+jsx), baseline chỉ được nâng tới đúng số đếm của chính mã trên main; T-1202 kiểm tham số mọi t('khoá', {…}) khớp tham số ICU của khoá; T-1203 rà PROGRESS/GAPS · (2) Chỉ vá regex (lookbehind $, template lồng) và giữ baseline · (3) Không làm, kết thúc phiên ở done-pending-human
- Chọn: Làm 2 lát: T-1201 đổi bộ đếm chuỗi viết thẳng sang trình phân tích AST (@babel/parser, plugin typescript+jsx), baseline chỉ được nâng tới đúng số đếm của chính mã trên main; T-1202 kiểm tham số mọi t('khoá', {…}) khớp tham số ICU của khoá; T-1203 rà PROGRESS/GAPS
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: prototype AST đếm 2363 so với 2321 của regex (11 tệp regex đếm thiếu do template lồng làm lệch cặp nháy ⇒ chuỗi mới ở các tệp đó lọt ratchet). Regex không thể hiểu template lồng (lỗ gốc), vá thêm là chắp vá. Nâng baseline chỉ tới số đếm trên cây origin/main nên không cho thêm chuỗi nào (khác phương án 2 bị loại ở D-076: PR không thể vừa đổi bộ đếm vừa thêm chuỗi). @babel/parser MIT, đã có trong lockfile (qua vitest coverage), ổn định; API JS của TypeScript 7 còn 'unstable'. T-1202 chặn lỗi hiển thị '{ten}' thô cho người dùng.
- Đường lùi: Revert từng PR: bộ đếm regex và baseline cũ trở lại; gỡ @babel/parser khỏi devDependencies

### D-079 · 2026-10-19T14:38:09+00:00 · Duyệt PLAN đợt 14 (T-1301…T-1304): sửa 🔴/🟠 của audit 2026-10-19 (SEC-001, DATA-001/002, CI-001) — cách sửa SEC-001 và phạm vi

- Phương án: (1) SEC-001: trong inviteTenant, khi tài khoản có sẵn chưa xác minh email và (xuyên tổ chức) chỉ còn là người thuê → xoá credential + session; nhân viên giữ nguyên. DATA-001/002: migration policy RESTRICTIVE (tenant/guest chỉ thấy cơ sở có hợp đồng; nhân viên theo actor_can_see_property). CI-001: job coverage chạy thật khi edited · (2) SEC-001: bật requireEmailVerification cho đăng ký mật khẩu (đổi luồng đăng ký nhân viên, cần SMTP thật) · (3) SEC-001: từ chối mời khi tài khoản chưa xác minh (chặn người thuê hợp lệ đã tự đăng ký)
- Chọn: SEC-001: trong inviteTenant, khi tài khoản có sẵn chưa xác minh email và (xuyên tổ chức) chỉ còn là người thuê → xoá credential + session; nhân viên giữ nguyên. DATA-001/002: migration policy RESTRICTIVE (tenant/guest chỉ thấy cơ sở có hợp đồng; nhân viên theo actor_can_see_property). CI-001: job coverage chạy thật khi edited
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: vá đúng gốc (mật khẩu của kẻ gian) mà không đổi luồng nhân viên, không cần dịch vụ ngoài (mặc định tự host); người thuê hợp lệ vẫn vào bằng OTP. Phương án 2 phụ thuộc SMTP thật và đổi đăng ký; phương án 3 chặn nhầm người thuê. Đã kiểm hai ca giữ mật khẩu: email đã xác minh, nhân viên ở tổ chức khác (otp_sign_in_allowed xuyên tổ chức). RLS/CI sửa theo đúng hàng rào AGENTS §9 (ràng buộc ở DB).
- Đường lùi: Revert từng PR; không có migration phá dữ liệu (policy mới chỉ thêm, có down)

### D-080 · 2026-10-19T15:09:48+00:00 · SEC-001: vá lần 1 (D-079) bị reviewer Opus phá — kẻ gian tự tạo tổ chức (owner) để otp_sign_in_allowed=false và giữ mật khẩu; mọi tài khoản mật khẩu đều emailVerified=false nên không phân biệt được nhân viên thật với kẻ gian. Sửa thế nào?

- Phương án: (1) Từ chối mời (409, quay lui) khi tài khoản chưa xác minh còn vai nhân viên ở đâu đó; chỉ khi chỉ còn là người thuê thì xoá credential+session; khoá hàng user (for update); mời lại cùng người cũng dọn · (2) Cấp tenant ở trạng thái chờ tới khi chủ hộp thư chứng minh qua OTP (cần luồng kích hoạt mới) · (3) Bật requireEmailVerification cho đăng ký mật khẩu (cần SMTP thật, đổi đăng ký nhân viên)
- Chọn: Từ chối mời (409, quay lui) khi tài khoản chưa xác minh còn vai nhân viên ở đâu đó; chỉ khi chỉ còn là người thuê thì xoá credential+session; khoá hàng user (for update); mời lại cùng người cũng dọn
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn, cách hiểu chặt hơn (tiêu chí 1): không còn đường kẻ gian giữ mật khẩu + vai tenant của nạn nhân; không thêm bảng/luồng (đơn giản); giá phải trả: nhân viên chưa xác minh không thể đồng thời là người thuê bằng cùng email (rất hiếm, có thông báo rõ). Phương án 2/3 đúng gốc hơn nhưng cần luồng xác minh/SMTP thật — ghi vào đề xuất kế tiếp. Thay thế một phần D-079 (phần SEC-001).
- Đường lùi: Revert PR #100; mời lại hoạt động như trước (có lỗ)

### D-081 · 2026-10-19T15:58:53+00:00 · SEC-001 lần 3: mọi vá 'dọn lúc mời' (D-079/D-080) bị reviewer Opus phá tiếp (2FA đang chờ, mời lại, dò email nhân viên tổ chức khác, xoá oan mật khẩu). Gốc: tài khoản mật khẩu chưa chứng minh sở hữu email vẫn được cấp quyền tenant. Sửa ở đâu?

- Phương án: (1) Quyền tenant chỉ có hiệu lực khi auth.user.emailVerified = true (resolveActor); emailVerified chỉ đổi true qua OTP gửi tới hộp thư; ngay lúc đó (hook user.update.after) nếu tài khoản chỉ còn là người thuê thì xoá credential + twoFactor + phiên + yếu tố 2FA đang chờ. inviteTenant về như cũ · (2) Giữ vá ở inviteTenant và vá thêm từng lỗ (2FA, mời lại, thu hồi membership) · (3) Bật requireEmailVerification + SMTP thật cho đăng ký
- Chọn: Quyền tenant chỉ có hiệu lực khi auth.user.emailVerified = true (resolveActor); emailVerified chỉ đổi true qua OTP gửi tới hộp thư; ngay lúc đó (hook user.update.after) nếu tài khoản chỉ còn là người thuê thì xoá credential + twoFactor + phiên + yếu tố 2FA đang chờ. inviteTenant về như cũ
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn (tiêu chí 1): bất biến 'quyền tenant ⇒ đã chứng minh sở hữu hộp thư' được kiểm ở một chỗ duy nhất lúc dùng quyền, thay vì chặn từng đường lúc cấp; không lộ email nhân viên tổ chức khác (không còn 409 dò), không xoá oan mật khẩu nhân viên (chỉ xoá khi tài khoản chỉ-tenant VÀ vừa OTP), mời lại không còn cần dọn. Kẻ lập tổ chức riêng làm otp_sign_in_allowed=false ⇒ nạn nhân không OTP được ⇒ quyền tenant không bao giờ hiệu lực (từ chối dịch vụ, không rò dữ liệu). Còn cửa sổ đua mili-giây (phiên đang tạo dở khi hook chạy) — ghi nhận. Phương án 2 là vá triệu chứng đã thất bại hai lần; phương án 3 cần SMTP thật (đề xuất khi chạy thật).
- Đường lùi: Revert PR #100; quyền tenant cấp như trước (có lỗ SEC-001)

### D-082 · 2026-10-19T16:53:32+00:00 · D-081 vòng 3: review Opus thấy hook dọn sau OTP vô tác dụng (Better Auth tự gỡ mật khẩu/phiên trước khi cập nhật emailVerified), TOTP chờ sẵn và cửa sổ đua đăng nhập mật khẩu vẫn cho kẻ gian phiên tenant. Chốt cách đóng?

- Phương án: (1) Bỏ hook dọn; thêm databaseHooks.session.create.before: tài khoản chỉ-còn-tenant (otp_sign_in_allowed) chỉ tạo phiên qua /sign-in/email-otp; giữ cổng emailVerified ở resolveActor; ẩn tổ chức của tenant chưa xác minh khỏi listMyOrganizations · (2) Giữ hook dọn và thêm xoá vô điều kiện + khoá hàng user chung cho hai đường đăng nhập
- Chọn: Bỏ hook dọn; thêm databaseHooks.session.create.before: tài khoản chỉ-còn-tenant (otp_sign_in_allowed) chỉ tạo phiên qua /sign-in/email-otp; giữ cổng emailVerified ở resolveActor; ẩn tổ chức của tenant chưa xác minh khỏi listMyOrganizations
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: chặn tại điểm tạo phiên đóng mọi đường (mật khẩu, TOTP chờ sẵn, đua) bằng một điều kiện, không phụ thuộc thứ tự nội bộ của Better Auth; đơn giản hơn khoá chung. Tài khoản cũ đã verified còn credential cũng bị chặn phiên vì cùng điều kiện (không cần migration dọn). Thay phần hook của D-081; giữ cổng emailVerified.
- Đường lùi: Revert PR #100

### D-083 · 2026-10-19T17:28:05+00:00 · S-012 sau D-082: nhân viên đăng ký mật khẩu luôn emailVerified=false nên không dùng được vai người thuê ở tổ chức khác (review Opus). Cho nhân viên đường chứng minh hộp thư thế nào?

- Phương án: (1) Nhận lời mời nhân viên bằng token gửi email (đã bắt buộc đăng nhập đúng email) đặt emailVerified=true · (2) Sửa SPEC S-012: nhân viên không được là người thuê · (3) Luồng OTP xác minh riêng cho nhân viên
- Chọn: Nhận lời mời nhân viên bằng token gửi email (đã bắt buộc đăng nhập đúng email) đặt emailVerified=true
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: token 256 bit chỉ gửi tới hộp thư được mời nên nhận lời mời là bằng chứng sở hữu tương đương OTP; không đổi SPEC, không luồng mới; kẻ squat email người thuê không có token nhân viên của nạn nhân. Chủ trọ tự đăng ký (org.create) vẫn chưa xác minh — dùng được vai người thuê ở tổ chức khác chỉ sau khi nhận một lời mời nhân viên; chấp nhận. Seed test: tham số verified, mặc định true.
- Đường lùi: Bỏ dòng update emailVerified ở accept-invitation

### D-084 · 2026-10-21T01:48:44+00:00 · Chủ dự án yêu cầu bỏ bớt check merge chưa cần ở pha build, chờ harden: hoãn cổng nào và hoãn thế nào để không mất tín hiệu?

- Phương án: (1) Chỉ bỏ khỏi ruleset, job vẫn chạy trên PR · (2) Hoãn 12 cổng (lighthouse, bundle-size, e2e-repeat, dast, sbom, image-scan x4, schema-compat, prometheus-rules, otel-collector): bỏ khỏi ruleset, không chạy trên PR, vẫn chạy push main/lịch; rào ci-gates đỏ khi delivery_phase: harden mà còn cổng hoãn · (3) Tắt hẳn các job đó
- Chọn: Hoãn 12 cổng (lighthouse, bundle-size, e2e-repeat, dast, sbom, image-scan x4, schema-compat, prometheus-rules, otel-collector): bỏ khỏi ruleset, không chạy trên PR, vẫn chạy push main/lịch; rào ci-gates đỏ khi delivery_phase: harden mà còn cổng hoãn
- Lý do (tiêu chí chất lượng cuối): Theo yêu cầu chủ dự án (2026-10-21). Phương án 1 không giảm ma sát: merge-check của khung coi mọi check đỏ là chặn, và rào D-065 đòi job chạy trên PR phải required. Phương án 2 giữ tín hiệu trên main, đường lùi rõ, và máy bắt khôi phục khi sang harden. Cổng giữ lại (17): kiểm mã, test, bảo mật cơ bản (gitleaks, dep-audit, sast), coverage, chính sách PR. Cổng hoãn là hiệu năng, quét image/SBOM/DAST và tương thích triển khai N−1 — chỉ có nghĩa khi có staging/production; image-scan còn có ngoại lệ grype hết hạn 2026-10-25 sẽ đỏ mọi PR.
- Đường lùi: Trả 12 context về .github/rulesets/main.json + WAVE9_GATES, gỡ if: push của các job (schema-compat về pull_request), DEFERRED_TO_HARDEN rỗng, người import lại ruleset.

### D-085 · 2026-10-21T04:29:48+00:00 · Chủ dự án (2026-10-21) yêu cầu bỏ hết thứ chưa cần, chờ harden — chọn: tắt 12 job D-084 trên main, hoãn thêm cổng PR về test, hoãn openapi/new-deps/sast. Làm thế nào?

- Phương án: (1) Xoá các job khỏi workflow · (2) Giữ định nghĩa job, if: chỉ workflow_dispatch (chạy tay); bỏ khỏi ruleset; DEFERRED_TO_HARDEN = 20 cổng; rào ci-gates đỏ khi delivery_phase: harden
- Chọn: Giữ định nghĩa job, if: chỉ workflow_dispatch (chạy tay); bỏ khỏi ruleset; DEFERRED_TO_HARDEN = 20 cổng; rào ci-gates đỏ khi delivery_phase: harden
- Lý do (tiêu chí chất lượng cuối): Đúng ba nhóm chủ dự án chọn. Giữ job giúp khôi phục ở harden chỉ là gỡ một dòng if + trả context vào ruleset; rào máy buộc khôi phục. Chỉ chạy tay ⇒ main không đỏ vì cổng chưa cần (ngoại lệ grype hết hạn 2026-10-25). Còn required 9: quality (gate+e2e+backup-restore+workflow-lint+onboarding-smoke), protection-guard, gitleaks, dep-audit, commit-lint, pr-policy, fe-typecheck, fe-lint, merge-gate. Đánh đổi chấp nhận: coverage/ratchet, hồi quy, tất định, SAST, lint OpenAPI, khai phụ thuộc mới không còn chặn — lỗi lộ muộn hơn.
- Đường lùi: Gỡ if: workflow_dispatch của 20 job (coverage-ratchet/fix-requires-test/schema-compat về if: pull_request), trả 20 context vào main.json + WAVE9_GATES, DEFERRED_TO_HARDEN rỗng, người sửa lại ruleset trên GitHub.

### D-086 · 2026-10-21T04:48:27+00:00 · Chủ dự án (2026-10-21): sửa ruleset ở mức tối thiểu — chọn giữ quality + gitleaks + merge-gate. Làm thế nào?

- Phương án: (1) Chỉ bỏ khỏi ruleset, job vẫn chạy trên PR · (2) Hoãn tới harden protection-guard, dep-audit, commit-lint, pr-policy, fe-typecheck, fe-lint (chỉ chạy tay); ruleset 3 check; tắt strict (nhánh không phải cập nhật với main)
- Chọn: Hoãn tới harden protection-guard, dep-audit, commit-lint, pr-policy, fe-typecheck, fe-lint (chỉ chạy tay); ruleset 3 check; tắt strict (nhánh không phải cập nhật với main)
- Lý do (tiêu chí chất lượng cuối): Đúng lựa chọn của chủ dự án. Phương án 1 trái rào D-065 (job chạy trên PR phải required) và merge-check của khung vẫn coi check đỏ là chặn. quality vẫn chạy build/typecheck/lint/toàn bộ test + E2E nên typecheck/lint frontend không mất hẳn; gitleaks giữ lớp bí mật; merge-gate giữ lớp chặn auto-merge PR ngoại lệ cứng. Tắt strict bớt vòng update-branch + chạy lại CI sau mỗi merge. Đánh đổi: không kiểm mẫu PR/commit message/phụ thuộc lỗ hổng/khớp ruleset trên PR.
- Đường lùi: Gỡ if: workflow_dispatch của 6 job (commit-lint, pr-policy lấy lại if trong chú thích 'Khi khôi phục'), trả context vào main.json + BASE_GATES/WAVE9_GATES, strict true, người sửa ruleset trên GitHub; delivery_phase: harden buộc khôi phục.

### D-087 · 2026-10-21T19:18:09+00:00 · Duyệt PLAN đợt 15 (hoàn thiện ở dev trước production): 9 task, 3 lát — quét A11Y, sửa 🟢 audit làm được trong repo, SeaweedFS bền cho dev?

- Phương án: (1) Duyệt PLAN 9 task như viết · (2) Chỉ quét A11Y + sửa tài liệu, để sửa mã sang đợt harden · (3) Mở rộng: chuyển 2359 chuỗi i18n (XC-I18N-001) trong đợt này
- Chọn: Duyệt PLAN 9 task như viết
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: các sửa đều có test đỏ trước, nhỏ, đảo ngược được; đóng lỗi người dùng thật thấy (quyền lệch múi giờ, danh sách cắt im lặng) trước production theo yêu cầu chủ dự án. Phương án 2 để lỗi đúng/sai tồn tại lâu hơn; phương án 3 phình phạm vi (nhiều đợt, ratchet đã chặn tăng).
- Đường lùi: Revert từng commit task; PLAN cũ ở archive/PLAN-dot-3-14.md

### D-088 · 2026-10-21T19:18:09+00:00 · Chỉ được đẩy lên một nhánh (claude/trusting-johnson-t1ylka) trong khi luật 'mỗi lát một PR' và PR #115 đang chờ người merge — tổ chức PR đợt 15 thế nào?

- Phương án: (1) Xếp chồng commit từng task lên nhánh của #115, PR #115 lớn dần, mô tả PR liệt kê task · (2) Commit cục bộ, chỉ đẩy khi #115 đã merge (nhánh khởi lại từ main) · (3) Tạo nhánh mới cho mỗi lát
- Chọn: Xếp chồng commit từng task lên nhánh của #115, PR #115 lớn dần, mô tả PR liệt kê task
- Lý do (tiêu chí chất lượng cuối): Ràng buộc phiên: chỉ được đẩy lên nhánh được giao (phương án 3 trái lệnh). Phương án 2 giữ việc chỉ ở container tạm — mất khi container bị thu hồi (vi phạm 'đẩy để giữ'). Phương án 1 giữ việc an toàn trên remote, mỗi task một commit nên review/revert theo commit được; đánh đổi: PR > 150 dòng.
- Đường lùi: Sau khi #115 merge: nhánh khởi lại từ main, các lát chưa merge tách PR riêng

### D-089 · 2026-10-21T21:15:34+00:00 · Duyệt PLAN đợt 16 (phần còn lại của audit 🟢): 6 task; bác bỏ AUD-SEC-003, để lại AUD-DATA-005/006, AUD-PERF-002, mã DUPLICATE?

- Phương án: (1) Duyệt PLAN 6 task như viết, các mục để lại ghi lý do ở sổ audit · (2) Làm cả AUD-PERF-002 và đổi mã DUPLICATE thống nhất · (3) Dừng, chờ chủ dự án merge #116
- Chọn: Duyệt PLAN 6 task như viết, các mục để lại ghi lý do ở sổ audit
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: rào CSDL theo vai trò và múi giờ là lỗi đúng/sai thật trước production; N+1 kỳ thu có hại đo được (≈1.300 round-trip/100 phòng). Đổi mã DUPLICATE là breaking API (tiêu chí 2 giữ đường lùi); AUD-PERF-002 chưa đo được hại; AUD-SEC-003 bị ma trận SPEC-access bác (đảo = điều chỉnh có lý do = payment.allocate). Phương án 3 bỏ phí thời gian khi còn việc tự làm được.
- Đường lùi: Revert từng commit task; migration 0065 có down

### D-090 · 2026-10-21T21:26:20+00:00 · T-1603: policy RESTRICTIVE ghi persons — ngoại lệ lúc khởi tạo (actor chưa có membership) và accountant có được INSERT persons không?

- Phương án: (1) Giữ ngoại lệ khởi tạo; accountant chỉ UPDATE (lockPerson), không INSERT · (2) Giữ ngoại lệ; accountant được cả INSERT/UPDATE · (3) Đổi thứ tự khởi tạo (membership trước person) để bỏ ngoại lệ
- Chọn: Giữ ngoại lệ khởi tạo; accountant chỉ UPDATE (lockPerson), không INSERT
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn — cách hiểu chặt hơn: không đường mã nào cho accountant tạo người, chỉ cần UPDATE/khoá hàng; ngoại lệ khởi tạo chỉ mở khi membership của actor chưa tồn tại (org.create, acceptInvitation), đổi thứ tự khởi tạo đụng FK person_id và luồng auth — rủi ro hơn lợi ích (tiêu chí 2).
- Đường lùi: Thêm accountant lại vào điều kiện INSERT của 0065 (migration mới)

### D-091 · 2026-10-22T03:26:00+00:00 · Chuyển pha harden (delivery_phase: harden): khôi phục 26 cổng hoãn theo D-084/D-085/D-086 thế nào?

- Phương án: (1) Khôi phục toàn bộ 26 cổng một lát: gỡ if: workflow_dispatch (coverage-ratchet/fix-requires-test/schema-compat về if: pull_request; commit-lint/pr-policy lấy if xét tác giả PR), bỏ trigger workflow_dispatch thêm vào lúc hoãn, trả 28 context vào main.json, strict true, DEFERRED_TO_HARDEN rỗng · (2) Khôi phục dần theo lô (cổng nền + chính sách PR trước, hiệu năng/quét image/DAST sau), giữ delivery_phase: build tới lô cuối
- Chọn: Khôi phục toàn bộ 26 cổng một lát: gỡ if: workflow_dispatch (coverage-ratchet/fix-requires-test/schema-compat về if: pull_request; commit-lint/pr-policy lấy if xét tác giả PR), bỏ trigger workflow_dispatch thêm vào lúc hoãn, trả 28 context vào main.json, strict true, DEFERRED_TO_HARDEN rỗng
- Lý do (tiêu chí chất lượng cuối): Phiên chính chọn chuyển harden. Đúng và an toàn: đường lùi của D-084/D-085/D-086 ghi sẵn từng bước, rào ci-gates đòi DEFERRED_TO_HARDEN rỗng khi harden nên khôi phục từng phần không qua được rào; giữ build tới lô cuối thì các lô đầu không được máy bắt. Bỏ trigger workflow_dispatch thêm lúc hoãn vì job như pr-policy/commit-lint/new-deps đọc ngữ cảnh PR, chạy tay sẽ đỏ vô nghĩa. Đánh đổi chấp nhận: CI mỗi PR nặng lại (lighthouse, e2e-repeat, dast, image-scan cần docker/mạng); ngoại lệ grype hết hạn 2026-10-25 có thể đỏ image-scan.
- Đường lùi: Revert commit khôi phục (đặt lại if: workflow_dispatch, DEFERRED_TO_HARDEN 26 cổng, ruleset 2 check strict false, delivery_phase: build); người import lại ruleset trên GitHub.

### D-092 · 2026-10-22T03:32:33+00:00 · Khôi phục cổng harden làm tổng timeout CI mỗi PR 730 > trần 600 phút — xử lý thế nào?

- Phương án: (1) Siết timeout e2e 40 → 15 phút (đo 2m19–3m33/shard), tổng 580 · (2) Nâng max_total_timeout_min 600 → 800 và ghi lý do · (3) Giảm số shard e2e
- Chọn: Siết timeout e2e 40 → 15 phút (đo 2m19–3m33/shard), tổng 580
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: siết chứ không nới ngưỡng (LOOP-CI-001), biên >4 lần thời gian đo; giảm shard đi ngược WF-CI-025 và kéo dài đường găng. Rủi ro: runner chậm bị huỷ ở 15 phút — đo lại nếu xảy ra.
- Đường lùi: Đặt lại timeout-minutes: 40 cho e2e và đề xuất nâng trần có lý do ở docs/PERF-BUDGET.md

### D-093 · 2026-10-22T08:44:08+00:00 · Duyệt PLAN đợt 17 (hạn ngoại lệ grype + i18n /co-so, /thanh-vien)?

- Phương án: (1) Duyệt PLAN 3 task như viết · (2) Chỉ làm T-1701, để i18n đợt sau
- Chọn: Duyệt PLAN 3 task như viết
- Lý do (tiêu chí chất lượng cuối): (1) đúng/an toàn: xử lý hạn 2026-10-25 trước; (3) i18n là MUST mở duy nhất máy làm tiếp được, lát nhỏ độc lập file, ratchet chặn lùi
- Đường lùi: Bỏ T-1702 khỏi PLAN, đóng PR lát 2

### D-094 · 2026-10-22T08:46:47+00:00 · T-1701: 4 luật grype critical (GO-2026-6612 HTTP/2 server; GO-2026-6604 chỉ Windows) hết hạn 2026-10-25, thượng nguồn chưa có image vá (rà 2026-10-22: Caddy mới nhất v2.11.7 — image 2.11.7-alpine dựng lại 2026-10-21 vẫn tải nhị phân phát hành v2.11.7/Go 1.26.8; SeaweedFS mới nhất 4.48; Go 1.26.10 đã có) — xử lý thế nào?

- Phương án: (1) Gia hạn ≤ 7 ngày (2026-10-29) theo D-067, ghi giảm nhẹ; tự dựng image trước production nếu thượng nguồn vẫn chưa vá · (2) Tự dựng image Caddy + SeaweedFS bằng Go 1.26.10 ngay (Dockerfile riêng, build trong CI) · (3) Tắt HTTP/2 ở Caddyfile và gỡ luật Caddy
- Chọn: Gia hạn ≤ 7 ngày (2026-10-29) theo D-067, ghi giảm nhẹ; tự dựng image trước production nếu thượng nguồn vẫn chưa vá
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: chưa có triển khai production nào (VPS chờ người) nên lỗ hổng chưa phơi ra; GO-2026-6604 không áp dụng Linux; SeaweedFS chỉ ở mạng nội bộ. (2)(3) tự dựng image đổi cách triển khai + thêm bảo trì chuỗi build khi thượng nguồn thường vá trong vài ngày; tắt h2 giảm trải nghiệm và không xử lý SeaweedFS. Hạn 7 ngày buộc rà lại.
- Đường lùi: Nếu 2026-10-29 vẫn chưa có bản vá hoặc sắp lên production: làm phương án 2 (deploy/caddy/Dockerfile, deploy/seaweedfs/Dockerfile với Go ≥ 1.26.9)
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Trước khi lên production: không chạy Caddy/SeaweedFS dựng bằng Go < 1.26.9 — nâng image vá hoặc tự dựng; tạm thời có thể tắt h2 ở Caddy (servers { protocols h1 h3 })

### D-095 · 2026-10-22T09:23:22+00:00 · Kiểm lại cuối đợt 17: 8 mục MUST [x] (BASE-REPO-008/013, WF-REVIEW-001/005, WF-GIT-001/002, QA-E2E-001, QA-STRAT-002) có lệnh Kiểm 'check-github-live ruleset' đỏ vì ruleset sống chưa import main.json bản D-091 (thiếu 27 context + strict) — xử lý thế nào?

- Phương án: (1) Bỏ tick về [ ] (giữ Kiểm), loop defer chờ người import; tick lại khi lệnh Kiểm xanh · (2) Giữ [x] vì yêu cầu cốt lõi (bảo vệ nhánh) vẫn đạt · (3) Nới check-github-live chỉ so tập con
- Chọn: Bỏ tick về [ ] (giữ Kiểm), loop defer chờ người import; tick lại khi lệnh Kiểm xanh
- Lý do (tiêu chí chất lượng cuối): (1) P1 bằng chứng, không lời khai: lệnh Kiểm đỏ thì mục chưa đạt; không nới công cụ kiểm (LOOP-CI-001). (2) đảo ngược: import xong chạy lại Kiểm rồi tick lại
- Đường lùi: Người import ruleset → chạy 'node scripts/check-github-live.mjs ruleset' xanh → tick lại 8 mục

### D-096 · 2026-10-22T09:47:47+00:00 · Duyệt PLAN đợt 18 (i18n 5 màn ngoài merge_risk_paths, hạ baseline)?

- Phương án: (1) Duyệt 3 task như viết · (2) Dừng, chờ người xử lý 99 MUST
- Chọn: Duyệt 3 task như viết
- Lý do (tiêu chí chất lượng cuối): (3)(4) XC-I18N-001 là MUST duy nhất máy làm được; chọn màn ngoài merge_risk_paths để PR theo làn L3; ratchet chặn lùi
- Đường lùi: Revert PR đợt 18

### D-097 · 2026-10-22T10:14:21+00:00 · XC-I18N-001 còn 2078 chuỗi / 181 tệp (795 ở apps/web, 1280 ở packages/app là thông báo lỗi/xuất file/thông báo; 831 chuỗi nằm trong merge_risk_paths ⇒ PR người merge) — làm tiếp theo đợt liên tục hay chuyển dần?

- Phương án: (1) Defer: chuyển dần theo màn khi sửa màn (ratchet chặn tăng), đợt riêng cho packages/app sau khi quyết cách trả mã lỗi + thông điệp (đổi API); chủ dự án duyệt nhịp · (2) Chạy tiếp ~10 đợt/PR liên tục tới hết
- Chọn: Defer: chuyển dần theo màn khi sửa màn (ratchet chặn tăng), đợt riêng cho packages/app sau khi quyết cách trả mã lỗi + thông điệp (đổi API); chủ dự án duyệt nhịp
- Lý do (tiêu chí chất lượng cuối): (1) packages/app đổi cách sinh thông điệp lỗi chạm hợp đồng API (cần quyết thiết kế, không cơ học); (2)(3) PR lớn liên tục quanh tiền/lưu trú dồn việc merge cho người, rủi ro đổi chữ; ratchet đã giữ không lùi; sản phẩm chỉ có một locale (vi) nên không chặn người dùng
- Đường lùi: Lập PLAN đợt i18n kế (mỗi đợt ≤ 5 màn ngoài merge_risk_paths) bất cứ lúc nào

### D-098 · 2026-10-22T10:34:53+00:00 · PR #123: bundle-size đỏ (324,98/300 kB gzip) vì vi.json (cả description) bị nhân bản vào 4 chunk client (booking-form, hold-countdown, accept-invitation, guest-stay) — sửa thế nào?

- Phương án: (1) Client không import catalog: server page truyền messagesFor(namespace) qua prop, client dùng tm(m, key, params) từ module định dạng thuần (type-only import); i18n-check kiểm tm() như t(); áp cho cả 4 client component · (2) Sinh catalog runtime bỏ description (≈5,2 kB × 4 chunk ≈ 312 kB, vẫn vượt) · (3) Nâng trần .size-limit.json
- Chọn: Client không import catalog: server page truyền messagesFor(namespace) qua prop, client dùng tm(m, key, params) từ module định dạng thuần (type-only import); i18n-check kiểm tm() như t(); áp cho cả 4 client component
- Lý do (tiêu chí chất lượng cuối): (1) không nới cổng (LOOP-CI-001); (3) bền: catalog lớn dần tới ~2000 khoá thì mọi cách bundle catalog vào client đều vượt — chỉ server dịch mới co giãn được; giữ kiểm khoá/tham số bằng i18n-check
- Đường lùi: Revert commit sửa; quay lại import t() ở client

### D-099 · 2026-10-23T06:01:30+00:00 · Duyệt PLAN đợt 19 (i18n 9 tệp ngoài merge_risk_paths, ~179 chuỗi, theo nhịp D-097)?

- Phương án: (1) Duyệt 3 task như viết · (2) Dừng, chờ người
- Chọn: Duyệt 3 task như viết
- Lý do (tiêu chí chất lượng cuối): (3)(4) XC-I18N-001 là việc máy duy nhất; lô nhỏ ngoài merge_risk_paths theo D-097; ràng buộc bundle D-098 có rào máy
- Đường lùi: Revert PR đợt 19

### D-100 · 2026-10-23T08:39:18+00:00 · Duyệt PLAN đợt 20 (i18n 13 tệp ngoài merge_risk_paths ~173 chuỗi; hoãn lib/format.ts vì client import)?

- Phương án: (1) Duyệt 3 task như viết · (2) Làm luôn format.ts
- Chọn: Duyệt 3 task như viết
- Lý do (tiêu chí chất lượng cuối): (1)(3) format.ts được client import — t() trong đó kéo catalog vào bundle (D-098), cần thiết kế tách nhãn riêng; lô 13 tệp còn lại cơ học, rào máy đủ
- Đường lùi: Revert PR đợt 20

### D-101 · 2026-10-24T04:45:09+00:00 · Đợt 21: hạ tầng client dùng chung (command-form, command-status, use-command, reauth-dialog, route-state, pwa-shell…) cần chuỗi i18n nhưng render từ rất nhiều trang — truyền thế nào?

- Phương án: (1) MessagesProvider (client context) ở app/layout với messagesFor('common.'), hook useMessages() + tm() · (2) Truyền prop m qua mọi trang dùng CommandForm/route-state · (3) Để nguyên chuỗi viết thẳng ở hạ tầng
- Chọn: MessagesProvider (client context) ở app/layout với messagesFor('common.'), hook useMessages() + tm()
- Lý do (tiêu chí chất lượng cuối): (1) giữ D-098: catalog không vào bundle, chỉ khoá common. trong payload RSC; (3) một điểm cấp, không sửa hàng chục trang; hook ném lỗi khi thiếu provider ⇒ test bắt; i18n-check vẫn kiểm tm()
- Đường lùi: Bỏ provider, truyền m qua prop như D-098

### D-102 · 2026-10-24T04:45:09+00:00 · Duyệt PLAN đợt 21 (i18n phần đuôi ngoài merge_risk_paths, trừ lib/format.ts)?

- Phương án: (1) Duyệt 3 task như viết · (2) Dừng
- Chọn: Duyệt 3 task như viết
- Lý do (tiêu chí chất lượng cuối): (3)(4) việc máy duy nhất còn lại; theo nhịp D-097; thiết kế D-102 có rào máy
- Đường lùi: Revert PR đợt 21

### D-103 · 2026-10-24T08:51:55+00:00 · D-103: apps/web/lib/format.ts (74 chuỗi nhãn) được cả server lẫn client import — chuyển i18n thế nào?

- Phương án: (1) Nhãn tách: hàm nhận m / dùng t() ở server; client lấy qua useMessages() (common.) hoặc prop m · (2) Giữ nguyên format.ts, miễn trừ
- Chọn: Nhãn tách: hàm nhận m / dùng t() ở server; client lấy qua useMessages() (common.) hoặc prop m
- Lý do (tiêu chí chất lượng cuối): (1) XC-I18N-001 đòi mọi chuỗi người dùng thấy; giữ D-098 (catalog không vào bundle)
- Đường lùi: Revert PR lát 1

### D-104 · 2026-10-24T08:51:56+00:00 · D-104: packages/app (1280 chuỗi: lỗi API, email, xuất/nhập) dùng catalog nào?

- Phương án: (1) Catalog riêng packages/app/messages/vi.json cùng định dạng + t() typed server-only; i18n-check kiểm 2 catalog; mã lỗi API giữ nguyên · (2) Dùng chung apps/web/messages/vi.json (packages/app import từ apps/web) · (3) Gói packages/i18n chung
- Chọn: Catalog riêng packages/app/messages/vi.json cùng định dạng + t() typed server-only; i18n-check kiểm 2 catalog; mã lỗi API giữ nguyên
- Lý do (tiêu chí chất lượng cuối): (3) đúng ranh giới module (ADR-0001: packages/app không phụ thuộc apps/web); không đổi API (mã lỗi giữ); (2) dễ gộp sau nếu cần locale thứ hai
- Đường lùi: Gộp catalog vào gói chung khi có locale thứ hai

### D-105 · 2026-10-24T08:51:56+00:00 · D-105: chuỗi tiếng Việt chỉ người vận hành/nhà phát triển thấy (log, mô tả metric, lỗi cấu hình lúc khởi động, mô tả OpenAPI) có thuộc XC-I18N-001 không?

- Phương án: (1) Không — ngoại lệ theo tệp có lý do trong baseline, script kiểm lý do không rỗng; mọi tệp khác về 0 · (2) Có — chuyển tất cả vào catalog
- Chọn: Không — ngoại lệ theo tệp có lý do trong baseline, script kiểm lý do không rỗng; mọi tệp khác về 0
- Lý do (tiêu chí chất lượng cuối): (1) MUST ghi 'chuỗi người dùng thấy (UI, email, thông báo đẩy, lỗi, PDF)'; log/metric/OpenAPI không phải; ngoại lệ hiển thị từng tệp + lý do nên không phải nới ngầm; reviewer rà danh sách
- Đường lùi: Bỏ danh sách ngoại lệ, chuyển nốt các tệp đó

### D-106 · 2026-10-24T09:54:02+00:00 · D-106: packages/app/src/http/command-inputs.ts (19 thông điệp lỗi zod của form) được trình duyệt nạp trễ — không được import catalog server (D-098). Chuyển i18n thế nào?

- Phương án: (1) A: catalog con an toàn cho client packages/app/messages/form.vi.json (chỉ câu form), i18n-check kiểm; nới danh sách import cho phép của command-inputs.test thêm đúng tệp này · (2) B: issueText(m, issue) với m truyền từ server/context — refactor apps/web/components/command · (3) C: để ratchet giữ 19 chuỗi (nợ)
- Chọn: A: catalog con an toàn cho client packages/app/messages/form.vi.json (chỉ câu form), i18n-check kiểm; nới danh sách import cho phép của command-inputs.test thêm đúng tệp này
- Lý do (tiêu chí chất lượng cuối): (1) XC-I18N-001 đòi mọi chuỗi; mục đích D-098 là không nhân bản catalog lớn vào bundle — catalog con ~1 kB chỉ chứa câu form trong chunk nạp trễ đáp ứng; (3) ít thay đổi nhất, không đổi luồng validate client/server; rào máy giữ (chỉ đúng tệp được phép)
- Đường lùi: Chuyển sang B nếu catalog form lớn dần

### D-107 · 2026-10-24T12:19:07+00:00 · D-107: i18n-literals chưa quét packages/domain (≈135 chuỗi: AuthzError/TransitionError ra API, mô tả dòng phiếu billing/engine, đọc số vnd-words, nhãn ma trận quyền) và packages/db (≈119, migration) — XC-I18N-001 chưa thật đạt. Xử lý?

- Phương án: (1) Mở rộng SCOPE sang packages/domain/src và packages/db/src; domain có catalog riêng (thuần, chỉ import JSON) như D-104, chuyển chuỗi người dùng thấy (kể cả từ vựng đọc số); packages/db: migration đã áp bất biến + thông báo RAISE không ra API (toProblem dùng title catalog) ⇒ ngoại lệ D-105 theo tệp có lý do + max sau khi kiểm từng tệp; packages/testkit (chỉ test) ngoài phạm vi · (2) Tick XC-I18N-001 với phạm vi hiện tại
- Chọn: Mở rộng SCOPE sang packages/domain/src và packages/db/src; domain có catalog riêng (thuần, chỉ import JSON) như D-104, chuyển chuỗi người dùng thấy (kể cả từ vựng đọc số); packages/db: migration đã áp bất biến + thông báo RAISE không ra API (toProblem dùng title catalog) ⇒ ngoại lệ D-105 theo tệp có lý do + max sau khi kiểm từng tệp; packages/testkit (chỉ test) ngoài phạm vi
- Lý do (tiêu chí chất lượng cuối): (1) P1 bằng chứng: MUST nói mọi chuỗi người dùng thấy (lỗi API, PDF/phiếu) — domain có chuỗi ra API và phiếu; không sửa migration đã áp (AGENTS §4)
- Đường lùi: Thu hẹp SCOPE lại (không khuyến nghị)
- Ghi chú (sau review 2026-10-24): nhãn ma trận quyền `packages/domain/src/access/matrix.ts` không ra UI/API (chỉ test đồng bộ spec) ⇒ đi theo ngoại lệ D-105 có lý do + max, không vào catalog.

### D-108 · 2026-10-24T12:54:03+00:00 · D-108: packages/domain/src/format/intl.ts (ký hiệu 'đ' + 4 RangeError nội bộ) được client import qua @hm/app/format — catalog con format.vi.json (mẫu D-106, +~3 kB gzip) hay ngoại lệ D-105?

- Phương án: (1) A: catalog con packages/domain/messages/format.vi.json + formatText (mở rộng D-106 sang domain) · (2) B: ngoại lệ D-105 (coi 'đ' là dữ liệu định dạng locale)
- Chọn: A: catalog con packages/domain/messages/format.vi.json + formatText (mở rộng D-106 sang domain)
- Lý do (tiêu chí chất lượng cuối): (1) 'đ' người dùng thấy trên mọi số tiền — XC-I18N-001 đòi qua tài nguyên; nhất quán D-106; +3 kB vẫn trong ngân sách 300 kB (282,3)
- Đường lùi: Phương án B: bỏ formatText/format.vi.json, thêm 1 dòng ngoại lệ

### D-109 · 2026-10-25T01:21:11+00:00 · D-109: CSDL grype 2026-10-24 thêm 6 lỗ hổng high/critical (body-parser, happy-dom, zod 3 qua lighthouse; undici trong npm của node; brotli-libs Alpine trong caddy/seaweedfs) làm đỏ sbom + image-scan trên mọi PR. Xử lý?

- Phương án: (1) Vá thật chỗ có bản vá (override body-parser 1.20.9, happy-dom 21.0.4) + ngoại lệ có hạn D-067 cho chỗ chưa có image vá/bản vá cùng major (brotli critical ≤ 7 ngày, undici/zod high 14 ngày theo VULN-SLA), theo dõi ở VULN-SLA · (2) Tự dựng image dẫn xuất apk upgrade cho caddy/seaweedfs ngay · (3) Hạ severity-cutoff/tắt only-fixed
- Chọn: Vá thật chỗ có bản vá (override body-parser 1.20.9, happy-dom 21.0.4) + ngoại lệ có hạn D-067 cho chỗ chưa có image vá/bản vá cùng major (brotli critical ≤ 7 ngày, undici/zod high 14 ngày theo VULN-SLA), theo dõi ở VULN-SLA
- Lý do (tiêu chí chất lượng cuối): (1) đúng và an toàn: vá thật mọi chỗ vá được; ngoại lệ chỉ cho gói không vào production (npm trong image bị xoá ở runtime, zod 3 chỉ trong CI) hoặc nhị phân Go không liên kết libbrotli, có hạn ngắn và kiểm hạn tự động; (2) phương án 2 đổi cách triển khai — câu hỏi mở đã có (zlib, D-094) cho chủ dự án; (3) bị cấm (nới cổng)
- Đường lùi: Gỡ luật ở .grype.yaml + dòng VULN-SLA; trả happy-dom 20.14.5 và bỏ override body-parser

### D-110 · 2026-10-25T03:27:02+00:00 · D-110: chủ dự án yêu cầu tự dựng image vá cho caddy và seaweedfs (Go 1.26.8 + Alpine chưa vá, 24 luật grype có hạn). Cách dựng?

- Phương án: (1) Dựng từ mã nguồn đúng phiên bản (Caddy v2.11.7, SeaweedFS 4.48 commit 530be3e) bằng Go 1.26.10 + x/net v0.61.0 trên alpine:3.24.3 + apk upgrade; gỡ 24 luật (ADR-0006) · (2) Image dẫn xuất FROM chính thức + apk upgrade (chỉ vá OS, còn Go Critical) · (3) Nâng SeaweedFS 4.49 từ mã nguồn
- Chọn: Dựng từ mã nguồn đúng phiên bản (Caddy v2.11.7, SeaweedFS 4.48 commit 530be3e) bằng Go 1.26.10 + x/net v0.61.0 trên alpine:3.24.3 + apk upgrade; gỡ 24 luật (ADR-0006)
- Lý do (tiêu chí chất lượng cuối): (1) đúng và an toàn: vá cả nhị phân Go (GO-2026-6612 Critical) lẫn OS, giữ đúng phiên bản ứng dụng nên không đổi hành vi; kiểm commit + go mod verify + FROM ghim digest; grype cục bộ: weed 0, caddy chỉ 1 Medium, alpine 0; (2) đường lùi một PR; (3) phương án 2 không gỡ được ngoại lệ Critical; phương án 3 đổi phiên bản ngoài phạm vi
- Đường lùi: Trả image chính thức (digest cũ) ở compose/supply-chain/release và khôi phục luật .grype.yaml từ lịch sử git

### D-111 · 2026-10-25T04:32:39+00:00 · D-111: Giấy phép mã nguồn (BASE-REPO-004, CMP-LIC-001) — chủ dự án nói 'làm hết' nhưng chưa chọn giấy phép

- Phương án: (1) Proprietary (All rights reserved), chủ sở hữu = chủ repo seeker19110; package.json license UNLICENSED; THIRD_PARTY_NOTICES sinh từ phụ thuộc production, CI so khác · (2) Giấy phép mở OSI (MIT/AGPL)
- Chọn: Proprietary (All rights reserved), chủ sở hữu = chủ repo seeker19110; package.json license UNLICENSED; THIRD_PARTY_NOTICES sinh từ phụ thuộc production, CI so khác
- Lý do (tiêu chí chất lượng cuối): (1) an toàn/chặt nhất: không trao quyền gì cho bên ngoài, đổi sang OSI về sau được (ngược lại thì không); (2) giữ đường lùi; SaaS thương mại
- Đường lùi: Thay LICENSE + trường license bằng SPDX OSI khi chủ dự án quyết

### D-112 · 2026-10-25T04:32:39+00:00 · D-112: Kênh báo lỗ hổng (BASE-SEC-009, XC-OSS-004) — chưa có email bảo mật

- Phương án: (1) GitHub Private Vulnerability Reporting làm kênh chính (URL advisories/new), SECURITY.md SLA phản hồi ≤ 7 ngày (≤ 14 theo MUST), security.txt trỏ cùng URL; chủ dự án bật PVR (1 công tắc) · (2) Dùng email cá nhân của chủ dự án
- Chọn: GitHub Private Vulnerability Reporting làm kênh chính (URL advisories/new), SECURITY.md SLA phản hồi ≤ 7 ngày (≤ 14 theo MUST), security.txt trỏ cùng URL; chủ dự án bật PVR (1 công tắc)
- Lý do (tiêu chí chất lượng cuối): (1) không công bố email cá nhân (dữ liệu cá nhân); PVR riêng tư, có nhật ký; (3) chuẩn GitHub/OpenSSF
- Đường lùi: Thêm email bảo mật riêng vào SECURITY.md/security.txt khi có

### D-113 · 2026-10-25T04:32:39+00:00 · D-113: BASE-REPO-006 — release-please tạo tag thường; ruleset tags cấm sửa/xoá v*

- Phương án: (1) Job assets tạo annotated tag vX.Y.Z trên đúng RELEASE_SHA rồi mới công khai Release; release-please cập nhật cả apps/web/package.json (extra-files) để /api/version khớp tag · (2) Tạo tag tay mỗi lần phát hành
- Chọn: Job assets tạo annotated tag vX.Y.Z trên đúng RELEASE_SHA rồi mới công khai Release; release-please cập nhật cả apps/web/package.json (extra-files) để /api/version khớp tag
- Lý do (tiêu chí chất lượng cuối): (1) máy làm, không quên; tag tạo trước khi Release hết nháp nên GitHub dùng tag có sẵn; (3) chuẩn SemVer + OpenSSF version_tags
- Đường lùi: Bỏ bước tạo tag trong release.yml

### D-114 · 2026-10-25T04:32:39+00:00 · D-114: CMP-LIC-004 — ngoại lệ @img/sharp-libvips-linux-x64 LGPL-3.0-or-later (D-061, hạn 2026-12-31) chờ duyệt

- Phương án: (1) Chấp nhận: LGPL liên kết động qua sharp của Next, không sửa thư viện, không phân phối nhị phân sửa đổi; giữ hạn rà 2026-12-31 · (2) Thay sharp (tắt tối ưu ảnh Next)
- Chọn: Chấp nhận: LGPL liên kết động qua sharp của Next, không sửa thư viện, không phân phối nhị phân sửa đổi; giữ hạn rà 2026-12-31
- Lý do (tiêu chí chất lượng cuối): (1) LGPL là giấy phép OSI, liên kết động thoả điều kiện; không phải source-available; (3) giữ tối ưu ảnh; ngoại lệ có hạn và lý do trong license-policy.json
- Đường lùi: Bỏ sharp/thay images.unoptimized, gỡ ngoại lệ

### D-115 · 2026-10-25T04:33:36+00:00 · Duyệt PLAN đợt 23 (làm hết phần máy làm được của 89 MUST; 15 task, 6 lát)

- Phương án: (1) Duyệt như PLAN · (2) Chỉ làm lát A+B (không chạm dữ liệu/auth)
- Chọn: Duyệt như PLAN
- Lý do (tiêu chí chất lượng cuối): (1) chủ dự án yêu cầu 'làm hết'; lát dữ liệu/auth vẫn do người merge nên an toàn; (2) mỗi lát một PR, revert được
- Đường lùi: Dừng sau lát bất kỳ; PR chưa merge đóng lại

### D-116 · 2026-10-25T05:25:21+00:00 · D-116: Hạn lưu cho bảng chưa có job dọn + ẩn danh người/giấy tờ (STD-PRIV-005, XC-GREEN-007) — pháp lý chưa chốt

- Phương án: (1) Mặc định chặt, cấu hình được, đánh dấu chờ pháp lý: notifications 180 ngày; worker_heartbeats 30 ngày không cập nhật; phiên đăng nhập 30 ngày sau hết hạn; mã xác minh 1 ngày sau hết hạn; liên kết khách 90 ngày sau hết hạn/thu hồi; inbox (chứng từ ngân hàng) 10 năm; giấy tờ nhận dạng ẩn danh 12 tháng sau khi kết thúc lưu trú/thuê cuối; persons ẩn danh 10 năm sau quan hệ tiền/thuê cuối (giữ đối chiếu chứng từ) · (2) Chờ pháp lý chốt rồi mới viết job
- Chọn: Mặc định chặt, cấu hình được, đánh dấu chờ pháp lý: notifications 180 ngày; worker_heartbeats 30 ngày không cập nhật; phiên đăng nhập 30 ngày sau hết hạn; mã xác minh 1 ngày sau hết hạn; liên kết khách 90 ngày sau hết hạn/thu hồi; inbox (chứng từ ngân hàng) 10 năm; giấy tờ nhận dạng ẩn danh 12 tháng sau khi kết thúc lưu trú/thuê cuối; persons ẩn danh 10 năm sau quan hệ tiền/thuê cuối (giữ đối chiếu chứng từ)
- Lý do (tiêu chí chất lượng cuối): (1) đúng và an toàn: tối thiểu hoá dữ liệu ngay, vẫn giữ phần nghĩa vụ kế toán 10 năm; mục đích thông báo lưu trú xong lúc nhận phòng nên giấy tờ không cần giữ lâu; (2) hằng số một chỗ, đổi một dòng; ẩn danh thay vì xoá giữ toàn vẹn sổ tiền (FK RESTRICT)
- Đường lùi: Đổi hằng số trong packages/app/src/retention/policy.ts; tắt job bằng cấu hình worker

### D-117 · 2026-10-25T06:19:19+00:00 · T-2308: ẩn danh payload inbox (append-only, trigger app.inbox_immutable) và cách tính sàn 10 năm chứng từ kế toán

- Phương án: (1) Nới trigger đúng một đường: raw → '{}' sau sàn 10 năm tính từ hết năm phát sinh, bỏ qua bản ghi pending; chỉ hàm SECURITY DEFINER của app_worker gọi được · (2) Giữ inbox bất biến, không ẩn danh (vi phạm hạn RET khi hết 10 năm) · (3) Xoá cả dòng inbox khi hết hạn (mất dấu idempotency/đối soát)
- Chọn: Nới trigger đúng một đường: raw → '{}' sau sàn 10 năm tính từ hết năm phát sinh, bỏ qua bản ghi pending; chỉ hàm SECURITY DEFINER của app_worker gọi được
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: giữ khoá idempotency và số tiền để đối soát, chỉ bỏ PII trong raw; đường nới hẹp, có test chặn mọi cập nhật khác; tính từ hết năm là cách hiểu chặt hơn của Luật Kế toán (chưa xác minh điều khoản)
- Đường lùi: Migration 0066 có down khôi phục trigger cũ và gỡ hàm; dữ liệu đã ẩn danh không khôi phục (đúng mục đích)

### D-118 · 2026-10-25T06:23:06+00:00 · T-2309: kênh analytics sản phẩm (PM-METRIC-003/005/006)

- Phương án: (1) Tự host: bảng product_events trong Postgres, một hàm track() kiểm allowlist sự kiện + thuộc tính kiểu đóng, actor là ID giả danh HMAC (khoá theo môi trường), giữ 13 tháng, xoá tài khoản ⇒ xoá dòng theo actor · (2) PostHog tự host · (3) SDK SaaS (PostHog Cloud/Plausible)
- Chọn: Tự host: bảng product_events trong Postgres, một hàm track() kiểm allowlist sự kiện + thuộc tính kiểu đóng, actor là ID giả danh HMAC (khoá theo môi trường), giữ 13 tháng, xoá tài khoản ⇒ xoá dòng theo actor
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: không gửi dữ liệu ra ngoài, không thêm bên xử lý; schema đóng + cấm PII kiểm được bằng test; đơn giản, không thêm dịch vụ chạy; đường lùi: đổi đích trong track() là một điểm
- Đường lùi: track() là điểm duy nhất — thay bộ ghi sang công cụ khác; migration có down
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Khi cần dashboard: PostHog tự host hoặc Metabase đọc product_events (chưa cần)

### D-119 · 2026-10-25T06:27:55+00:00 · T-2310: mục đích cần đồng ý và cách ghi (CMP-RIGHTS-001, CMP-VN-001, CMP-RIGHTS-004)

- Phương án: (1) Bảng consent_records append-only (mỗi lần cấp/rút là một dòng, trạng thái hiện tại = dòng mới nhất theo subject+purpose); danh mục mục đích đóng: service_core (bắt buộc để dùng dịch vụ, thu ở đăng ký/nhận lời mời/OTP portal lần đầu), product_analytics (tuỳ chọn, mặc định KHÔNG — opt-in); track() bỏ qua actor chưa đồng ý product_analytics; rút ở trang Bảo mật một bước như lúc cấp · (2) Cột cờ trên bảng user (mất lịch sử, không chứng minh được thời điểm/phiên bản chính sách) · (3) Banner đồng ý chung một lần cho mọi mục đích (gộp mục đích — trái Luật 91/2025 về đồng ý theo từng mục đích, chưa xác minh điều)
- Chọn: Bảng consent_records append-only (mỗi lần cấp/rút là một dòng, trạng thái hiện tại = dòng mới nhất theo subject+purpose); danh mục mục đích đóng: service_core (bắt buộc để dùng dịch vụ, thu ở đăng ký/nhận lời mời/OTP portal lần đầu), product_analytics (tuỳ chọn, mặc định KHÔNG — opt-in); track() bỏ qua actor chưa đồng ý product_analytics; rút ở trang Bảo mật một bước như lúc cấp
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: cách hiểu chặt hơn — đồng ý riêng từng mục đích, chứng minh được (phiên bản chính sách, kênh, băm ảnh chụp UI), analytics opt-in; append-only giữ dấu vết; đơn giản, test được
- Đường lùi: Bảng mới, migration có down; mục đích mới thêm vào danh mục không đổi dòng cũ

### D-120 · 2026-10-25T06:28:13+00:00 · T-2311: DSAR và xoá tài khoản (STD-PRIV-004, CMP-VN-007, CMP-INTL-007, CMP-RIGHTS-007, CMP-PRIV-005)

- Phương án: (1) Yêu cầu chủ thể lưu ở bảng dsar_requests (loại access/delete/restrict, hạn = ngày nhận + dsar_days theo vùng trong cấu hình repo: VN 3 ngày làm việc ≈ 72 giờ cho xoá (chưa xác minh), EU 30 ngày); xuất JSON dữ liệu của chính người dùng (đồng bộ, có xác thực lại ≤ 5 phút); xoá tài khoản = xác thực lại → thu hồi phiên → xoá analytics/consent liên kết/thành viên → ẩn danh user auth, GIỮ chứng từ tiền (nghĩa vụ kế toán) có ghi lý do trong kết quả; metric dsar_overdue · (2) Chỉ cho xuất/xoá qua email tới quản trị (thủ công, không kiểm được hạn)
- Chọn: Yêu cầu chủ thể lưu ở bảng dsar_requests (loại access/delete/restrict, hạn = ngày nhận + dsar_days theo vùng trong cấu hình repo: VN 3 ngày làm việc ≈ 72 giờ cho xoá (chưa xác minh), EU 30 ngày); xuất JSON dữ liệu của chính người dùng (đồng bộ, có xác thực lại ≤ 5 phút); xoá tài khoản = xác thực lại → thu hồi phiên → xoá analytics/consent liên kết/thành viên → ẩn danh user auth, GIỮ chứng từ tiền (nghĩa vụ kế toán) có ghi lý do trong kết quả; metric dsar_overdue
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: tự phục vụ, xác thực lại, hạn kiểm bằng máy, giữ phần nghĩa vụ pháp lý có lý do; số ngày theo vùng là cấu hình, đánh dấu chưa xác minh tới khi pháp lý chốt
- Đường lùi: Bảng mới + route mới; tắt route là quay lại

### D-121 · 2026-10-25T06:28:14+00:00 · T-2312: vòng đời xoá tổ chức (IND-SAAS-006, UX-CONTENT-005)

- Phương án: (1) Owner yêu cầu xoá (xác thực lại) → tổ chức vào trạng thái pending_deletion 30 ngày (chỉ đọc + xuất, huỷ được một bước) → job worker purge mọi kho (DB theo org, object theo tiền tố org, analytics) trừ chứng từ tiền giữ theo hạn kế toán → ghi chứng nhận xoá (org_deletion_certificates: thời điểm, số dòng/object theo kho, băm) · (2) Xoá ngay không thời gian ân hạn · (3) Chỉ vô hiệu hoá, không purge
- Chọn: Owner yêu cầu xoá (xác thực lại) → tổ chức vào trạng thái pending_deletion 30 ngày (chỉ đọc + xuất, huỷ được một bước) → job worker purge mọi kho (DB theo org, object theo tiền tố org, analytics) trừ chứng từ tiền giữ theo hạn kế toán → ghi chứng nhận xoá (org_deletion_certificates: thời điểm, số dòng/object theo kho, băm)
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: có ân hạn chống xoá nhầm, xuất trước khi mất, purge kiểm được bằng chứng nhận; huỷ không khó hơn đăng ký (UX-CONTENT-005)
- Đường lùi: Trong 30 ngày huỷ được; sau purge chỉ còn bản sao lưu tới hết RET-10

### D-122 · 2026-10-25T06:28:14+00:00 · T-2313: nhật ký hoạt động cho admin và truy cập hỗ trợ (IND-SAAS-009, CMP-AUDIT-002)

- Phương án: (1) Màn nhật ký đọc audit_events theo org (RLS), lọc theo thời gian/người/loại, xuất CSV qua cơ chế exports sẵn có; truy cập hỗ trợ = owner cấp support_grants (lý do, TTL ≤ 72 giờ, thu hồi được), mọi hành động của platform_support khi có grant ghi audit và hiển thị cho tenant · (2) Hỗ trợ dùng BYPASSRLS (không kiểm được, trái TM-12)
- Chọn: Màn nhật ký đọc audit_events theo org (RLS), lọc theo thời gian/người/loại, xuất CSV qua cơ chế exports sẵn có; truy cập hỗ trợ = owner cấp support_grants (lý do, TTL ≤ 72 giờ, thu hồi được), mọi hành động của platform_support khi có grant ghi audit và hiển thị cho tenant
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn: quyền tạm thời do tenant cấp, có hạn và nhìn thấy được; dùng lại audit/exports sẵn có
- Đường lùi: Không có grant thì hỗ trợ không có quyền gì (như hiện nay)

### D-123 · 2026-10-25T06:28:14+00:00 · T-2314: hạn mức theo gói và fair-share (IND-SAAS-008)

- Phương án: (1) Gói khai báo trong repo (packages/app/src/plans/plans.ts: free/standard; hạn mức số cơ sở, phòng, thành viên, job/phút); kiểm hạn mức trong command; worker dùng pg-boss singletonKey/hàng đợi theo org với trần đồng thời mỗi org để tenant bão hoà không chặn tenant khác; test tải hai tenant · (2) Bảng gói trong CSDL có UI quản trị (chưa cần, chưa có thanh toán)
- Chọn: Gói khai báo trong repo (packages/app/src/plans/plans.ts: free/standard; hạn mức số cơ sở, phòng, thành viên, job/phút); kiểm hạn mức trong command; worker dùng pg-boss singletonKey/hàng đợi theo org với trần đồng thời mỗi org để tenant bão hoà không chặn tenant khác; test tải hai tenant
- Lý do (tiêu chí chất lượng cuối): Bền và đơn giản: chưa có thanh toán/gói thật nên cấu hình trong repo đủ, đổi được qua PR; fair-share giải rủi ro noisy neighbour có test
- Đường lùi: Gỡ kiểm hạn mức là quay lại không giới hạn

### D-124 · 2026-10-25T07:24:49+00:00 · T-2310 câu hỏi mở: tài khoản cũ thiếu service_core, ghi đồng ý đăng ký ngoài transaction, consent_records khi xoá tài khoản, API portal, đổi phiên bản chính sách

- Phương án: (1) Giữ: chưa có người dùng thật (pre-production) nên mọi tài khoản thật sẽ đi luồng mới; lỗi ghi đồng ý sau đăng ký log error + tự cấp lại ở /bao-mat; consent_records GIỮ làm bằng chứng đồng ý khi xoá tài khoản (T-2311 ẩn danh auth user, không xoá hàng); API portal dựa trang portal chặn — thêm kiểm ở API và luồng xin lại đồng ý khi đổi CONSENT_POLICY_VERSION ghi là việc tiếp theo trước khi chạy thật · (2) Chặn mọi trang nhân viên tới khi đồng ý + tự viết route đăng ký trong một transaction + kiểm đồng ý ở mọi API portal ngay
- Chọn: Giữ: chưa có người dùng thật (pre-production) nên mọi tài khoản thật sẽ đi luồng mới; lỗi ghi đồng ý sau đăng ký log error + tự cấp lại ở /bao-mat; consent_records GIỮ làm bằng chứng đồng ý khi xoá tài khoản (T-2311 ẩn danh auth user, không xoá hàng); API portal dựa trang portal chặn — thêm kiểm ở API và luồng xin lại đồng ý khi đổi CONSENT_POLICY_VERSION ghi là việc tiếp theo trước khi chạy thật
- Lý do (tiêu chí chất lượng cuối): Đúng và an toàn ở mức đủ cho pre-production: không có dữ liệu thật; bằng chứng đồng ý là nghĩa vụ chứng minh nên giữ hàng; phương án 2 tăng phạm vi lớn (viết lại đăng ký Better Auth) với lợi ích chỉ có khi đã có người dùng
- Đường lùi: Các mục còn lại ghi vào GO-NO-GO trước G7; làm được trong một PR sau
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Trước khi có người dùng thật: kiểm đồng ý ở API portal, xin lại đồng ý khi đổi phiên bản chính sách
