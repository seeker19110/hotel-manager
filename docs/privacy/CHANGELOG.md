# CHANGELOG — hồ sơ quyền riêng tư (`docs/privacy/`)

> CMP-AUDIT-003: mọi thay đổi ROPA, data map, sổ bên xử lý, DPIA, hồ sơ chuyển dữ liệu ghi một mục `## YYYY-MM-DD` (mới nhất ở
> trên). `scripts/privacy-docs.mjs` (job new-deps): `updated:` của tệp trong thư mục không được mới hơn mục mới nhất; quá 6 tháng
> không có mục mới → cảnh báo rà lại (mốc cập nhật theo NĐ 356/2025 — chưa xác minh số điều).

## 2026-10-25
- Quyền chủ thể dữ liệu (T-2311, D-120): bảng `dsar_requests` + `processing_restrictions` (migration 0069, RLS theo người dùng; hàm xoá chỉ app_worker); xuất JSON, xoá tài khoản hai pha (giữ đồng ý + chứng từ có lý do, D-124), hạn chế xử lý; hạn theo vùng `dsar-policy.ts` + metric `hm_dsar_overdue`. data-map thêm hai bảng, ROPA thêm HĐ-12 + quy trình DSAR, DPIA 0.1.3 §4, `retention-policy.md` RET-20.
- `data-map.yaml`: thêm `legal_basis_code` (mã GDPR Art. 6) cho mọi mục; `art9_condition` + `art9_note` cho cột nhạy cảm (CMP-INTL-002). Ghi chú: Luật 91/2025/QH15 không có "lợi ích hợp pháp" — 22 mục nhật ký an toàn cần pháp lý chọn cơ sở VN.
- Sổ nhà cung cấp máy đọc `docs/compliance/vendors.yaml` song song `processors.md` (CMP-AUDIT-007).
- Hồ sơ đánh giá tác động: `docs/DPIA.md` 0.1.0 (nháp kỹ thuật, chờ DPO/pháp lý); ROPA trỏ DPIA.
- Khung pháp lý tra nguồn sống (`PROJECT.md` §6): NĐ 13/2023 hết hiệu lực 01/01/2026 (NĐ 356/2025 thay); Luật ANM 2018 hết hiệu lực 01/7/2026 (Luật 116/2025 + NĐ 333/2026: lưu tại VN, nhật ký ≥ 12 tháng).
- Hạn lưu dữ liệu cá nhân RET-11…RET-18 có job dọn/ẩn danh hằng ngày `privacy.retention` (T-2308, D-116): `data-map.yaml` cập nhật `retention`, ROPA và `retention-policy.md` ghi bảng còn chưa có job.
- Đồng ý theo mục đích (T-2310, D-119): bảng chỉ-thêm `consent_records` (migration 0068, RLS theo người dùng); `service_core` bắt buộc ở đăng ký/nhận lời mời/đăng nhập portal lần đầu, `product_analytics` opt-in (không tick sẵn), rút một bước ở trang Bảo mật; `track()` bỏ qua người chưa đồng ý. data-map thêm `consent_records`, `product_events` chuyển cơ sở sang `consent`; ROPA thêm HĐ-11; DPIA 0.1.2 §4.
- Phân tích sản phẩm tự host (T-2309, D-118): bảng `product_events` (giả danh actor HMAC, thuộc tính enum/số/bool theo danh mục đóng, không SDK/bên thứ ba), data-map thêm `product_events.actor_key`/`props`, ROPA thêm HĐ-10, hạn 13 tháng RET-19 trong job `privacy.retention`, `forgetAnalyticsActor` cho xoá tài khoản. Cơ sở pháp lý (lợi ích hợp pháp vs đồng ý) chờ pháp lý/T-2310.

## 2026-10-16
- Khởi tạo `ROPA.md`, `data-map.yaml`, `processors.md` (T-309) — trạng thái đề xuất, chờ DPIA và pháp lý.
