---
title: Mục lục runbook vận hành
kind: runbook-index
updated: 2026-10-26
---

# Runbook vận hành — mục lục (WF-DOC-008)

> Mỗi việc vận hành trỏ một runbook có **lệnh thật** và trường `last_drilled` ở frontmatter. `scripts/ops-registers.mjs` (job gate)
> kiểm: runbook ở bảng có tồn tại, có `last_drilled`; `last_drilled` không bắt đầu bằng ngày `YYYY-MM-DD` trong 6 tháng ⇒ **cảnh báo**
> "chưa diễn tập/quá hạn" (diễn tập là việc của người khi có VPS). Hướng dẫn chung cho người trực: [`docs/RUNBOOK.md`](../RUNBOOK.md).

| Việc | Runbook |
|---|---|
| Deploy | [runbooks/deploy-rollback.md](runbooks/deploy-rollback.md) |
| Rollback | [runbooks/deploy-rollback.md](runbooks/deploy-rollback.md) |
| Khôi phục backup (PITR + kho file) | [runbooks/restore.md](runbooks/restore.md) |
| Xoay secret khi lộ | [runbooks/secret-leak.md](runbooks/secret-leak.md) |
| Xoay mật khẩu role CSDL | [runbooks/db-password-rotation.md](runbooks/db-password-rotation.md) |
| Vi phạm dữ liệu cá nhân | [runbooks/data-breach.md](runbooks/data-breach.md) |
| Đổi gói dịch vụ (hạn mức) cho tổ chức | [runbooks/plan-change.md](runbooks/plan-change.md) |
| Sự cố thường gặp (web/CSDL/worker/kho file) | [../RUNBOOK.md](../RUNBOOK.md) §3 — ngày diễn tập ghi ở frontmatter của các runbook trên |
