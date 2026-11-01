---
status: Approved
approved_by: "phiên chính (D-134…D-136, AGENTS §5)"
approved_at: "2026-10-26"
---

# Khép cuộc đua vòng đời dữ liệu (T-2402…T-2404)

## 1. User story

Chủ cơ sở cần việc đình chỉ, lưu trú, xuất và xoá tổ chức giữ đúng quyền, đúng dữ liệu khi worker và request chạy đồng thời.

## 2. Tiêu chí chấp nhận

### S-001 — RL-001: đình chỉ tổ chức
- Given owner có membership active và đã chọn tổ chức.
- When tổ chức chuyển sang suspended.
- Then request kế tiếp bị NOT_FOUND 404, kể cả allowPendingDeletion; khi active trở lại thì truy cập được. Pending deletion vẫn giữ 423 và đường xuất/huỷ hiện có.

### S-002 — RL-002: claim trước xoá
- Given tổ chức quá hạn xoá và có thể còn job xuất hoặc file đang tải.
- When worker bắt đầu purge.
- Then CSDL ghi claim bền trước xoá object; huỷ thắng trước claim thì không xoá, claim thắng thì không huỷ. Lỗi kho giữ claim và lượt sau thử lại. Export/staging mới sau claim bị từ chối, file pending_scan hoãn toàn bộ purge; upload/finalize lỗi được dọn object. Yêu cầu xuất thắng trước claim giữ khoá tới commit. UI chỉ báo huỷ thành công khi API trả active. Không giữ transaction xuyên mạng.

### S-003 — RL-003: khách ở kèm
- Given hồ sơ quá hạn nhưng transaction check-in chưa commit.
- When worker retention chạy cùng lúc.
- Then không ẩn danh giấy tờ/người đang được dùng. Nếu worker khoá trước, việc đọc/tái dùng giấy tờ đợi rồi kiểm lại; không công bố lượt ở dùng giấy tờ vừa bị ẩn danh. UUID không tồn tại hoặc khác tổ chức bị từ chối, tombstone không gắn vào lượt ở mới.

### S-004 — RL-004: đường lùi
- Given migration mới đã được áp trên PostgreSQL 17.
- When kiểm down/up.
- Then schema và hành vi được phục hồi; down 0074 bị từ chối khi còn claim, phải hoàn tất purge trước rollback. Không sửa migration đã áp.

## 3. Bằng chứng và giới hạn

`packages/app/src/access/auth.db.test.ts`, `packages/app/src/tenancy/org-deletion.db.test.ts`, `packages/app/src/exports/exports.db.test.ts`, `packages/app/src/retention/additional-guests.db.test.ts`. Cổng ở PLAN; production purge giữ tắt D-125, PR do người merge.

Storage có tổng timeout 30 giây, staging TTL 2 ngày. Cần kiểm hạ tầng thật trước bật purge; chưa cam kết cho tiến trình pause quá TTL hoặc kho hoàn tất PUT rất muộn sau abort.
