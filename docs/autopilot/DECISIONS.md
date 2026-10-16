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
- Đường lùi: Migration down bỏ cột; phụ lục đã tạo vẫn là phiên bản hợp lệ, chỉ cần chặn tạo mới.

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

### D-026 · 2026-10-16T14:21:42+00:00 · T-301: sự kiện outbox chưa có consumer — giữ ở hàng đợi hay đánh dấu đã phát?

- Phương án: (1) Đánh dấu đã phát không sinh job (consumer thêm sau không nhận sự kiện cũ), log + đếm · (2) Tạo queue lười cho mọi event_type, job chất đống trong pgboss.job tới khi có consumer · (3) Để nguyên ở outbox (chặn đầu hàng vì claim lấy cũ nhất trước)
- Chọn: Đánh dấu đã phát không sinh job (consumer thêm sau không nhận sự kiện cũ), log + đếm
- Lý do (tiêu chí chất lượng cuối): (1) đúng: phương án 3 làm kẹt toàn bộ outbox; phương án 2 tích job không giới hạn, không ai xử lý. Sự kiện không consumer là sự kiện chỉ để audit/tương lai; dữ liệu nguồn vẫn nằm trong bảng nghiệp vụ + audit_events nên consumer mới có thể backfill có chủ đích. (3) đơn giản, đo được.
- Đường lùi: Đổi sang queue lười bằng một thay đổi ở relay.ts; sự kiện đã đánh dấu vẫn còn trong outbox để phát lại thủ công.
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
