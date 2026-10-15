---
title: Môi trường dev/staging/prod, cấu hình, secrets theo môi trường
kind: module
prefix: WF-ENV
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, static-site, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-14
---

# Môi trường dev/staging/prod, cấu hình, secrets theo môi trường

> Một build chạy ở mọi môi trường; chỉ **cấu hình** khác nhau, đọc từ biến môi trường (12-factor III), validate
> lúc khởi động, không có nhánh `if env == "prod"` trong nghiệp vụ. Staging giống prod về loại/phiên bản backing
> service (12-factor X); preview env cho mỗi PR; feature flag tách deploy khỏi release; deploy prod qua gate. **Cấu hình**
> (schema env, validate lúc khởi động, `.env.example`, tiền tố biến công khai, tài liệu cấu hình) là nhà của
> [`../01-baseline/configuration-and-secrets.md`](../01-baseline/configuration-and-secrets.md); bí mật (vault, xoay, quét)
> là nhà của [`../12-security/secrets-management.md`](../12-security/secrets-management.md). File này chỉ giữ môi trường,
> preview, flag, parity và gate deploy.

## Nguyên tắc

1. **Build một lần, cấu hình theo deploy.** Cùng artefact đi dev → staging → prod; cấu hình nằm ngoài artefact.
2. **Cấu hình là đầu vào không tin cậy (P6):** schema + validate khi khởi động; thiếu/sai → thoát ngay với thông
   báo rõ (fail-fast), không chạy với mặc định ngầm ở prod.
3. **Không nhóm theo tên môi trường trong code.** Mỗi biến độc lập (`DATABASE_URL`, `FEATURE_X`), không
   `config.production.js` chứa bí mật; `NODE_ENV`/`APP_ENV` chỉ để chọn mặc định an toàn, không rẽ nhánh nghiệp vụ.
4. **Dev/prod parity:** cùng loại và phiên bản DB/cache/queue ở mọi môi trường (Docker Compose/devcontainer cho
   local); khoảng cách thời gian/người/công cụ nhỏ.
5. **Prod là nơi đặc biệt:** dữ liệu thật, secrets riêng, deploy qua gate có người duyệt, không ai có quyền
   ghi thường trực.

## Quyết định

| Câu hỏi | Chọn | Ghi chú |
|---|---|---|
| Bao nhiêu môi trường | **dev (local) · preview (mỗi PR) · staging · prod** là mặc định M+; S có thể gộp preview = staging | Thêm `qa`/`uat` chỉ khi có đội kiểm thử/khách hàng nghiệm thu riêng |
| Nguồn, schema, tiền tố công khai của cấu hình | Theo nhà [`configuration-and-secrets.md`](../01-baseline/configuration-and-secrets.md) (`BASE-CFG-001`…`008`) | — |
| Feature flag | Env/boolean đơn giản (S) → OpenFeature SDK + provider (M+, bật dần theo %/tenant, kill switch) | Flag là bảng DB tự viết không có TTL/dọn |
| Preview env | Tự động mỗi PR (Vercel/Netlify/Render/k8s namespace), dữ liệu giả/seed, secrets sandbox, tự huỷ khi đóng PR | Preview trỏ DB prod |
| Staging data | Seed/synthetic hoặc bản ẩn danh hoá theo [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md) | Copy prod thô |

## Checklist

- [ ] `WF-ENV-001` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-CFG-002`](../01-baseline/configuration-and-secrets.md): cấu hình đọc qua một module có schema, validate lúc khởi động, thiếu/sai → exit ≠ 0 nêu tên biến.
- [ ] `WF-ENV-002` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-CFG-003`](../01-baseline/configuration-and-secrets.md): `.env.example` liệt kê mọi biến, `.env*` trong `.gitignore`; không bí mật trong repo theo `SEC-SECRET-001`.
- [ ] `WF-ENV-003` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-CFG-008`](../01-baseline/configuration-and-secrets.md): chỉ giá trị công khai mang tiền tố client (`NEXT_PUBLIC_`/`VITE_`/`EXPO_PUBLIC_`), bundle được quét.
- [ ] `WF-ENV-004` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-SECRET-005`](../12-security/secrets-management.md): bí mật prod ở kho tập trung; mỗi dịch vụ × môi trường credential riêng, quyền tối thiểu (`SEC-SECRET-006`).
- [ ] `WF-ENV-005` **MUST@L** Không rẽ nhánh nghiệp vụ theo tên môi trường (`if (env === 'production')`) trong code nghiệp vụ; khác biệt hành vi phải là biến cấu hình/flag riêng. → Kiểm: grep `=== 'production'`/`== "prod"` ngoài module env/bootstrap = 0 (allowlist có lý do). · Nguồn: 12-factor III (không nhóm theo môi trường)
- [ ] `WF-ENV-006` **MUST** Cùng artefact/image cho staging và prod (tag theo commit SHA), chỉ cấu hình khác; không build riêng cho prod. → Kiểm: digest image staging == prod cho cùng release; log deploy ghi digest. · Nguồn: 12-factor V
- [ ] `WF-ENV-007` **MUST@L** Staging dùng cùng loại + major version backing service (DB, cache, queue, object storage) với prod; local dev có Docker Compose/devcontainer dựng cùng loại. → Kiểm: `docker-compose.yml`/IaC ghi image version; bảng so sánh phiên bản staging ↔ prod trong `docs/ops/`. · Nguồn: 12-factor X Dev/prod parity
- [ ] `WF-ENV-008` **MUST** Deploy prod qua gate: `environment: production` có required reviewers (≠ người kích), deployment branches giới hạn `main`/tag; staging tự động. → Kiểm: cấu hình environment có reviewer + prevent self-review; log deploy có người duyệt. · Nguồn: GitHub Managing environments for deployment
- [ ] `WF-ENV-009` **MUST@L** Preview environment cho mỗi PR (URL trong PR), secrets/sandbox riêng, dữ liệu seed, tự huỷ khi đóng PR; preview **không** trỏ dữ liệu prod. → Kiểm: job preview + cleanup; biến `DATABASE_URL` của preview ≠ prod (guard so sánh host). · Nguồn: khung cũ `quality-supplements.md` N1.6 (Vercel Preview làm staging)
- [ ] `WF-ENV-010` **MUST@M** Dữ liệu staging/preview là seed/synthetic hoặc đã ẩn danh hoá; không copy PII prod; quy trình ẩn danh có kiểm. → Kiểm: script seed/anonymize trong repo; quét PII mẫu trên staging = 0; xem [`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md).
- [ ] `WF-ENV-011` **MUST@L** Feature flag: mọi flag có tên, chủ, ngày tạo, mục đích, hạn dọn; kill switch cho tính năng rủi ro; đánh giá flag có timeout/fallback khi provider lỗi (fail-safe về mặc định). → Kiểm: registry flag (file/DB) có các trường; job cảnh báo flag quá hạn; test provider lỗi → giá trị mặc định. · Nguồn: OpenFeature specification
- [ ] `WF-ENV-012` **MUST@M** Thay đổi cấu hình prod có dấu vết (ai, khi nào, giá trị cũ/mới đã che bí mật) và đảo ngược được; cấu hình hạ tầng là code ([`../15-operations/infrastructure-as-code.md`](../15-operations/infrastructure-as-code.md)). → Kiểm: audit log secret manager/IaC history; không sửa tay trên console không qua PR (policy).
- [ ] `WF-ENV-013` **MUST@L** Tách tài khoản/project cloud theo môi trường (prod riêng), quyền tối thiểu, không credential prod trên máy dev. → Kiểm: inventory account; IAM policy; xem [`../12-security/infrastructure-and-network.md`](../12-security/infrastructure-and-network.md).
- [ ] `WF-ENV-014` **SHOULD** Local dev: một lệnh dựng (`make dev`/`docker compose up`/devcontainer), `.env.example` đủ để chạy, seed dữ liệu mẫu; không cần tài khoản cloud để chạy luồng chính. → Kiểm: onboarding mới chạy được app ≤ 30 phút theo [`../18-cross-cutting/developer-experience.md`](../18-cross-cutting/developer-experience.md).
- [ ] `WF-ENV-015` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-CFG-012`](../01-baseline/configuration-and-secrets.md): bảng tài liệu cấu hình sinh từ schema env, CI kiểm tươi.
- [ ] `WF-ENV-016` **SHOULD** Cấu hình có thể reload nóng chỉ cho giá trị thiết kế để reload (flag, ngưỡng); phần còn lại cần restart có kiểm soát; không đọc env mỗi request. → Kiểm: module env parse một lần; flag qua provider.
- [ ] `WF-ENV-017` **SHOULD** Môi trường ghi rõ trong mọi log/metric (`env=staging`) và banner UI ở non-prod để tránh thao tác nhầm. → Kiểm: log có trường `env`; UI non-prod có badge.
- [ ] `WF-ENV-018` **MAY** Ephemeral environment theo nhánh cho test E2E nặng/perf; huỷ sau N giờ. → Kiểm: job tạo/huỷ có TTL.
- [ ] `WF-ENV-019` **MAY** Mobile/desktop: build flavor theo môi trường (`dev`/`staging`/`prod`) với bundle ID/tên khác nhau để cài song song; endpoint từ cấu hình build, không hard-code. → Kiểm: 3 flavor cài cùng máy; endpoint trong config.

## Bẫy thường gặp

- **`NEXT_PUBLIC_SUPABASE_SERVICE_KEY`.** Key có quyền bị inline vào bundle client. Tiền tố public chỉ cho giá trị công khai; lint tên biến.
- **`.env` commit "tạm" rồi xoá.** Vẫn trong lịch sử git; phải xoay secret. Secret scan toàn lịch sử + `.gitignore` từ commit đầu.
- **Staging dùng SQLite, prod Postgres.** Test xanh, prod lỗi kiểu/khoá. Cùng loại + version.
- **Preview env trỏ DB prod "cho giống thật".** PR lạ xoá dữ liệu thật. Guard so host; seed riêng.
- **`if (NODE_ENV !== 'production') skipAuth()`.** Một biến sai ở prod → mở toang. Không rẽ nhánh bảo mật theo tên env; mặc định an toàn.
- **Mặc định ngầm khi thiếu biến** (`process.env.X ?? 'localhost'`). Prod chạy với giá trị dev âm thầm. Fail-fast.
- **Flag không ai dọn.** Code chết tích tụ, nhánh logic 2^n. Hạn dọn + cảnh báo.
- **Sửa env prod trên console không ghi lại.** Không ai biết vì sao hôm qua khác hôm nay. IaC/secret manager có audit, qua PR.
- **Mâu thuẫn nguồn:** 12-factor khuyên "không nhóm cấu hình theo tên môi trường", còn GitHub Environments/nhiều nền tảng lại tổ chức secrets *theo* môi trường. Không mâu thuẫn ở mức thiết kế: **nền tảng** nhóm theo deploy để cấp quyền/gate, **code** vẫn đọc từng biến độc lập — khung yêu cầu cả hai.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| Schema env, `.env.example`, tiền tố công khai, secret scan | Theo bảng Cổng tự động của [`configuration-and-secrets.md`](../01-baseline/configuration-and-secrets.md) và [`secrets-management.md`](../12-security/secrets-management.md) | — | — |
| Guard preview/staging | script so `DATABASE_URL`/bucket host với danh sách prod | CI deploy | Khác prod |
| Environment gate | GitHub `environment: production` required reviewers + prevent self-review + deployment branches | GitHub | Bắt buộc |
| Flag hygiene | script liệt kê flag quá hạn dọn | CI schedule | Cảnh báo |
| Parity | script so phiên bản backing service staging ↔ prod (từ IaC/compose) | CI | Cùng major |

## Nguồn

- The Twelve-Factor App — III. Config (env var, không nhóm theo môi trường, litmus test open-source): <https://12factor.net/config> — xác minh 2026-10-13
- The Twelve-Factor App — X. Dev/prod parity (ba khoảng cách; cùng backing service): <https://12factor.net/dev-prod-parity> — xác minh 2026-10-13
- GitHub — Managing environments for deployment (required reviewers, prevent self-review, deployment branches/tags, environment secrets/variables): <https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment> — xác minh 2026-10-13
- OpenFeature specification (CNCF incubating; Flag Evaluation API, providers, hooks, OFREP): <https://openfeature.dev/specification/> — xác minh 2026-10-13
- Phiên bản (npm/PyPI, xác minh 2026-10-13): zod 4.6.7, pydantic 2.14.1, gitleaks v8.30.1.
- (chưa xác minh) 12-factor V. Build, release, run — không fetch riêng ngày 2026-10-13.
- Khung cũ X-stored commit `1b80fe4`: `docs/framework/quality-supplements.md` N1.1 (`lib/env.ts` validate env), N1.6 (Vercel Preview làm staging), `.env.example`.
- `research/2026-10-13-stored-catalog-extraction.md` §2.5 (`NEXT_PUBLIC_` chỉ cho giá trị công khai; validate env bằng zod); catalog `09-engineering-checklists` §1.4.
