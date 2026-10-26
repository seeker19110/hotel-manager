---
title: Runbook — đổi gói dịch vụ (hạn mức) cho một tổ chức
kind: runbook
updated: 2026-10-26
last_drilled: "2026-10-26 — phần CSDL diễn tập tự động trên cluster tạm (packages/app/src/plans/plans.db.test.ts: chỉ owner CSDL đổi được, gói ngoài danh mục bị CHECK chặn); chưa diễn tập trên production (chưa có VPS)"
owner: (chưa gán — Tech Lead)
---

# Đổi gói dịch vụ của tổ chức (IND-SAAS-008, D-130)

> Gói (`organizations.plan`) quyết định hạn mức tài nguyên (cơ sở, phòng, nhân viên active, dung lượng file — cưỡng chế bằng trigger
> `app.enforce_plan_quota`, vượt ⇒ 409 `QUOTA_EXCEEDED`) và hạn mức tần suất (lệnh/phút, tải file, nhập liệu). Danh mục gói ở
> `packages/app/src/plans/catalog.ts` (một nguồn); CSDL giữ bản sao ở `app.plan_limits()` + CHECK `ck_organizations_plan` (test so khớp).
> Ứng dụng (`app_runtime`/`app_worker`) **không** đổi được cột này (`trg_organizations_lifecycle_guard` ⇒ 42501) — chỉ role sở hữu
> bảng (owner migration), có ghi `audit_events` trong cùng transaction.

## Khi nào dùng
- Chủ dự án duyệt nâng/hạ gói cho một tổ chức (yêu cầu hỗ trợ, hợp đồng). Gói mới phải có sẵn trong danh mục đã triển khai
  (`select * from app.plan_limits(null);`). Thêm gói mới = sửa `catalog.ts` + migration mới cập nhật `app.plan_limits`/CHECK, qua PR.
- Tổ chức chạm hạn mức (`QUOTA_EXCEEDED` trong log `command.failed`) mà nhu cầu là hợp lệ.

## Điều kiện trước
- Quyền owner CSDL (kết nối socket trên máy CSDL hoặc kênh quản trị), mã yêu cầu/ticket để ghi vào audit.
- Hạ gói: kiểm mức đang dùng trước — hạ dưới mức đang dùng không xoá gì, chỉ chặn tạo mới tới khi tổ chức lưu trữ bớt:
  `select (select count(*) from properties where organization_id = :'org' and archived_at is null) as properties,
          (select count(*) from units where organization_id = :'org' and archived_at is null) as units,
          (select count(*) from memberships where organization_id = :'org' and status = 'active' and role not in ('tenant','platform_support')) as members,
          (select coalesce(sum(size_bytes),0) from files where organization_id = :'org' and status in ('pending_scan','ready') and owner_type <> 'export_job') as storage_bytes;`

## Các bước
1. Mở psql bằng owner CSDL: `docker compose -f deploy/compose.yaml exec -u postgres postgres psql -U postgres -d <db> -v org=<uuid> -v plan=<gói> -v ticket=<mã yêu cầu>`
2. Đổi gói + ghi audit trong MỘT transaction:
   ```sql
   begin;
   with old as (select plan from organizations where id = :'org' for update),
        upd as (update organizations set plan = :'plan' where id = :'org' returning plan)
   insert into audit_events (id, organization_id, actor_type, action, entity_type, entity_id, before, after, reason, correlation_id)
   select gen_random_uuid(), :'org', 'worker', 'organization.plan_changed', 'organization', :'org',
          jsonb_build_object('plan', old.plan), jsonb_build_object('plan', upd.plan), :'ticket', 'ops-plan-change'
   from old, upd;
   -- Kiểm: đúng 1 hàng audit (INSERT 0 1). 0 hàng ⇒ sai org ⇒ rollback.
   commit;
   ```
   Gói ngoài danh mục ⇒ lỗi `ck_organizations_plan` (23514), không đổi gì.
3. Hạn mức tần suất áp từ request kế tiếp (actor đọc `plan` mỗi request); hạn mức tài nguyên áp ngay cho ghi mới.

## Kiểm tra sau
- `select plan from organizations where id = :'org';` = gói mới; `select action, before, after, reason from audit_events where organization_id = :'org' and action = 'organization.plan_changed' order by occurred_at desc limit 1;`

## Lùi
- Chạy lại bước 2 với gói cũ (lấy từ `before` của audit).
