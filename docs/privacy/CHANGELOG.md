# CHANGELOG — hồ sơ quyền riêng tư (`docs/privacy/`)

> CMP-AUDIT-003: mọi thay đổi ROPA, data map, sổ bên xử lý, DPIA, hồ sơ chuyển dữ liệu ghi một mục `## YYYY-MM-DD` (mới nhất ở
> trên). `scripts/privacy-docs.mjs` (job new-deps): `updated:` của tệp trong thư mục không được mới hơn mục mới nhất; quá 6 tháng
> không có mục mới → cảnh báo rà lại (mốc cập nhật theo NĐ 356/2025 — chưa xác minh số điều).

## 2026-10-25
- `data-map.yaml` (T-2309, D-118): thêm `product_events` (analytics sản phẩm tự host — ID nội bộ/enum/số, không PII, không SDK/cookie phía client): chỉ ghi khi chủ thể đồng ý mục đích analytics (mặc định từ chối tới khi nối `consent_records`, T-2310); giữ 13 tháng lịch (RET-19); `actor_user_id` gỡ liên kết khi xoá tài khoản (T-2311).
- `data-map.yaml` (T-2308, D-116): hạn lưu đã có job — `persons` ẩn danh 10 năm sau quan hệ cuối, `identity_documents` ẩn danh 12 tháng sau lưu trú/thuê cuối (kèm ảnh), `notifications` 180 ngày, phiên đăng nhập 30 ngày sau hết hạn, mã xác minh 1 ngày, liên kết khách 90 ngày; `inbox` giữ 10 năm (chưa có job). Mặc định chặt, chờ pháp lý chốt (`docs/ops/retention-policy.md` RET-11…RET-18).
- `data-map.yaml`: thêm `legal_basis_code` (mã GDPR Art. 6) cho mọi mục; `art9_condition` + `art9_note` cho cột nhạy cảm (CMP-INTL-002). Ghi chú: Luật 91/2025/QH15 không có "lợi ích hợp pháp" — 22 mục nhật ký an toàn cần pháp lý chọn cơ sở VN.
- Sổ nhà cung cấp máy đọc `docs/compliance/vendors.yaml` song song `processors.md` (CMP-AUDIT-007).
- Hồ sơ đánh giá tác động: `docs/DPIA.md` 0.1.0 (nháp kỹ thuật, chờ DPO/pháp lý); ROPA trỏ DPIA.
- Khung pháp lý tra nguồn sống (`PROJECT.md` §6): NĐ 13/2023 hết hiệu lực 01/01/2026 (NĐ 356/2025 thay); Luật ANM 2018 hết hiệu lực 01/7/2026 (Luật 116/2025 + NĐ 333/2026: lưu tại VN, nhật ký ≥ 12 tháng).

## 2026-10-16
- Khởi tạo `ROPA.md`, `data-map.yaml`, `processors.md` (T-309) — trạng thái đề xuất, chờ DPIA và pháp lý.
