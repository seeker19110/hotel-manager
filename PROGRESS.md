# PROGRESS.md — Hotel Manager

> Giai đoạn hiện tại: G5–G6 (autopilot đợt 3: khách sạn, buồng phòng/sự cố, portal, thông báo, báo cáo) · Cập nhật: 2026-10-16 · Nhánh: claude/peaceful-bardeen-27pu17 (xếp chồng lên PR #5 — D-001)

## Đang làm
- Autopilot đợt 3 (`docs/autopilot/PLAN.md`, 22 task, 100 vòng/96 giờ, `loop init` 2026-10-16 01:13Z): **13/22 xong có bằng chứng** (`.autopilot/evidence/` — T-201…T-209, T-211, T-212, T-216, T-219). Review độc lập lát khách sạn/thông báo: 0 🔴 · 2 🟠 · 2 🟢 + 4 nghi vấn — đã sửa hết kèm test (commit 2003d6c).
- Dừng giữa chừng để bàn giao: **T-210** mới có khung `packages/app/src/files/clamd.ts` (`ClamdScanner` zINSTREAM) + `ScanUnavailableError` ở `inspect.ts` — commit WIP, CHƯA có test, CHƯA nối vào server context. **T-217** chưa bắt đầu sửa file.

## Tiếp theo
1. Tiếp autopilot: `python3 .xtemplates/scripts/xt.py loop status` → T-210 (phiếu sự cố + ảnh + test hợp đồng clamd giả trong test, chọn scanner theo `CLAMD_HOST`, fail-closed production — D-003/D-008), rồi T-217 (4 báo cáo khớp sổ + nối "việc dọn" của `today.getSummary` sang bảng `tasks`), T-213…T-215 (portal, "Tôi đã chuyển", liên kết khách), T-218 (xuất CSV), T-220 (health/metrics), T-221 (UI + E2E, gồm route tải file thông báo lưu trú — D-014), T-222 (rà blueprint). Gate mỗi task: `loop record --task T-xxx -- <Gate y nguyên trong PLAN>`; executor song song dùng dải migration riêng; `export PATH=/root/.local/bin:$PATH` trước test (SeaweedFS `weed`).
2. Sau T-222: review độc lập lát còn lại, mở PR đợt 3 nhắm vào nhánh PR #5 (`claude/gifted-noether-iybenn`) hoặc `main` nếu PR #5 đã merge.
3. Chủ dự án quyết (không chặn vòng lặp): merge PR #5; mã hoá cột số giấy tờ (cần khoá + bỏ cột chữ rõ); chọn SMTP relay + adapter `EmailSender` thật (đặt `NOTIFICATION_TOKEN_SECRET`); duyệt hạ tầng ClamAV (RAM ≥ 3 GiB); huỷ đăng ký email bằng POST one-click (cần miễn trừ same-origin); 3 câu treo ở PR #5 (hợp đồng không thời hạn đổi giá, quản lý đặt giá dịch vụ, 32 miễn blueprint + XC-OSS-001/007, IND-FIN-008); import ruleset `.github/rulesets/main.json`.
4. Người làm song song: quan sát 6–10 cơ sở + baseline M-01…M-03; DPIA + pháp lý đối chiếu bản gốc; mẫu file thông báo lưu trú của cơ quan (chưa xác minh); VPS tại VN + kho sao lưu khác máy; giấy phép mã nguồn.

## Quyết định
- 2026-10-15 Repo sản phẩm + khung X-Templates ở `.xtemplates/`; tự host toàn bộ (ADR-0002); stack ADR-0001; blueprint web-app + saas-multitenant + fintech, M (4 miễn đã duyệt). Chi tiết đợt 1–2: `docs/autopilot/archive/PLAN-dot-1.md`, `PLAN-dot-2.md`, git log PR #4/#5.
- 2026-10-15 Đợt 1 merge (PR #4); đợt 2 xong ở PR #5 (xanh, chờ chủ dự án merge). Gate `pnpm test:db -- x` chạy TOÀN BỘ test DB (bộ lọc không áp).
- 2026-10-16 Sửa khung X-Templates (#49) + nâng `.xtemplates` lên 59a8fce (PR #7): pipefail cho `loop record`/dev-task, hook cổng commit chạy đúng repo, verdict/blueprint-status chặt hơn; task `[~]` phải ghi `— Bỏ: <lý do>`. FB-005…007, FB-040 (Broken pipe khi `xt.py … | head`).
- 2026-10-16 Đợt 3 tự duyệt D-001…D-017 (`docs/autopilot/DECISIONS.md`), chính: D-001 xếp chồng lên PR #5 · D-002 mặc định 15 câu [chặn] (tham số theo cơ sở) · D-003 ClamAV tự host qua adapter · D-005 giờ chốt khách sạn 04:00 · D-006 đêm cuối tuần ở `rate_plans.weekend_nights` · D-007 xác nhận booking cần khoản thu đã xác nhận (cờ cơ sở để nới) · D-009 tiền phòng ghi lúc check-in · D-012/D-015 folio: ứng trước gắn booking (`payments.reservation_id`, ứng trước nhập qua `journal_entries.reservation_id`), cho nợ khoá người nợ + hạn ≤ 30 ngày trong yêu cầu duyệt, bộ đếm `allocated_total` tính lại từ Σ phân bổ · D-010 thông báo: retry 5 lần, email không ghi số tiền, huỷ đăng ký GET token HMAC · D-014 hạn thông báo lưu trú (23:00/08:00, nước ngoài theo cấu hình) · D-016 audit: sự kiện cấp tổ chức chỉ owner · D-017 việc dọn tạo cùng transaction trả phòng, tách người làm/nghiệm thu.
- 2026-10-16 Không đưa vào đợt 3 (cần người): mã hoá `identity_documents.doc_number`; gửi email/thông báo thật; triển khai ClamAV thật.
- Nợ kỹ thuật chấp nhận: pháp lý trong `docs/research/` chỉ nguồn thứ cấp — đối chiếu văn bản gốc trước dữ liệu thật; RLS `audit_events` mới theo tổ chức (phạm vi cơ sở kiểm ở app — D-016); `listTasks` chưa phân trang.

## Bàn giao phiên
- 2026-10-16. Commit cuối trên nhánh chính: `da4a086df859a5e664028744b458bc671bccf116` (PR #7). Nhánh làm việc `claude/peaceful-bardeen-27pu17` (đầu = commit bàn giao này), gộp đầu PR #5 (nhánh `claude/gifted-noether-iybenn`).
- Autopilot: bật, verdict `continue — T-210`; phiên sau chỉ cần nhắn "tiếp tục" (đọc mục *Tiếp theo* 1). `.autopilot/` là cục bộ (gitignore): container mới mất bằng chứng cũ → `loop status` có thể báo `verify` cho task đã tick; chạy lại `loop record` với đúng Gate để tái tạo bằng chứng, không tick lại tay.
- Lệnh kiểm: `.xtemplates/scripts/dev-task.sh gate` · `pnpm test:db` · `pnpm --filter web exec playwright test` · `bash scripts/db-backup-restore-check.sh`. Container mới: `bash scripts/dev-env-setup.sh`, rồi `export PATH=/root/.local/bin:$PATH`.
- Đang chặn: không. Việc dở chưa commit: không (T-210 WIP đã commit, ghi rõ chưa test).
- Câu hỏi cần người: mục *Tiếp theo* 3.
