---
title: Nền tảng chung — mọi phần mềm đều cần
kind: index
updated: 2026-10-14
---

# 01 — Nền tảng chung — mọi phần mềm đều cần

> Tám module `kind: baseline` **luôn được ghép** vào mọi blueprint (`xt.py compose`), bất kể hồ sơ hay ngành: chúng là
> sàn mà web, mobile, CLI, thư viện, data/ML, AI agent, game, nhúng… đều phải đạt. Viết **trung lập stack**; mục nào chỉ
> đúng cho server/UI thì đặt ở module chuyên sâu của mảng khác, ở đây chỉ trỏ tới. Mức `MUST` là "thiếu là chưa đạt";
> `MUST@M`/`MUST@L` hạ thành `SHOULD` ở quy mô nhỏ hơn.

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`repo-and-versioning.md`](repo-and-versioning.md) | Repo, phiên bản và lịch sử thay đổi: `.gitignore`/`.gitattributes`, LICENSE, Conventional Commits, SemVer/CalVer, tag, CHANGELOG, bảo vệ nhánh | G5 dựng nền; trước bản phát hành đầu tiên; khi đổi chính sách phiên bản |
| [`quality-gates.md`](quality-gates.md) | Năm lệnh chuẩn (format · lint · typecheck · test · build); cổng commit/CI chạy build · typecheck · lint · test (lint nên gồm kiểm format); hook cục bộ + CI lặp lại, required check, không nới cấu hình để xanh | G5 dựng nền; khi CI "xanh rỗng" hoặc hook bị bỏ qua; khi thêm công cụ chất lượng |
| [`security-minimum.md`](security-minimum.md) | Sàn bảo mật mọi loại phần mềm: validate allowlist, không bí mật, SCA/SAST, TLS, quyền tối thiểu, fail-closed, kênh báo lỗ hổng | G4 threat model; G5; trước G7 phát hành; khi thêm tích hợp/ranh giới mới |
| [`errors-and-logging.md`](errors-and-logging.md) | Nhà của log ứng dụng: nhánh lỗi tường minh, handler toàn cục, không lộ nội bộ, log JSON stdout, mức OTel, redaction, timeout, retry có idempotency | G5–G6 khi viết mã; khi thiết kế API lỗi; khi alert nhiễu hoặc log có bí mật |
| [`configuration-and-secrets.md`](configuration-and-secrets.md) | **Nhà của cấu hình**: biến môi trường, schema validate lúc khởi động, `.env.example`, tiền tố biến công khai, mặc định an toàn; bí mật chỉ phần tối thiểu, trỏ `12-security/secrets-management` | G5 dựng nền; khi thêm biến/bí mật mới; khi lên môi trường mới |
| [`documentation-minimum.md`](documentation-minimum.md) | README đủ chạy–kiểm, CHANGELOG, ADR, runbook, docs-as-code tươi bằng máy (link, smoke lệnh README, freshness) | G2 (ADR stack); G5; trước G7; khi bàn giao/onboarding |
| [`data-correctness.md`](data-correctness.md) | UTF-8 + NFC, null/rỗng/0, validate cú pháp + ngữ nghĩa, số lớn, tiền/thời gian (tóm tắt, trỏ 18), idempotency, giao dịch, ràng buộc CSDL, ca biên | G3 đặc tả ca biên; G6 khi viết logic nghiệp vụ; khi review bug "đúng kiểu nhưng sai việc" |
| [`dependencies.md`](dependencies.md) | Lockfile + cài đóng băng, runtime trong cửa sổ hỗ trợ (EOL), quét lỗ hổng theo lịch, allowlist license, cập nhật tự động gom nhóm | G2 chọn stack; G5; mỗi tuần (cron); trước khi thêm phụ thuộc mới |

## Cách dùng

1. `xt.py compose …` tự ghép cả tám file; không cần chọn.
2. Với dự án có sẵn: audit tám file này **trước** mọi module khác — đa số lỗ hổng vận hành thật nằm ở sàn (bí mật trong
   repo, CI xanh rỗng, runtime hết hỗ trợ, log có token).
3. Mỗi mục `MUST` có `→ Kiểm:` là lệnh/test/cấu hình; blueprint chỉ tick khi có bằng chứng máy (P1).

## Ranh giới "một chủ đề một nhà"

| Chủ đề | Ở baseline chỉ có | Nhà đầy đủ |
|---|---|---|
| Bí mật | tối thiểu + `.env.example` | [`../12-security/secrets-management.md`](../12-security/secrets-management.md) |
| Chuỗi cung ứng (SHA, SBOM, chữ ký) | tối thiểu + lockfile | [`../12-security/supply-chain.md`](../12-security/supply-chain.md) |
| Thời gian/tiền/đơn vị/ID | tóm tắt | [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md) |
| Nền tảng quan sát, sự kiện bảo mật | log ứng dụng | [`../15-operations/observability.md`](../15-operations/observability.md), [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md) |
| PROGRESS/PLAN/file harness | sàn `BASE-DOC-008` | [`../11-autonomous-loop/harness-files.md`](../11-autonomous-loop/harness-files.md) |
| Quy trình Git/PR/phát hành | sàn repo | [`../10-workflow/git-and-branching.md`](../10-workflow/git-and-branching.md), [`../10-workflow/release-and-versioning.md`](../10-workflow/release-and-versioning.md) |
| Tài liệu cho AI agent | trỏ | [`../18-cross-cutting/docs-for-ai-agents.md`](../18-cross-cutting/docs-for-ai-agents.md) |
