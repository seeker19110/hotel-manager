# CHANGELOG — hồ sơ quyền riêng tư (`docs/privacy/`)

> CMP-AUDIT-003: mọi thay đổi ROPA, data map, sổ bên xử lý, DPIA, hồ sơ chuyển dữ liệu ghi một mục `## YYYY-MM-DD` (mới nhất ở
> trên). `scripts/privacy-docs.mjs` (job new-deps): `updated:` của tệp trong thư mục không được mới hơn mục mới nhất; quá 6 tháng
> không có mục mới → cảnh báo rà lại (mốc cập nhật theo NĐ 356/2025 — chưa xác minh số điều).

## 2026-10-26
- `data-map.yaml` (T-2313, D-128): truy cập hỗ trợ chỉ đọc do owner cấp — cột tự do mới `invitations.support_reason`, `memberships.support_reason` (lý do cấp, ≤ 500 ký tự, không nhập PII); người hỗ trợ là tài khoản riêng (không impersonation), hạn ≤ 72 giờ, mỗi lần truy cập ghi `audit_events` (`support.accessed`, IP đã cắt + UA). `audit_events.source_ip`/`user_agent`: ghi rõ hạn giữ (không xoá ở pilot) đáp ứng ≥ 12 tháng của NĐ 333 Đ.22 (chưa xác minh với pháp lý); dòng audit ghi trong hàm CSDL (yêu cầu/huỷ xoá tổ chức) nay cũng có nguồn; IP đã cắt hiện cho owner/manager ở /nhat-ky, UA chỉ có trong bản xuất CSV.
- `data-map.yaml`, `ROPA.md`, `retention-policy.md` (T-2312, D-125): vòng đời xoá tổ chức — owner yêu cầu (xác thực lại) ⇒ tổ chức `pending_deletion` 30 ngày (khoá mọi truy cập trừ xuất dữ liệu + huỷ một bước) ⇒ job `tenancy.purge` xoá cứng MỌI bảng theo tổ chức (kể cả hoá đơn/sổ/audit — nghĩa vụ lưu kế toán thuộc cơ sở, đã có 30 ngày xuất) + object kho ⇒ chứng nhận xoá (`org_deletion_certificates`, RET-23) cho người yêu cầu. Cột mới `organizations.deletion_requested_by` và `org_deletion_certificates.requested_by` (id tài khoản). Job purge TẮT mặc định ở production (chờ người + grant `data_delete`).
- `data-map.yaml`, `ROPA.md` (T-2311, D-123): thêm `dsar_requests` (yêu cầu quyền chủ thể theo tài khoản: truy cập/xoá/hạn chế, hạn theo vùng — VN xoá 3/truy cập 10/hạn chế 3 ngày, chưa xác minh, nguồn thứ cấp; EU/UK/SG/TH 30; CA 45) và `processing_restrictions` (cờ hạn chế ⇒ analytics từ chối). `consent_records`: GIỮ sau khi xoá tài khoản làm bằng chứng (chỉ id bí danh). Xoá tài khoản lan mọi kho (auth, phiên, membership, analytics, file bản xuất, gói DSAR) và giữ hoá đơn/sổ/audit/persons có căn cứ (Luật Kế toán 88/2015/QH13 Đ.41). ROPA §Quyền của chủ thể có quy trình, hạn, kho; retention RET-20/21.

## 2026-10-25
- `data-map.yaml` (T-2310, D-122): thêm `consent_records` (bằng chứng đồng ý theo mục đích, append-only, theo tài khoản; RLS chỉ chính chủ): danh mục mục đích trong mã (`packages/app/src/privacy/purposes.ts` — chỉ `analytics` cần đồng ý; cung cấp dịch vụ = hợp đồng, nghĩa vụ pháp lý = không cần đồng ý); thu ở đăng ký/nhận lời mời/portal (ô KHÔNG tick sẵn), rút ở trang Quyền riêng tư cùng số bước; `track()` nay chỉ ghi khi có đồng ý còn hiệu lực theo đúng phiên bản văn bản. Không có bên thứ ba nhận ⇒ lan việc rút tới bên thứ ba: không áp dụng. Hạn giữ khi xoá tài khoản: T-2311.
- `data-map.yaml` (T-2309, D-118): thêm `product_events` (analytics sản phẩm tự host — ID nội bộ/enum/số, không PII, không SDK/cookie phía client): chỉ ghi khi chủ thể đồng ý mục đích analytics (mặc định từ chối tới khi nối `consent_records`, T-2310); giữ 13 tháng lịch (RET-19); `actor_user_id` gỡ liên kết khi xoá tài khoản (T-2311).
- `data-map.yaml` (T-2308, D-116): hạn lưu đã có job — `persons` ẩn danh 10 năm sau quan hệ cuối, `identity_documents` ẩn danh 12 tháng sau lưu trú/thuê cuối (kèm ảnh), `notifications` 180 ngày, phiên đăng nhập 30 ngày sau hết hạn, mã xác minh 1 ngày, liên kết khách 90 ngày; `inbox` giữ 10 năm (chưa có job). Mặc định chặt, chờ pháp lý chốt (`docs/ops/retention-policy.md` RET-11…RET-18).
- `data-map.yaml`: thêm `legal_basis_code` (mã GDPR Art. 6) cho mọi mục; `art9_condition` + `art9_note` cho cột nhạy cảm (CMP-INTL-002). Ghi chú: Luật 91/2025/QH15 không có "lợi ích hợp pháp" — 22 mục nhật ký an toàn cần pháp lý chọn cơ sở VN.
- Sổ nhà cung cấp máy đọc `docs/compliance/vendors.yaml` song song `processors.md` (CMP-AUDIT-007).
- Hồ sơ đánh giá tác động: `docs/DPIA.md` 0.1.0 (nháp kỹ thuật, chờ DPO/pháp lý); ROPA trỏ DPIA.
- Khung pháp lý tra nguồn sống (`PROJECT.md` §6): NĐ 13/2023 hết hiệu lực 01/01/2026 (NĐ 356/2025 thay); Luật ANM 2018 hết hiệu lực 01/7/2026 (Luật 116/2025 + NĐ 333/2026: lưu tại VN, nhật ký ≥ 12 tháng).

## 2026-10-16
- Khởi tạo `ROPA.md`, `data-map.yaml`, `processors.md` (T-309) — trạng thái đề xuất, chờ DPIA và pháp lý.
