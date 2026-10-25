# CHANGELOG — hồ sơ quyền riêng tư (`docs/privacy/`)

> CMP-AUDIT-003: mọi thay đổi ROPA, data map, sổ bên xử lý, DPIA, hồ sơ chuyển dữ liệu ghi một mục `## YYYY-MM-DD` (mới nhất ở
> trên). `scripts/privacy-docs.mjs` (job new-deps): `updated:` của tệp trong thư mục không được mới hơn mục mới nhất; quá 6 tháng
> không có mục mới → cảnh báo rà lại (mốc cập nhật theo NĐ 356/2025 — chưa xác minh số điều).

## 2026-10-25
- `data-map.yaml`: thêm `legal_basis_code` (mã GDPR Art. 6) cho mọi mục; `art9_condition` + `art9_note` cho cột nhạy cảm (CMP-INTL-002). Ghi chú: Luật 91/2025/QH15 không có "lợi ích hợp pháp" — 22 mục nhật ký an toàn cần pháp lý chọn cơ sở VN.
- Sổ nhà cung cấp máy đọc `docs/compliance/vendors.yaml` song song `processors.md` (CMP-AUDIT-007).
- Hồ sơ đánh giá tác động: `docs/DPIA.md` 0.1.0 (nháp kỹ thuật, chờ DPO/pháp lý); ROPA trỏ DPIA.
- Khung pháp lý tra nguồn sống (`PROJECT.md` §6): NĐ 13/2023 hết hiệu lực 01/01/2026 (NĐ 356/2025 thay); Luật ANM 2018 hết hiệu lực 01/7/2026 (Luật 116/2025 + NĐ 333/2026: lưu tại VN, nhật ký ≥ 12 tháng).
- Hạn lưu dữ liệu cá nhân RET-11…RET-18 có job dọn/ẩn danh hằng ngày `privacy.retention` (T-2308, D-116): `data-map.yaml` cập nhật `retention`, ROPA và `retention-policy.md` ghi bảng còn chưa có job.

## 2026-10-16
- Khởi tạo `ROPA.md`, `data-map.yaml`, `processors.md` (T-309) — trạng thái đề xuất, chờ DPIA và pháp lý.
