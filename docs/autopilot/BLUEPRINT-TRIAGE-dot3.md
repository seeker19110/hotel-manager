Bảng phân loại 373 mục MUST còn mở trong BLUEPRINT.md. Không sửa file nào trong repo; bảng TSV còn được lưu ở `/tmp/claude-0/-home-user-hotel-manager/67d53b98-c09b-5f85-9c6e-7ba196497265/scratchpad/tri.tsv`.

**Kết quả:** A 54 · B 251 · C 44 · D 24 (tổng 373, đã đối chiếu: không thiếu ID, không trùng ID).

Cách xếp: mục được xếp A khi phần chính của "Kiểm" đã có bằng chứng thật. Nếu còn thiếu một phần kiểm nhỏ và làm nhanh được thì xếp B. Lưu ý: ruleset chưa được import lên GitHub, nên các mục chỉ cần đọc JSON thì là A, còn các mục phải gọi API thì là C.

**Phát hiện đáng chú ý:**
1. `packages/app/src/files/files.ts:75` gọi `storage.put` (S3) **bên trong transaction CSDL**. Lỗi này vi phạm DB-TX-003 và ARC-INT-003.
2. `loadConfig` chỉ chạy khi có request đầu tiên, không chạy lúc khởi động. Ngoài ra `apps/web/proxy.ts` và `app/serwist/[path]/route.ts` đọc thẳng `process.env`.
3. Repo còn thiếu: README.md, LICENSE, .gitattributes, .editorconfig, .nvmrc, CHANGELOG, SECURITY.md, CODEOWNERS, docs/ops, OpenAPI.
4. `.github/pull_request_template.md` vẫn là mẫu của khung (nhắc tới `scripts/xt.py validate`), không phải mẫu của sản phẩm.
5. `.github/dependabot.yml` thiếu hệ sinh thái npm và docker, còn mục pip thì không dùng tới.
6. Playwright chỉ có project `chromium-mobile`. Chưa có `forbidOnly`, `retries` = 0, trace để `retain-on-failure`.
7. Better Auth đang dùng scrypt mặc định, chưa phải Argon2id. Cookie chưa có tiền tố `__Host-`.
8. Các FK không ghi `ON DELETE` tường minh. Retry 40001/40P01 chưa có backoff. Pool pg và các lời gọi fetch/S3 không có timeout.
9. Không có bước chuẩn hoá NFC ở biên đầu vào.
10. Kiểm của PM-REQ-007 bị lỗi regex: "ADR-0001" khớp ra "R-000" nên báo trùng giả. Nên ghi phản hồi về khung.
11. Kiểm của WF-CI-001 tự mâu thuẫn ("4" so với "3" context), trong khi ruleset đang đòi 6.
12. Phiên chính đang làm dở trên cây làm việc: `docs/autopilot/PLAN.md` đã chuyển sang `archive/PLAN-dot-2.md`, `DECISIONS.md` chưa được track, các SPEC đang sửa. Bằng chứng nào trỏ tới `docs/autopilot/PLAN.md` cần đổi đường dẫn.

**Đếm theo tiền tố:**
| Tiền tố | A | B | C | D | Tổng |
|---|---|---|---|---|---|
| BASE | 10 | 39 | 3 | 0 | 52 |
| OPS | 0 | 16 | 9 | 4 | 29 |
| WF | 4 | 13 | 9 | 0 | 26 |
| XC | 2 | 21 | 0 | 3 | 26 |
| FE | 6 | 16 | 1 | 2 | 25 |
| CMP | 3 | 17 | 1 | 4 | 25 |
| UX | 1 | 21 | 0 | 0 | 22 |
| BE | 5 | 16 | 0 | 1 | 22 |
| DB | 0 | 18 | 2 | 1 | 21 |
| PM | 0 | 10 | 5 | 4 | 19 |
| SEC | 6 | 8 | 3 | 1 | 18 |
| QA | 3 | 14 | 0 | 1 | 18 |
| ARC | 3 | 13 | 0 | 1 | 17 |
| IND | 1 | 8 | 6 | 2 | 17 |
| STD | 2 | 11 | 2 | 0 | 15 |
| LOOP | 6 | 5 | 1 | 0 | 12 |
| PRF | 2 | 5 | 2 | 0 | 9 |

**Danh sách đầy đủ** (`ID<TAB>bucket<TAB>bằng chứng hoặc ghi chú`):
```
BASE-CFG-001	A	packages/app/src/config/schema.ts, packages/app/src/config/schema.test.ts, ci:quality (no literal DB URL/host/key in src)
BASE-CFG-002	B	schema+test exist but loadConfig is lazy; add boot-time validate+exit≠0; proxy.ts/serwist route read process.env
BASE-CFG-006	A	no CLI takes secrets; secrets via env/secret files: packages/app/src/config/schema.ts, deploy/compose.yaml
BASE-CFG-007	B	add doc table of safe defaults + print redacted effective config at startup
BASE-CFG-008	A	packages/app/src/config/schema.test.ts, packages/app/src/config/client-bundle.test.ts, ci:quality
BASE-DATA-001	B	add .editorconfig charset=utf-8, encoding scan, DB round-trip test "Tiếng Việt 🇻🇳", assert charset=utf-8
BASE-DATA-002	B	no NFC normalization at input boundary (only NFD in reconcile.ts); normalize in zod schemas + test
BASE-DATA-003	B	no lint (Biome lacks strict-boolean); add tests 0/""/[]/null per optional field
BASE-DATA-005	B	schema OK (bigint); extend rounding-arch.test.ts to ban parseFloat/Number( in money module
BASE-DATA-006	B	all cols timestamptz today; add catalog test banning timestamp w/o tz + grep ban new Date().toString()
BASE-DEP-003	B	add .nvmrc/.node-version used by CI + weekly endoflife.date check job
BASE-DEP-004	A	.github/workflows/dep-audit.yml (PR + weekly cron, pnpm audit --audit-level moderate), ci:dep-audit
BASE-DEP-006	B	PR template is framework's (wrong); write product PR template "Phụ thuộc mới" + CI lockfile-diff vs PR body check
BASE-DEP-007	B	.github/dependabot.yml lacks npm (pnpm) + docker ecosystems; pip entry is stale
BASE-DEP-008	B	actions SHA + deploy images digest + binary sha256 OK; CI service postgres:17.11 not digest-pinned
BASE-DEP-009	B	add trivy/grype scan of deploy/postgres image (and app image when built) in CI
BASE-DOC-001	B	no README.md at root; write with required headings + check script
BASE-DOC-004	B	no docs/ops/RUNBOOK.md; write deploy/rollback/diagnostics/alerts/secret locations
BASE-DOC-005	B	add CI readme-smoke job running README/xt.yaml install→test from clean clone
BASE-DOC-006	B	add link check (.xtemplates/scripts/check-links.py or lychee --offline) to CI
BASE-DOC-007	B	generate OpenAPI from zod registry (http/registry.ts) + git diff --exit-code in CI
BASE-DOC-008	B	xt.py progress-check passes locally; not run in CI — add to xt.yaml lint/CI
BASE-ERR-001	B	grep finds no empty catch; enable Biome noEmptyBlockStatements (not in recommended)
BASE-ERR-002	B	500 problem tested (command-route.db.test.ts) but no stack logged, no onRequestError/process handler
BASE-ERR-004	B	no timeouts on pg Pool (connectionTimeoutMillis), S3 aws4fetch, client fetch; add + hung-server test
BASE-ERR-006	B	logger lacks service, version, env, numeric level, span_id; add + JSON-schema test
BASE-ERR-007	A	packages/app/src/logging/logger.ts (key redaction), packages/app/src/logging/logger.test.ts, ci:quality
BASE-ERR-008	B	JSON.stringify escapes CR/LF but no test; add "\n[ERROR] fake" single-record test
BASE-ERR-009	B	redact() keeps only name+message; add exception.type/message/stacktrace + cause chain
BASE-ERR-010	B	add test: auth backend (getSession) throws → 401/403 not 200; list fail-open points in THREAT-MODEL
BASE-ERR-011	C	needs running error tracker (self-host GlitchTip/OTel) on staging + on-call alert channel
BASE-GATE-003	B	package.json lint "biome ci ." lacks --error-on-warnings; biome-ignore all have reasons
BASE-GATE-005	A	xt.yaml test, vitest.config.ts, .github/workflows/ci.yml (xt.py ci-check: no continue-on-error), ci:quality
BASE-GATE-007	A	.github/rulesets/main.json (required_status_checks, strict_required_status_checks_policy: true)
BASE-GATE-019	A	.github/rulesets/main.json (bypass_actors: [])
BASE-REPO-002	A	.gitignore; git ls-files check returns 0 lines
BASE-REPO-003	B	add .gitattributes (* text=auto, *.sh eol=lf)
BASE-REPO-004	B	add LICENSE (Proprietary, owner) + "license": "UNLICENSED" in package.json files (owner can change later)
BASE-REPO-005	B	CI checks PR title only; add commit-msg hook + CI check on every PR commit
BASE-REPO-006	B	pick version source (package.json version) + release/tag workflow; no release yet
BASE-REPO-007	B	add CHANGELOG.md (Keep a Changelog, ## [Unreleased]) + CI check
BASE-REPO-008	C	ruleset JSON exists but not imported on GitHub (PROGRESS Tiếp theo 1); owner must import
BASE-REPO-013	C	depends on active ruleset (owner import); convention already in AGENTS.md §4
BASE-SEC-001	B	zod strict schemas on commands/webhook; add parametrized bad-input tests (overlong, null, odd Unicode, end<start)
BASE-SEC-004	B	no TLS-disable flags found; DB conn lacks sslmode; add http:// outbound-block test
BASE-SEC-005	A	packages/app/src/config/schema.ts (required secrets, min length), packages/app/src/config/schema.test.ts; grep no changeme/admin
BASE-SEC-006	B	no app Dockerfile yet; add web/worker Dockerfile with USER non-root + document token scopes
BASE-SEC-007	B	add SAST (Semgrep OSS/CodeQL) job + path traversal test
BASE-SEC-009	B	add SECURITY.md (contact + ≤14-day response); contact address needs owner confirmation
BASE-SEC-010	B	compose has no DB/S3 ports (A part); set dev bind 127.0.0.1; external port scan on VPS = human
BASE-SEC-011	B	docs/design/THREAT-MODEL.md exists; all TM rows still "mở" — update status + evidence test paths for Cao rows
BASE-SEC-013	B	add PII classification table + mark PII columns (COMMENT); DPIA itself is legal/human
STD-A11Y-004	C	manual keyboard + screen-reader test by a person, recorded in GO-NO-GO.md
STD-API-001	B	write openapi.yaml 3.1 (webhook + /api/v1 commands) from API-CONTRACT.md/registry
STD-API-008	B	after OpenAPI: add oasdiff breaking job
STD-PRIV-001	A	PROJECT.md §6 (grep 91/2025/QH15 matches)
STD-PRIV-002	B	add docs/compliance/data-inventory.csv + script vs migrations PII columns
STD-PRIV-004	B	implement rights flows (access/delete/withdraw) + E2E rights-* tests
STD-PRIV-005	B	retention purge job (files.delete_after, import_rows 30d — PROGRESS 0a) + test
STD-PROC-001	B	add ISO/IEC 25010:2023 table in PROJECT.md (NFR thresholds exist in §5)
STD-PROC-002	B	no tags/releases yet; define SemVer release process (tagging at G7)
STD-PROC-003	B	contract diff job (oasdiff) after OpenAPI exists
STD-PROC-004	A	.github/workflows/ci.yml (PR title Conventional Commits ≤72), .github/rulesets/main.json (squash only), ci:quality
STD-SEC-001	B	PROJECT.md says "ASVS 5.0 L2"; change to "ASVS 5.0.0 L2"
STD-SEC-003	B	add OWASP Top 10:2025 A01–A10 mapping table to THREAT-MODEL
STD-SEC-004	B	add tests tagged api1-bola / api5-bfla (existing IDOR/role tests can be renamed/extended)
STD-SEC-007	C	CIS benchmark scan of real VPS/host (docker-bench) needs provisioned server
ARC-STYLE-001	B	ADR-0001 has options; add "điều kiện đọc lại" heading; status still proposed
ARC-STYLE-002	A	docs/adr/0001-modular-monolith-typescript-postgres.md (web + worker one codebase)
ARC-STYLE-003	A	packages/app/src/config/schema.ts, deploy/postgres/Dockerfile (no COPY .env), deploy/compose.yaml (runtime secrets), ci:gitleaks
ARC-STYLE-006	D	single modular monolith, no separately deployed services owning tables
ARC-MOD-003	B	domain has no deps (packages/domain/package.json) but add dependency-cruiser/arch test in CI
ARC-MOD-004	B	add circular-dependency rule (dependency-cruiser/madge) in CI
ARC-MOD-005	B	add rule: import only package entry points (@hm/app/http etc.), no deep paths
ARC-MOD-008	B	add docs/architecture/domains.md + script matching packages/app/src/* dirs
ARC-ADR-002	B	numbering OK (0001, 0002); add CI script for numbering/filename regex
ARC-ADR-003	B	both ADRs have sections; add CI heading-lint script
ARC-ADR-004	B	add CI diff guard for accepted ADRs (both still proposed)
ARC-INT-003	B	outbox in tx OK, but files.ts calls storage.put (S3) inside DB transaction — move out (2-phase)
ARC-INT-008	A	packages/app/src/ledger/bank-inbox.ts, packages/app/src/http/webhook-route.ts, packages/app/src/reconciliation/reconciliation.db.test.ts (S-016/S-017), ci:quality
ARC-RES-001	B	pg Pool no connectionTimeoutMillis; S3/fetch no AbortSignal.timeout (statement_timeout on role exists)
ARC-RES-002	B	add retry helper (transient-only, exp backoff+jitter, caps) for S3/SMTP; tests 4xx no retry
ARC-RES-005	B	state in DB/S3 already; add E2E with 2 web instances
ARC-RES-009	B	add graceful SIGTERM shutdown (web/worker: stop accept, drain, close pools) + test
UX-A11Y-001	B	axe filters only serious/critical and not all routes; require violations.length===0 on every page
UX-A11Y-002	B	add check:contrast over tokens in globals.css (axe color-contrast already in E2E)
UX-A11Y-003	B	add keyboard-only E2E for main flow
UX-CONTENT-001	B	add check:vi-diacritics script over apps/web
UX-CONTENT-002	B	NFC normalization at API boundary + unit test (same as BASE-DATA-002)
UX-CONTENT-005	B	add dark-pattern checklist to PR template (no subscription/consent UI yet)
UX-CONTENT-006	B	E2E: amount shown at first step = confirm step (thu tiền/booking)
UX-DS-001	B	tokens in apps/web/app/globals.css :root; themeColor/manifest hard-coded — generate or reference + build:tokens check
UX-DS-002	B	hex outside tokens in globals.css (skeleton gradient, #0b6b2e); add check:hex-hardcode
UX-DS-003	B	add contrast script over token pairs (single light theme)
UX-DS-006	B	system font stack only; add E2E screenshot of Vietnamese diacritics string
UX-VISUAL-001	B	CSS has prefers-reduced-motion block; add Playwright emulateMedia getAnimations test
UX-VISUAL-002	A	apps/web/app/globals.css (only spinner/skeleton loading anims, reduced-motion block; no carousel/video)
UX-VISUAL-006	B	pwa-shell.tsx uses "⚠" glyph as icon; replace with SVG icon + emoji-regex check
UX-VISUAL-007	B	add CREDITS.md (icons self-generated by apps/web/scripts/gen-icons.mjs) + check script
UX-RESP-001	B	E2E only Pixel 7 (412px); add 320px viewport scrollWidth check per route
UX-RESP-005	B	wrap :hover CSS in @media (hover: hover) + touch E2E
UX-RESP-008	B	playwright.config.ts has only chromium-mobile; add desktop project
UX-STATE-001	B	no Storybook; add stories/tests for loading/empty/error/default per data component
UX-STATE-005	B	add E2E mock 500 → no stack text, working Thử lại button
UX-STATE-006	B	button disables while sending (command-form); add E2E double-click → 1 request
UX-STATE-008	B	add confirm dialog (object + consequence, Esc cancels) for irreversible actions + E2E
FE-BUILD-001	B	engines + packageManager OK; add .nvmrc and setup-node node-version-file
FE-BUILD-003	B	no ignoreBuildErrors; tsconfig.base skipLibCheck:true + gate runs build before typecheck/lint
FE-BUILD-004	B	biome ci in CI OK; add pre-commit hook (lefthook/simple-git-hooks) on staged files, --error-on-warnings
FE-BUILD-005	B	no boot-time env fail; process.env read outside schema (proxy.ts, serwist route)
FE-SEC-001	A	biome.json (recommended incl. noDangerouslySetInnerHtml); grep: no DOM sinks in apps/web; ci:quality
FE-SEC-002	D	no externally supplied URLs rendered; all hrefs are internal routes with UUID ids
FE-SEC-003	B	nonce+strict-dynamic, object-src none, frame-ancestors OK (security.test.ts, pwa.spec.ts); base-uri is 'self' not 'none'
FE-SEC-005	B	HttpOnly/SameSite tested (auth.db.test.ts); add E2E localStorage/document.cookie no-token + Secure check
FE-FORM-001	B	server zod in http/registry.ts; client forms don't share schema — export/import same schema
FE-FORM-002	B	TextField sets aria-invalid/aria-describedby (field.tsx); add E2E invalid-submit assertion
FE-FORM-007	B	idempotency key OK (rental.spec S-010/S-011); add E2E double-click → 1 request
FE-TEST-001	B	no component tests; add Testing Library tests by role/label
FE-TEST-002	B	add desktop project; axe after each step
FE-TEST-003	B	set TZ=UTC/LANG in test scripts, fake timers, --repeat-each=3 check
FE-TEST-006	B	add CI/PR-policy check: fix: PR must touch a test
FE-PERF-001	C	field RUM/CrUX p75 needs real users in production
FE-PERF-002	B	add Lighthouse CI (lighthouserc, 3 runs median, assertions) on e2e build
FE-PERF-004	B	add size-limit budget + docs/PERF-BUDGET.md
FE-PERF-009	D	no third-party scripts (CSP script-src 'self' + nonce)
FE-RENDER-001	B	add docs/ROUTES.md render-mode table + script vs app/ tree
FE-RENDER-002	A	apps/web/proxy.ts (no-store on all non-icon paths), apps/web/e2e/smoke.spec.ts, apps/web/e2e/pwa.spec.ts (S-005), ci:e2e
FE-STATE-001	A	server components load data (apps/web/lib/page.tsx); no useEffect+fetch in apps/web; ci:quality
FE-STATE-003	A	apps/web/components/command/command-form.tsx (router.refresh after success), apps/web/e2e/rental.spec.ts, ci:e2e
FE-STATE-005	A	apps/web/components/command/use-command.ts (no auto-retry; manual resend same key), apps/web/e2e/rental.spec.ts (S-010/S-011)
FE-STATE-008	A	no persistent client storage writes in app; logout clears storage: apps/web/components/pwa/pwa-shell.tsx, apps/web/e2e/smoke.spec.ts
BE-API-001	B	API-CONTRACT.md is prose; add OpenAPI 3.1 + spectral lint in CI
BE-API-003	A	packages/app/src/http/registry.ts (zod strictObject), packages/app/src/http/command-route.db.test.ts (400/422), ci:quality
BE-API-008	B	key/replay/7-day store OK; mismatch returns 409 (item wants 422), in-progress 409 untested; document in OpenAPI
BE-API-009	B	401/404 tested; add route-guard scan + public endpoints list (security: []) in spec
BE-AUTH-001	B	Better Auth default scrypt; configure Argon2id (node:crypto argon2 / @node-rs/argon2) + $argon2id$ test
BE-AUTH-004	B	cookie lacks __Host- prefix (useSecureCookies → __Secure-); add logout-reuse 401 + id-rotation tests
BE-AUTH-009	B	actor from session (resolveActor); add test body user_id ignored + route-guard scan
BE-AUTH-010	A	packages/app/src/tenancy/tenancy.db.test.ts, packages/testkit/src/isolation.ts, packages/app/src/access/access.db.test.ts, packages/app/src/files/files.db.test.ts, ci:quality
BE-JOB-003	B	pg-boss retryLimit 5 + backoff (relay.ts); add delay cap/jitter test + permanent errors → DLQ without retry
BE-JOB-004	B	DLQ exists + test (command-pipeline-relay.db.test.ts); add DLQ>0 alert rule + redrive runbook
BE-JOB-007	B	payload ids-only tested; add zod validation of job payload in worker
BE-CACHE-001	A	apps/web/proxy.ts (Cache-Control: no-store), apps/web/e2e/smoke.spec.ts, apps/web/e2e/pwa.spec.ts, ci:e2e
BE-FILE-001	B	magic bytes OK (inspect.ts); add tests for disguised file (php as png), double extension rejection
BE-FILE-003	A	packages/app/src/files/files.ts (key = org/ownerType/uuid, no user filename), packages/app/src/files/files.db.test.ts
BE-FILE-005	B	authz + ≤5 min signed URL + cross-org 404 tested (files.db.test.ts); add expired-URL → 403 test
BE-INT-002	B	single SIM_WEBHOOK_SECRET; accept ≥2 secrets during rotation + test
BE-INT-004	A	packages/app/src/reconciliation/reconciliation.db.test.ts (S-016 dup, S-030 order), packages/app/src/ledger/bank-inbox.ts, ci:quality
BE-INT-007	D	no outbound side-effecting vendor API (bank is inbound webhook only; no PSP)
BE-REL-001	B	same as ARC-RES-001: pool connect/acquire timeouts, fetch AbortSignal.timeout
BE-REL-003	B	add bounded retry policy (3, Retry-After, no POST retry) for outbound S3/SMTP + tests
BE-REL-004	B	implement SIGTERM drain for web/worker + test
BE-REL-006	B	only auth has rate limit (Better Auth DB-backed); add 429+Retry-After for commands/webhook/export + test
DB-BACKUP-001	C	RPO/RTO draft in PROJECT.md §5; owner must sign off docs/ops/RPO-RTO.md
DB-BACKUP-002	B	add scheduled pgBackRest (cron/systemd timer in deploy/) + failure alert config
DB-BACKUP-003	B	ci:backup-restore drills PITR on fake data; add docs/ops/restore-drills.md record (real pre-launch drill = G7)
DB-BACKUP-004	C	requires off-site backup storage account on another provider (purchase)
DB-MODEL-001	B	all timestamps are timestamptz; add catalog lint test + "+07:00" round-trip test
DB-MODEL-002	B	money bigint OK; numeric(18,4) unit_price/quantity need ADR listing + type-lint test
DB-MODEL-004	B	FKs have no explicit ON DELETE; add + catalog test for FK index/action
DB-MODEL-005	B	DB rejects bad data (tenancy/ledger db tests); add script counting nullable cols without reason
DB-PERF-001	B	add EXPLAIN tests for hot queries (no Seq Scan on large tables) + docs/db/explain
DB-PERF-004	B	pool max set (20/10) but no acquire timeout; add docs/db/connections.md budget
DB-PERF-008	B	add autovacuum/XID-age alert rules (monitoring config) in deploy/
DB-MIG-001	B	versioned Kysely migrations OK; add schema drift check in CI (scripts/check-erd.py not in CI)
DB-MIG-003	B	hook asks on migrations edit (guard.py); add CI check that merged migration files are unchanged vs main
DB-MIG-008	B	add squawk (or script) banning DROP/RENAME/ALTER TYPE in CI
DB-MIG-011	B	add "Backup trước migrate" item to PR template + deploy runbook step
DB-SEARCH-003	D	no search/vector index feature; all queries RLS-filtered (consistent with prior search waivers)
DB-SEC-002	B	app roles non-super/non-owner/no BYPASSRLS tested (harness.db.test.ts); add separate MIGRATION_DATABASE_URL
DB-SEC-003	B	add pg_hba hostssl+scram, sslmode=verify-full in config + reject sslmode=disable test
DB-SEC-004	B	gitleaks OK; add password rotation runbook; confirm log_statement≠all
DB-TX-002	B	retry 40001/40P01 max 3 (pipeline/command.ts) but no backoff/jitter
DB-TX-003	B	idle_in_transaction set (bootstrap-roles.sql) but files.ts does S3 put inside tx
WF-CI-001	A	.github/rulesets/main.json (6 required incl. 4 named), ci:protection-guard, ci:quality (item text says 4/3 — inconsistent)
WF-CI-004	A	.github/workflows/ci.yml (PR title via env:, no pull_request_target/workflow_run)
WF-REVIEW-001	B	quality required; replace framework PR template with product one incl. "CI xanh"
WF-REVIEW-002	B	add pr-policy job checking required PR body sections
WF-REVIEW-005	A	.github/rulesets/main.json (required_review_thread_resolution: true)
WF-REVIEW-007	C	needs human code owner + require_code_owner_review (repo setting, second person)
WF-DOC-001	B	PR template docs item + pr-policy warning
WF-DOC-002	B	add link check job (check-links.py/lychee)
WF-DOC-008	B	write docs/ops/RUNBOOK.md with last_drilled fields + lint (real drills later)
WF-ENV-006	C	no staging/prod environments yet (VPS purchase/deploy pipeline)
WF-ENV-008	C	GitHub environment production with required reviewers = repo settings + human
WF-ENV-010	B	add standalone synthetic seed script (reuse e2e/server.ts seed); staging scan later
WF-ENV-012	C	prod config change audit requires production environment
WF-GIT-001	C	ruleset not active until owner imports it
WF-GIT-002	C	file exists; GET rules API check needs owner to import ruleset
WF-GIT-010	A	.gitignore, .github/workflows/secret-scan.yml (fetch-depth 0), ci:gitleaks
WF-REL-001	B	add release-please/changesets workflow
WF-REL-003	B	add tag ruleset JSON + release workflow with checksums; first release at G7
WF-REL-004	C	rollback plan must be drilled on staging/prod before first launch
WF-REL-007	C	post-deploy smoke + watch window need real deploy
WF-SDD-001	B	specs use table "Trạng thái", no frontmatter status/approved_by/approved_at; SPEC-pwa Draft
WF-SDD-002	B	scenarios are S-NNN not AC-xx; add spec lint (≥1 AC, ≥1 error case)
WF-SDD-003	B	add script mapping spec IDs → test names (100% coverage)
WF-TEAM-003	B	add issue template DoR checklist (scripts/check-blocking-questions.py covers [chặn])
WF-TEAM-004	B	add DoD-with-evidence section to product PR template
WF-TEAM-007	C	needs ≥2 humans; ruleset required_approving_review_count is 0
LOOP-CTX-001	A	.claude/hooks/session-start.sh (4 sections, 8 KB cap), .claude/settings.json
LOOP-CTX-002	B	process: next `loop init --max-iterations/--hours` (state.json gitignored, absent here)
LOOP-CTX-006	A	PROGRESS.md, docs/autopilot/archive/PLAN-dot-2.md, docs/specs, docs/adr
LOOP-CTX-017	A	.claude/settings.json (PreCompact), .claude/hooks/pre-compact.sh
LOOP-FB-003	A	docs/xtemplates-feedback (scanned by ci:gitleaks), .github/workflows/secret-scan.yml
LOOP-DESIGN-001	B	caps recorded in docs/autopilot/archive/PLAN-dot-2.md; new PLAN + state.json at next loop init
LOOP-DESIGN-003	B	evidence lives in gitignored .autopilot/ (absent here); satisfied per task at next loop record
LOOP-ORCH-004	B	same: .autopilot/evidence per ticked task at next run
LOOP-CI-001	A	.claude/hooks/guard.py (asks on biome/tsconfig/vitest/playwright configs), .claude/hooks/pre-edit-guard.sh; grep no .skip/.only
LOOP-STOP-001	B	deny rules exist (guard.py, settings.json); add in-repo hook test for "ls; rm -rf /" and push --force
LOOP-STOP-003	A	.claude/hooks/guard.py (MIGRATION_RE, .github/workflows ask), .claude/hooks/pre-edit-guard.sh
LOOP-STOP-005	C	needs risk labels + required human review enforced (ruleset/second person)
SEC-WEB-001	B	runtime SQL parametrized (sql.raw only in migrations/testkit); add SAST job
SEC-WEB-004	A	no unescaped sinks; biome.json noDangerouslySetInnerHtml (recommended); React escape; ci:quality
SEC-WEB-008	D	server never fetches user-supplied URLs (no webhooks-out/URL import/avatar)
SEC-INFRA-001	A	packages/db/sql/bootstrap-roles.sql (app_runtime/app_worker), deploy/s3.json.example (bucket-scoped identity)
SEC-INFRA-002	A	deploy/compose.yaml (backend internal network, DB/S3 no published ports)
SEC-INFRA-003	C	host firewall/SSH exposure on VPS not in repo; needs provisioned server
SEC-INFRA-010	A	deploy/compose.yaml (postgres password secret, no admin UIs/metrics exposed)
SEC-LOG-001	B	logger.security() exists but never called; emit login/403/role-change/export events + docs/security/security-events.md
SEC-LOG-002	B	define security event schema (actor,target,outcome,ip,ua,trace) + test
SEC-LOG-006	C	needs off-host central log store + NTP on VPS
SEC-SECRET-001	A	.github/workflows/secret-scan.yml (gitleaks, fetch-depth 0), .gitleaksignore, ci:gitleaks
SEC-SECRET-005	C	production secret store on VPS (vault/sops/docker secrets) chosen/provisioned by owner
SEC-SECRET-007	A	packages/app/src/logging/logger.ts, packages/app/src/logging/logger.test.ts, packages/app/src/config/schema.test.ts, ci:quality
SEC-SECRET-011	B	add "Lộ bí mật" runbook section with revoke commands per key type
SEC-TM-001	B	move/link to docs/THREAT-MODEL.md + add updated frontmatter + CI date check vs ADRs
SEC-TM-003	B	text DFD exists (THREAT-MODEL §2); add backup repo (pgBackRest off-site) and SMTP explicitly / Mermaid
SEC-TM-005	B	rows have Mức but no decision (mitigate/accept); add column
SEC-TM-006	B	link Cao rows to checklist IDs/tests that are ticked
QA-COV-001	B	add vitest coverage (v8, branches) + upload artifact
QA-COV-002	B	add coverage.thresholds baseline (lines, branches) ratchet
QA-COV-004	B	add expect-expect lint/check
QA-COV-008	A	.claude/hooks/guard.py (vitest.config.*/biome/tsconfig gate files → ask), .claude/hooks/pre-edit-guard.sh
QA-E2E-001	A	apps/web/e2e/smoke.spec.ts, apps/web/e2e/rental.spec.ts, .github/rulesets/main.json (e2e required), ci:e2e (no @smoke tag)
QA-E2E-005	B	playwright.config.ts: add forbidOnly, retries CI 2, trace on-first-retry
QA-INT-006	B	add api1-bola/api5-bfla tagged HTTP tests per operation
QA-INT-007	B	contract-breaking check (oasdiff) after OpenAPI exists
QA-PERF-002	B	add k6 script with p95/error thresholds + nightly job (local server ok)
QA-PERF-006	B	GO-NO-GO.md perf section with 5 fields (at G7)
QA-PERF-007	B	k6 BASE_URL from env + CI deny production domain
QA-STATIC-005	B	enable Biome noConsole (logger exempt); gitleaks already
QA-DATA-001	B	add PROJECT.md "Dữ liệu test" ban sentence + large-file/PII scan script
QA-DATA-002	B	emails use example.com/.test; phone fixtures look real (0912345678…) — doc allowed numbers + CI scan
QA-DATA-007	D	no anonymized production copies used (synthetic seed only)
QA-STRAT-002	A	.github/rulesets/main.json (quality, e2e required), ci:quality (no continue-on-error per xt.py ci-check)
QA-STRAT-005	B	add CI/PR-policy check that fix: PRs change a test
QA-STRAT-008	B	add forbidOnly + lint/grep no .only/.skip without ticket in CI
OPS-DR-003	C	3-2-1 needs second backup system/provider account
OPS-DR-004	C	backup cipher configured (pgbackrest.conf.example); key escrow is owner/human
OPS-DR-007	C	delete-permission separation on real offsite storage (IAM of provider)
OPS-DR-008	C	restore runbook drill by non-author person
OPS-COST-001	D	self-hosted fixed-price VPS, no metered cloud/AI spend
OPS-COST-004	D	no metered/paid workloads (no AI/paid API); job retries bounded
OPS-COST-005	D	single VPS, no autoscaling
OPS-DEPLOY-001	C	needs image registry + staging/prod deploy pipeline
OPS-DEPLOY-002	C	rollback drill on prod-like env with timing
OPS-DEPLOY-003	B	add migration lint (DROP/RENAME needs contract flag) + N-1 test
OPS-DEPLOY-004	C	post-deploy smoke on real URL
OPS-IR-001	B	write docs/ops/INCIDENT-RESPONSE.md SEV1–4 with project examples
OPS-IR-004	B	runbook with fixed IR order
OPS-IR-006	B	runbook "Trước khi chạy lệnh lên dữ liệu" section
OPS-IR-010	B	runbook security-incident branch (evidence, rotate, notify); legal contact TBD
OPS-IAC-001	C	VPS/DNS provisioning needs real provider account (compose is partial IaC)
OPS-IAC-006	D	no Terraform/cloud IaC plan; compose on single VPS
OPS-MAINT-001	B	dependabot: add npm + docker ecosystems, groups, limits
OPS-MAINT-003	B	add scripts/eol-check against endoflife.date + weekly job
OPS-MAINT-004	B	weekly dep scan exists; add image/SBOM scan + docs/ops/VULN-SLA.md
OPS-MAINT-005	B	add major-upgrade PR template + label rule
OPS-OBS-001	B	add OTel Collector config (filelog, resource, unparsed label) under deploy/ + test
OPS-OBS-003	B	add http.server.request.duration histogram (OTel) + cardinality check
OPS-OBS-006	B	/api/health is static; add /healthz + /readyz (DB check, 503) + tests
OPS-OBS-008	B	collector redaction processor config + test
OPS-SLO-001	B	write docs/ops/SLO.md with SLI queries (+ schema validate)
OPS-SLO-004	B	alert rules with multi-window burn rate in repo
OPS-SLO-005	B	alert rule lint (runbook_url, severity)
OPS-SLO-006	C	alert fire drills need running monitoring stack
CMP-AI-006	D	no automated decisions/AI scoring affecting users
CMP-RIGHTS-001	B	add append-only consents table + export by subject (legal basis choice needs legal review)
CMP-RIGHTS-003	D	no tracking/analytics scripts (CSP connect-src 'self')
CMP-RIGHTS-004	B	implement consent withdrawal path (depends on CMP-RIGHTS-001)
CMP-RIGHTS-007	B	implement self-service erasure w/ re-auth, keep accounting records with reason + test
CMP-INTL-002	B	data map with legal_basis per processing + lint (legal sign-off later)
CMP-INTL-005	D	VN-only market; no EU/UK data subjects targeted
CMP-INTL-006	B	docs/ops/runbooks/data-breach.md with deadline table + templates (annual drill human)
CMP-INTL-007	B	configurable dsar_days (VN NĐ 356) + overdue metric
CMP-LIC-001	B	add LICENSE + generated THIRD_PARTY_NOTICES from SBOM in CI
CMP-LIC-002	A	scripts/check-licenses.mjs (SPDX allowlist, unknown/AGPL fail), scripts/check-licenses.test.mjs, ci:dep-audit, ci:quality
CMP-LIC-003	B	generate CycloneDX SBOM per build (cdxgen/syft) as artifact
CMP-LIC-004	A	scripts/check-licenses.mjs (non-allowlisted incl. UNKNOWN/BSL/SSPL fail), ci:dep-audit
CMP-PRIV-001	B	add docs/privacy/data-map.yaml + CI script vs migration columns
CMP-PRIV-005	B	account deletion across DB/S3 (+ processors) + E2E per-store check
CMP-PRIV-008	A	packages/app/src/logging/logger.ts (mask email/phone/CCCD), packages/app/src/logging/logger.test.ts, ci:quality
CMP-PRIV-010	D	no LLM/analytics/processors receiving PII beyond self-hosted stack
CMP-AUDIT-002	B	audit_events append-only exists; add ip/ua/result/reason, login/role/export events, retention policy
CMP-AUDIT-003	B	create docs/privacy/ (ROPA draft, CHANGELOG) — legal content needs human review
CMP-AUDIT-007	B	add docs/privacy/processors.md + vendors.yaml (SMTP relay, VPS, backup host)
CMP-AUDIT-010	C	incident register + annual drill minutes require people/real incidents
CMP-VN-001	B	consent capture per purpose + consents table + test (purposes need legal input)
CMP-VN-004	B	data map region/processor_country + script (expected VN-only)
CMP-VN-006	B	data-breach runbook (72h, Mẫu 08) — tabletop drill by humans later
CMP-VN-007	B	DSAR endpoints/UI with SLA measurement + E2E
PM-REQ-007	B	R-001…R-005 unique, but Kiểm regex matches "ADR-0001" → R-000 dup; reword or fix check (framework feedback)
PM-REQ-019	B	PROJECT.md §10 still has open "[chặn F-004]" items; close with D-NNN/owner answer
PM-HANDOVER-002	B	missing README.md, RUNBOOK.md, risk register, accounts list
PM-HANDOVER-004	C	account/secret transfer via platform needs humans
PM-HANDOVER-005	C	offboarding of real people/accounts
PM-HANDOVER-009	C	domain/cert/VPS renewals list needs purchased services (none yet)
PM-METRIC-003	D	no in-app analytics/event tracking (metrics via observation)
PM-METRIC-004	D	no analytics SDK/cookies
PM-METRIC-005	D	no analytics events
PM-METRIC-006	D	no analytics data store
PM-PRIO-003	C	walking skeleton deploy/smoke needs VPS/staging (CI part exists)
PM-PRIO-004	B	add SCOPE.md + docs(scope) commit convention
PM-RISK-001	B	add RK-NNN risk register (PROJECT §8 references R06/R08/R11 without table)
PM-RISK-003	B	tag top risk in next PLAN first slice
PM-RISK-006	B	add dependency vetting table (license, EOL, telemetry, exit) in docs/RISKS.md
PM-RISK-007	C	legal list exists [T]; DPIA must be prepared/approved by legal (PROJECT §6)
PM-SPEC-001	B	SPEC-pwa still Draft; map F-NNN→spec all Approved (main session self-approves per AGENTS §5)
PM-SPEC-004	B	add script S-NNN in specs ↔ test names coverage
PM-SPEC-020	B	docs/autopilot/DECISIONS.md is untracked; commit and reference D-NNN in each closed open question
XC-DX-001	B	README with ≤3 commands + onboarding-smoke CI job
XC-DX-002	B	xt.yaml lacks dev/migrate keys; add
XC-DX-003	B	add .nvmrc; CI uses node-version-file (now hard-coded 24.22.0)
XC-DX-006	B	add auto-installed fast pre-commit hook
XC-DOCAI-001	A	AGENTS.md (overview, commands via xt.yaml, rules, stop points)
XC-DOCAI-003	A	xt.yaml, AGENTS.md ("Không suy diễn lệnh từ văn xuôi"), .xtemplates/scripts/dev-task.sh, ci:quality
XC-DOCAI-004	B	AGENTS.md has trust + stop points; add sentence "hướng dẫn này không thay cho hook/permission"
XC-DOCAI-005	B	no secrets/curl|sh; add CODEOWNERS lines for AGENTS.md/CLAUDE.md/.claude/**
XC-I18N-001	B	UI strings hard-coded in JSX; extract to messages/vi.json + no-literal check
XC-I18N-003	B	format.ts builds dates/"đ" by hand; use Intl.DateTimeFormat/NumberFormat currency + tests
XC-I18N-005	B	NFC at boundary + accent-insensitive search where spec requires
XC-I18N-009	B	after message files exist: CI key/ICU validation
XC-OSS-001	D	no public OSS release decided (owner asked to waive, PROGRESS)
XC-OSS-004	B	SECURITY.md + /.well-known/security.txt route for public SaaS (PVR toggle = repo setting)
XC-OSS-005	D	private repo, no fork contributions
XC-OSS-007	D	no public package/release publishing (owner asked to waive)
XC-PERF-003	B	add size-limit/lighthouserc/k6 thresholds files + CI
XC-PERF-004	B	k6/bench with p95/p99 thresholds
XC-PERF-006	B	list queries lack enforced limit/max; add pagination + 10^6 rejection test; plus I/O timeouts
XC-GREEN-001	B	add docs/perf/baseline-*.json (page weight, requests) from E2E/Lighthouse
XC-GREEN-002	B	budgets for bundle/image size/CI time + checks
XC-GREEN-005	B	add refactor PR template before/after table
XC-GREEN-007	B	artifact retention 7d, pgBackRest retention exist; add cleanup jobs (commands/outbox/import rows) + log rotation
XC-UNITS-001	B	timestamptz everywhere; add schema lint + API rejection test for offset-less datetime (webhook already requires offset)
XC-UNITS-005	B	bigint+currency OK; ADR for numeric(18,4) unit_price; lint ban Number(/parseFloat in money module
XC-UNITS-009	B	add unit-suffix lint for numeric cols + grep *1000 outside units module
PRF-WEB-001	B	add ADR on render strategy per route group (all dynamic + no-store today)
PRF-WEB-002	A	apps/web/next.config.ts (no ignoreBuildErrors/ignoreDuringBuilds), xt.yaml (build+typecheck+lint), ci:quality
PRF-WEB-004	A	packages/app/src/http/command-route.db.test.ts (401/404), packages/app/src/http/security.test.ts + apps/web/e2e/smoke.spec.ts (Origin 403), packages/app/src/files/files.db.test.ts, ci:quality, ci:e2e
PRF-WEB-005	B	Lighthouse CI with assertions as required check
PRF-WEB-006	B	add desktop project; axe already filters critical/serious (a11y.ts)
PRF-WEB-007	B	CSP/nosniff/referrer/permissions/frame-ancestors set (proxy.ts), HSTS only in Caddyfile; add header assertion test
PRF-WEB-008	C	needs running error-tracking service (self-host GlitchTip) to upload source maps
PRF-WEB-009	C	per-PR preview deployments need hosting infra
PRF-WEB-010	B	add .nvmrc + node-version-file in workflows
IND-SAAS-001	B	RLS/no-BYPASSRLS/isolation tested; add lint: public table without organization_id → fail
IND-SAAS-002	A	packages/app/src/http/command-route.db.test.ts (non-member org → 404), packages/app/src/access/auth.db.test.ts, apps/web/e2e/smoke.spec.ts (forged org cookie), ci:quality
IND-SAAS-004	B	DB-level suite auto-covers tables; add route-driven cross-tenant suite (new route w/o test → fail)
IND-SAAS-006	B	implement tenant soft-delete, export, purge job + certificate template
IND-SAAS-007	B	implement self-service export (JSON/CSV + files) + format doc
IND-SAAS-008	B	per-tenant quotas/rate limits + fair-share worker config
IND-SAAS-009	B	tenant-admin audit view/export; impersonation with reason/TTL (TM-12)
IND-SAAS-010	C	DPA + sub-processor list need legal
IND-SAAS-011	C	VN data residency requires buying VN-hosted VPS/backup (owner)
IND-SAAS-013	C	published SLO per plan + status page need production
IND-SAAS-014	C	migration rehearsal on production copy
IND-SAAS-015	C	per-tenant restore drills on real infra, published RPO/RTO
IND-FIN-001	B	bigint money + money tests OK; add lint ban Number(/float in money module, *_minor naming or ADR, 10.001đ test
IND-FIN-006	B	recon breaks exist; add scheduled daily recon job + recon_breaks_open metric + balance=Σpostings test
IND-FIN-007	D	no card payments; VietQR transfer/cash only (PROJECT.md §6)
IND-FIN-008	D	product initiates no payments (TT 50/17/2024 → banks/wallets); MFA for money roles; owner to confirm
IND-FIN-011	C	≥10-year WORM retention store + NTP on production infra
```

**Mục chưa chắc, phiên chính nên xem lại trước khi tick:**
- **Các mục D cần chủ dự án xác nhận miễn:** XC-OSS-001, XC-OSS-007 và IND-FIN-008 đã được hỏi chủ dự án (theo PROGRESS); PM-METRIC-003…006 chỉ đúng khi không làm analytics trong app.
- **Các mục A giáp ranh, còn thiếu phần kiểm phụ:**
  - BASE-ERR-007 và SEC-SECRET-007: chưa có bước gitleaks quét log mẫu của CI; giá trị bị che thành `***` chứ không phải `[REDACTED]`.
  - QA-E2E-001: chưa có tag `@smoke`.
  - WF-CI-001: ruleset đòi 6 context chứ không phải đúng 4.
  - FE-STATE-008: chưa có `docs/CLIENT-STORAGE.md`.
