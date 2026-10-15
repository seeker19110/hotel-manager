---
title: Workflow phát triển
kind: index
updated: 2026-10-14
---

# 10 — Workflow phát triển

> Cách một thay đổi đi từ ý định tới production **có kiểm được**: spec là hợp đồng → nhánh ngắn + PR nhỏ → cổng
> máy (`quality`) → review người + AI (claim cần verify) → merge FIFO dưới WIP cap → phát hành tự động từ commit →
> cấu hình theo môi trường → tài liệu tươi bằng máy. Luôn ghép vào blueprint (`applies_to: all`), áp cho đội một
> người lẫn nhiều đội; cổng là code (ruleset JSON, guard, pr-policy), không phải lời hứa.

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`git-and-branching.md`](git-and-branching.md) | Trunk-based, PR ≤ 400 dòng, squash, Conventional Commits, không push thẳng `main`, ruleset as code + `protection-guard`, hook chạy lại ở CI | G5 dựng repo; khi thêm người/đổi quy tắc nhánh; khi `main` bị khoá |
| [`code-review.md`](code-review.md) | Checklist review, AI reviewer khác model (claim), SLA 24h leo thang, vùng nhạy cảm luôn người, fast-lane 5 điều kiện fail-closed | Trước khi bật AI review/auto-merge; khi review nghẽn |
| [`ci-cd-pipeline.md`](ci-cd-pipeline.md) | Job `quality` gom làm required check chất lượng (cùng `protection-guard`, `gitleaks`, `dep-audit`), cache theo lockfile, `permissions` tối thiểu, ghim SHA, chống script injection, environment gate cho CD | G5 viết `ci.yml`; audit vệ sinh workflow; khi CI chậm > 10 phút |
| [`release-and-versioning.md`](release-and-versioning.md) | release-please/changesets, SemVer, Keep a Changelog, tag ký bất biến, artefact một lần, rollback đã diễn tập | Trước release đầu tiên; khi đổi cách phát hành; monorepo nhiều package |
| [`environments-and-config.md`](environments-and-config.md) | dev/preview/staging/prod, parity, preview env, feature flag, gate deploy prod (cấu hình → `01-baseline/configuration-and-secrets`, bí mật → `12-security/secrets-management`) | G5; khi thêm môi trường/flag; khi lộ key qua bundle |
| [`spec-driven-development.md`](spec-driven-development.md) | Spec approved mới code, AC có ID ↔ test viết từ spec, spec hở thì dừng, version spec, tiêu chí dừng cho agent | G3 trước mỗi tính năng; khi chạy agent/autopilot; bug sửa lần 3 |
| [`documentation-workflow.md`](documentation-workflow.md) | Docs-as-code, link check, docs-consistency, PROGRESS SHA tổ tiên HEAD, ADR không sửa, reference sinh từ nguồn, runbook có diễn tập | G5 (CI docs); mỗi khi đổi tên file/API; bàn giao phiên |
| [`team-and-wip.md`](team-and-wip.md) | WIP cap 3 bằng máy, FIFO, DoR/DoD có bằng chứng, bàn giao qua PROGRESS, onboarding ≤ 1 ngày, 1 người vs đội, người + agent | Bắt đầu dự án/thêm người; khi nhiều việc dở; khi bot lấp hàng đợi |

Liên quan: vòng lặp tự động → [`../11-autonomous-loop/`](../11-autonomous-loop/README.md); chuỗi cung ứng/ghim SHA/SBOM →
[`../12-security/supply-chain.md`](../12-security/supply-chain.md); bí mật → [`../12-security/secrets-management.md`](../12-security/secrets-management.md);
cách viết spec → [`../17-product-project/specification.md`](../17-product-project/specification.md); ADR → [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md);
deploy/rollback cơ chế → [`../15-operations/deployment-strategies.md`](../15-operations/deployment-strategies.md); mẫu → [`../templates/README.md`](../templates/README.md).
