---
title: Triển khai: canary, blue/green, feature flag, rollback, migration online
kind: module
prefix: OPS-DEPLOY
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, static-site, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-14
---

# Triển khai: canary, blue/green, feature flag, rollback, migration online

> Đưa thay đổi lên production **nhỏ, quan sát được, lùi được**: chọn chiến lược (rolling/canary/blue-green), feature flag tách deploy
> khỏi release, rollback < 15 phút đã diễn tập, migration online expand/contract, smoke test sau deploy, freeze có chủ. Pipeline CI/CD
> và cổng merge là nhà của [`../10-workflow/ci-cd-pipeline.md`](../10-workflow/ci-cd-pipeline.md); cách viết migration ở
> [`../09-database/migrations.md`](../09-database/migrations.md); phát hành phiên bản/changelog ở [`../10-workflow/release-and-versioning.md`](../10-workflow/release-and-versioning.md).

## Nguyên tắc

- **Deploy ≠ release**: deploy đưa code lên máy; release bật cho người dùng (flag/canary %). Tách hai việc để rollback không cần deploy lại.
- **Mọi deploy đều có đường lùi được thử trước** (P8): artifact cũ còn, DB tương thích hai phiên bản, lệnh rollback một bước, < 15 phút.
- **Quan sát trước khi mở rộng**: canary/giai đoạn chỉ tiến khi SLI (lỗi, latency, business metric) không xấu đi so với baseline; tự động dừng/lùi khi vượt ngưỡng.
- **Schema tương thích N−1/N+1**: migration theo expand → migrate → contract, không bao giờ "drop cột" cùng deploy dùng cột.
- **Artifact bất biến**: build một lần, cùng digest đi qua staging → production; không rebuild cho production; artifact có chữ ký (xem [`../12-security/supply-chain.md`](../12-security/supply-chain.md)).
- **Đo DORA**: deployment frequency, change lead time, change fail rate, failed deployment recovery time — để biết chiến lược có hiệu quả.

## Quyết định

| Hồ sơ / tình huống | Chiến lược mặc định | Khi nào khác |
|---|---|---|
| Web/API stateless, ≥ 2 instance | **Rolling** với health check + surge, kết hợp **feature flag** cho tính năng rủi ro | **Canary** (1–5% → 25% → 100%, mỗi bước ≥ 10–15 phút quan sát) khi ≥ M và có SLI theo phiên bản |
| Thay đổi lớn/khó lùi (đổi runtime, framework major) | **Blue/green** (hai môi trường, chuyển traffic, giữ xanh cũ ≥ 1 giờ) | Chi phí gấp đôi tạm thời; cần DB tương thích hai bản |
| Có DB | Expand/contract: (1) thêm cột/bảng mới + backfill nền, (2) deploy code dùng cả hai, (3) chuyển, (4) deploy code chỉ dùng mới, (5) contract xoá cũ ở release sau | Migration khoá bảng lớn → online tool (pt-osc/gh-ost/`CREATE INDEX CONCURRENTLY`) — chi tiết 09 |
| Static site/CDN | Atomic deploy + instant rollback (giữ N bản trước), cache purge có chủ | — |
| Mobile app | Staged rollout store (1% → 10% → 50% → 100%) + remote config/flag để tắt tính năng không cần bản mới; halt rollout khi crash-free < ngưỡng | Không rollback được bản đã cài → flag là đường lùi duy nhất |
| Desktop/CLI/SDK | Kênh beta/stable, auto-update ký số, có cách cài lại bản trước; semver + changelog | Thư viện: không "deploy" nhưng phát hành có deprecation window |
| Embedded/IoT | OTA A/B partition (dual bank) + rollback tự động khi boot fail; rollout theo lô | Không có A/B → chỉ cập nhật khi có cách khôi phục vật lý |
| Agent/LLM (prompt, model, tool list) | Prompt/model/tool list là release: canary theo % traffic + eval regression trước; flag để quay về prompt/model cũ | Đổi model = release lớn (eval + canary dài hơn) — xem [`../13-ai-engineering/evaluation.md`](../13-ai-engineering/evaluation.md) |
| Feature flag | **OpenFeature** (CNCF incubating; SDK server/web nhiều ngôn ngữ) + provider tự host (flagd/Unleash/GO Feature Flag) hoặc SaaS | Flag tự viết (bảng DB + cache) cho dự án S; vẫn có kill switch và dọn flag |

## Checklist

- [ ] `OPS-DEPLOY-001` **MUST** Build một lần, một artifact bất biến (image digest/tarball checksum) đi qua staging → production; production không rebuild. → Kiểm: pipeline promote cùng digest (`image@sha256:…` giống nhau ở hai môi trường); log deploy ghi digest. · Nguồn: SLSA (artifact nhất quán); [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `OPS-DEPLOY-002` **MUST** Rollback một bước (lệnh/nút) về artifact trước trong < 15 phút, **đã diễn tập** trên production (hoặc staging giống production) với thời gian ghi lại. → Kiểm: `docs/ops/rollback-drills.md` có ngày + thời gian đo < 15 phút; runbook rollback trỏ lệnh cụ thể. · Nguồn: P8; khung cũ GĐ 6 "rollback sẵn sàng"; DORA recovery time
- [ ] `OPS-DEPLOY-003` **MUST** Mọi migration schema tương thích với phiên bản code đang chạy và phiên bản trước (expand → migrate → contract); không drop/rename cột/bảng cùng deploy dùng nó; contract ở release sau khi code cũ không còn. → Kiểm: CI lint migration (cấm `DROP COLUMN`/`RENAME` không kèm flag `contract` và ghi release trước); test chạy test suite bản N−1 trên schema N. · Nguồn: [`../09-database/migrations.md`](../09-database/migrations.md); P8
- [ ] `OPS-DEPLOY-004` **MUST** Smoke test tự động sau mỗi deploy (health, login/luồng chính, header bảo mật, phiên bản đúng) trên URL thật; thất bại → rollback tự động hoặc chặn promote. → Kiểm: bước `post-deploy-smoke` trong pipeline; log có kết quả; thất bại thử nghiệm → pipeline lùi. · Nguồn: khung cũ GĐ 6 cổng; [`../14-testing-quality/e2e-and-accessibility.md`](../14-testing-quality/e2e-and-accessibility.md)
- [ ] `OPS-DEPLOY-005` **MUST@L** Deploy ghi marker (phiên bản, commit, digest, người/CI, thời điểm) vào hệ quan sát và changelog; mọi instance báo phiên bản qua endpoint/metric (`service.version`). → Kiểm: annotation deploy trên dashboard; `/version` hoặc metric `build_info` khớp commit. · Nguồn: [`observability.md`](observability.md); DORA
- [ ] `OPS-DEPLOY-006` **MUST@L** Tính năng rủi ro (thanh toán, thay đổi luồng chính, tích hợp mới, prompt/model mới) đứng sau feature flag có **kill switch** tắt được không cần deploy; flag mặc định tắt ở production khi mới deploy. → Kiểm: flag registry liệt kê; test tắt flag runtime → hành vi cũ; mặc định `false` trong cấu hình prod. · Nguồn: OpenFeature; P8
- [ ] `OPS-DEPLOY-007` **MUST@L** Deploy production chỉ từ pipeline (không từ máy cá nhân), từ nhánh chính/tag, qua environment có cổng (CI xanh + approval khi ≥ M); identity deploy riêng, OIDC. → Kiểm: environment `production` có `required reviewers`/branch rule; không có credential deploy trên máy dev; log deploy ghi identity CI. · Nguồn: [`../10-workflow/ci-cd-pipeline.md`](../10-workflow/ci-cd-pipeline.md); GitHub Actions hardening
- [ ] `OPS-DEPLOY-008` **MUST@L** Health check readiness ngăn instance mới nhận traffic khi chưa sẵn sàng; rolling giữ ≥ 1 instance cũ đến khi mới healthy (`maxUnavailable`/`minReadySeconds`); tắt máy graceful (drain, SIGTERM, timeout). → Kiểm: cấu hình deployment; test deploy không tạo lỗi 5xx (k6/synthetic chạy trong lúc deploy = 0 lỗi). · Nguồn: Kubernetes rolling update docs (chưa fetch lại); [`../05-architecture/resilience-and-scalability.md`](../05-architecture/resilience-and-scalability.md)
- [ ] `OPS-DEPLOY-009` **MUST@L** Canary hoặc staged rollout cho dịch vụ hướng người dùng: ≥ 2 bước, mỗi bước quan sát SLI theo phiên bản ≥ 10 phút, tự động dừng/lùi khi error rate/latency/business metric xấu hơn baseline theo ngưỡng. → Kiểm: cấu hình rollout (Argo Rollouts/Flagger/store staged rollout/flag %) với phân tích tự động; log một lần tự động abort (diễn tập). · Nguồn: Google SRE Workbook — Canarying Releases (chưa fetch lại 2026-10-13); DORA change fail rate
- [ ] `OPS-DEPLOY-010` **MUST@L** Đo DORA tối thiểu hàng tháng: deployment frequency, change lead time, change fail rate, failed deployment recovery time; dùng làm baseline **trước** khi bật tự động hoá/agent. → Kiểm: báo cáo tháng sinh từ dữ liệu pipeline/incident; baseline ghi trong PROGRESS/ADR trước autopilot. · Nguồn: DORA metrics; catalog stored 21 §8 (đo DORA trước khi tự trị)
- [ ] `OPS-DEPLOY-011` **MUST@L** Freeze có chủ: cửa sổ đóng băng (lễ, chiến dịch, kiểm toán) ghi lịch; deploy trong freeze chỉ hotfix có duyệt; không freeze vĩnh viễn. → Kiểm: `docs/ops/freeze-calendar.md`; pipeline kiểm lịch và yêu cầu label `hotfix-approved`. · Nguồn: SRE Book — release engineering (chưa fetch lại)
- [ ] `OPS-DEPLOY-012` **MUST@L** Flag có chủ, ngày hết hạn và được dọn: flag tạm > 90 ngày = nợ kỹ thuật có ticket; flag registry trong repo. → Kiểm: script liệt kê flag quá hạn từ registry; CI cảnh báo. · Nguồn: OpenFeature (flag lifecycle); [`maintenance-and-lifecycle.md`](maintenance-and-lifecycle.md)
- [ ] `OPS-DEPLOY-013` **MUST@L** Mobile: staged rollout theo % với ngưỡng crash-free dừng rollout; remote config/flag để tắt tính năng; API backend tương thích ≥ 2 phiên bản app gần nhất (không ép cập nhật trừ bảo mật). → Kiểm: cấu hình rollout store; test contract API với app N−1; chính sách min version. · Nguồn: [`../02-profiles/mobile-app.md`](../02-profiles/mobile-app.md)
- [ ] `OPS-DEPLOY-014` **MUST@L** Agent/LLM: đổi prompt/model/tool list đi qua eval regression + canary theo % phiên; có flag quay về cấu hình cũ; model id ghim (không `latest`). → Kiểm: pipeline release prompt có bước eval với ngưỡng; cấu hình model id cố định; flag `llm.config_version`. · Nguồn: [`../13-ai-engineering/evaluation.md`](../13-ai-engineering/evaluation.md); research AI (prompt là code, model pinned)
- [ ] `OPS-DEPLOY-015` **MUST@L** Blue/green hoặc multi-region rollout theo vùng cho thay đổi lớn; giữ môi trường cũ ≥ 1 giờ sau chuyển; DNS/LB chuyển ngược trong < 5 phút. → Kiểm: drill blue/green có thời gian. · Nguồn: SRE Workbook
- [ ] `OPS-DEPLOY-016` **SHOULD** Deploy nhỏ và thường xuyên (mỗi PR một deploy hoặc ≥ hàng ngày) thay vì gộp lớn; PR lớn chia nhỏ sau flag. → Kiểm: DORA deployment frequency ≥ hàng ngày; kích thước deploy (số commit) median nhỏ. · Nguồn: DORA
- [ ] `OPS-DEPLOY-017` **SHOULD** Backfill/migration dữ liệu lớn chạy nền theo lô, idempotent, có tiến độ và dừng được; không trong transaction dài khoá bảng. → Kiểm: job backfill có checkpoint; test chạy lại không trùng. · Nguồn: [`../09-database/migrations.md`](../09-database/migrations.md)
- [ ] `OPS-DEPLOY-018` **SHOULD** Deploy ngoài giờ cao điểm cho thay đổi rủi ro; không deploy khi không có người theo dõi ≥ 30 phút sau (trừ tự động có auto-rollback). → Kiểm: chính sách trong runbook; pipeline cảnh báo deploy ngoài giờ có người. · Nguồn: SRE Book
- [ ] `OPS-DEPLOY-019` **SHOULD** Embedded/IoT: OTA với phân vùng A/B, chữ ký firmware, rollback tự động khi boot thất bại, rollout theo lô thiết bị. → Kiểm: test boot fail → về bản cũ; firmware ký. · Nguồn: [`../02-profiles/embedded-iot.md`](../02-profiles/embedded-iot.md)
- [ ] `OPS-DEPLOY-020` **MAY** Dùng Argo Rollouts/Flagger (Apache-2.0) cho canary tự động trên K8s với phân tích từ Prometheus. → Kiểm: `AnalysisTemplate` với metric SLI. · Nguồn: Argo Rollouts/Flagger docs (chưa xác minh phiên bản)
- [ ] `OPS-DEPLOY-021` **MAY** Shadow/dark traffic cho thay đổi backend lớn (sao chép request sang bản mới, bỏ kết quả) trước canary. → Kiểm: cấu hình mirror; so sánh kết quả. · Nguồn: SRE Workbook

## Bẫy thường gặp

1. **Rollback "có" nhưng chưa bao giờ thử** → lúc cần phát hiện migration không lùi được hoặc artifact cũ đã bị dọn. Tránh: `OPS-DEPLOY-002`.
2. **Drop cột cùng deploy** → bản cũ còn chạy trong rolling lỗi 500 hoặc rollback bất khả. Tránh: expand/contract (`OPS-DEPLOY-003`).
3. **Rebuild cho production** → bản test ở staging khác bản lên prod (dependency trôi). Tránh: promote digest (`OPS-DEPLOY-001`).
4. **Canary 1 phút rồi 100%** → không đủ dữ liệu, canary chỉ là nghi thức. Tránh: ≥ 10 phút/bước + phân tích tự động.
5. **Flag không bao giờ dọn** → hàng trăm nhánh chết, không ai biết trạng thái prod. Tránh: hạn + registry (`OPS-DEPLOY-012`).
6. **Deploy từ laptop** "cho nhanh" → không truy vết, không qua cổng, credential ở máy cá nhân. Tránh: `OPS-DEPLOY-007`.
7. **Smoke test chỉ `/health`** → health 200 nhưng login hỏng. Tránh: smoke luồng chính thật + header (`OPS-DEPLOY-004`).
8. **Freeze vĩnh viễn** sau một sự cố → thay đổi dồn thành bản lớn rủi ro hơn. Tránh: freeze có hạn (`OPS-DEPLOY-011`).
9. **Mobile không có flag** → bug phải chờ review store nhiều ngày. Tránh: remote config + staged rollout (`OPS-DEPLOY-013`).
10. **Đổi model LLM qua `latest`** → hành vi đổi âm thầm, không eval, không rollback. Tránh: ghim model id + canary (`OPS-DEPLOY-014`).
11. **Đổi mạng/DNS/TLS gộp cùng deploy app** → không biết cái nào gây lỗi. Tách thay đổi hạ tầng và app thành deploy riêng.

## Cổng tự động

| Việc | Công cụ (license) | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Promote cùng digest | pipeline | `cosign verify` + so digest staging/prod | deploy | lệch = dừng |
| Lint migration tương thích | script/linter (vd `squawk` cho Postgres, MIT) | cấm DROP/RENAME không có cờ contract; `CREATE INDEX` phải `CONCURRENTLY` | CI PR | vi phạm = đỏ |
| Test N−1 | job chạy test suite bản trước trên schema mới | — | CI | đỏ = chặn |
| Smoke sau deploy | Playwright/k6/curl script | luồng chính + header + `/version` | post-deploy | fail = rollback |
| Zero-downtime | k6 chạy trong lúc deploy staging | 0 lỗi 5xx | CI deploy staging | lỗi > 0 = đỏ |
| Canary phân tích | Argo Rollouts/Flagger `AnalysisTemplate`; hoặc script so SLI canary vs baseline | error rate, p95, business metric | rollout | xấu hơn ngưỡng = abort |
| Flag quá hạn | script đọc flag registry | > 90 ngày | CI lịch tuần | cảnh báo + ticket |
| Freeze | pipeline đọc `freeze-calendar.md` | cần label `hotfix-approved` | deploy | thiếu = dừng |
| Rollback drill | ghi `rollback-drills.md` | ≤ 90 ngày (M) | GO/NO-GO | quá hạn = NO-GO |
| DORA | script từ pipeline + incident | hàng tháng | lịch | báo cáo |

## Nguồn

- DORA — software delivery metrics (change lead time, deployment frequency, failed deployment recovery time, change fail rate, deployment rework rate): <https://dora.dev/guides/dora-metrics-four-keys/> — xác minh 2026-10-13.
- OpenFeature (CNCF incubating; SDK server: Go/Java/Node/Python/.NET/PHP/Ruby/Rust…, client: Web/Kotlin/Swift; `@openfeature/server-sdk` 1.23.0, `@openfeature/web-sdk` 1.10.0, `openfeature-sdk` 0.10.0): <https://openfeature.dev/docs/reference/intro>, <https://openfeature.dev/specification/> — xác minh 2026-10-13 (số phiên bản spec không hiện trên trang).
- Google SRE Workbook — Canarying Releases; SRE Book — Release Engineering — (chưa fetch lại 2026-10-13; xác minh URL trước khi dẫn).
- GitHub Actions security hardening (environment, OIDC): <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions> — xác minh 2026-10-13.
- Khung cũ X-stored `01-process-and-standards.md` GĐ 6 ("backup & rollback sẵn sàng", staging giống production), commit `1b80fe4`; catalog `seeker19110/stored` 21 §8 (đo DORA trước tự trị), 09 §1.3 (GO/NO-GO), đọc 2026-10-13.
- (chưa xác minh 2026-10-13) Argo Rollouts, Flagger, squawk, flagd/Unleash phiên bản & license — xác minh trước khi dùng.
