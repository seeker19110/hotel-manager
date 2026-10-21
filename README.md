# Hotel Manager

SaaS web/PWA giúp chủ trọ, nhà nghỉ, khách sạn nhỏ ở Việt Nam quản lý phòng, hợp đồng, kỳ thu, cọc, công nợ và lưu trú ngắn hạn
**đúng tiền, đúng phòng**. Trạng thái: pre-release `0.1.0`, chưa có môi trường production, chưa dùng dữ liệu thật
(xem [`PROGRESS.md`](PROGRESS.md) và [`CHANGELOG.md`](CHANGELOG.md)).

- Vấn đề, người dùng, phạm vi MVP, chỉ số: [`PROJECT.md`](PROJECT.md)
- Kiến trúc: [ADR-0001](docs/adr/0001-modular-monolith-typescript-postgres.md) (modular monolith TypeScript + Postgres),
  [ADR-0002](docs/adr/0002-self-host-auth-storage-backup.md) (tự host đăng nhập, file, sao lưu),
  [ADR-0004](docs/adr/0004-chien-luoc-render.md) (chiến lược render)

## Bắt đầu nhanh (3 lệnh, từ clone sạch đến test xanh)

```bash
bash scripts/dev-env-setup.sh && export PATH="$HOME/.local/bin:$PATH"
pnpm install --frozen-lockfile
pnpm test
```

Lệnh 1 cài PostgreSQL 17 + pgBackRest, SeaweedFS, Node và pnpm (Ubuntu 24.04 x86_64, cần root hoặc sudo; máy đã có đủ công cụ
đúng phiên bản thì bỏ qua) vào `~/.local/bin` rồi đặt thư mục đó lên đầu `PATH` của phiên shell hiện tại (máy mới chưa có trong `PATH`;
muốn giữ cho các phiên sau thì thêm dòng `export` vào `~/.profile`); lệnh 2 cài phụ thuộc và tự cài hook git `pre-commit` (xem [Hook git](#hook-git)). Không bước tay nào khác,
không cần bí mật. CI chạy đúng khối lệnh này, nguyên văn, trong một shell ở job `onboarding-smoke` trên runner mới và ghi thời gian vào tóm tắt job.

## Yêu cầu môi trường

| Thành phần | Phiên bản | Ghi chú |
|---|---|---|
| Node.js | `24.22.0` (`.nvmrc`; `engines`: `>=24.11.0 <25`) | trùng `node-version` của CI |
| pnpm | `12.11.2` (`packageManager` trong `package.json`) | bật bằng `corepack enable` hoặc dùng bản cài sẵn |
| PostgreSQL | 17 + pgBackRest | test CSDL dùng cluster tạm hoặc `TEST_DATABASE_URL` |
| SeaweedFS | 4.48 | kho file riêng tư tương thích S3 (ADR-0002); test file tự dựng bản tạm |

Máy Ubuntu 24.04 x86_64 không có Docker: `bash scripts/dev-env-setup.sh` cài PostgreSQL 17, pgBackRest, SeaweedFS, Node, pnpm
(kiểm SHA-256; cần root hoặc sudo cho apt; chạy lại an toàn). Máy khác: tự cài đúng phiên bản trên.

## Cài đặt

Lệnh chuẩn nằm ở [`xt.yaml`](xt.yaml) (một nguồn duy nhất, hook và CI cùng đọc):

```bash
# Môi trường từ máy trống (cài Postgres/SeaweedFS/Node/pnpm rồi cài phụ thuộc)
bash scripts/dev-env-setup.sh && pnpm install --frozen-lockfile
# Đã có đủ công cụ: chỉ cài phụ thuộc theo lockfile
pnpm install --frozen-lockfile
```

## Chạy

- Cấu hình: sao `.env.example` thành `.env` (không commit) và thay giá trị giả; biến được kiểm bằng schema lúc khởi động
  (`packages/app/src/config/schema.ts`) — thiếu biến thì dừng ngay và nêu tên. Production bắt buộc đặt khoá PII
  (`HM_PII_KEYS`…) và máy quét `CLAMD_HOST`.
- **Dev một lệnh:** `pnpm dev:up` (thêm `--worker` để chạy cả worker). Lệnh dựng Postgres 17 bền ở `.dev/pg` (cổng
  `DEV_PG_PORT`, mặc định 54329), áp migration, seed dữ liệu giả **một lần**, chạy SeaweedFS bền ở `.dev/s3` (không có `weed` thì S3 giả trong bộ nhớ) và clamd giả rồi `next dev`
  ở `http://127.0.0.1:3000` (`DEV_PORT`). Tài khoản giả in ra khi khởi động; mã TOTP của chủ khách sạn giả: `pnpm dev:up --totp`;
  mã OTP người thuê ghi ở `.dev/outbox.jsonl`. Dừng Postgres: `pnpm dev:up --stop`; xoá sạch: `pnpm dev:up --reset`. Cần `scripts/dev-env-setup.sh` trước và `pnpm install`.
- Web (Next.js) chạy tay: `pnpm --filter @hm/web dev` với biến môi trường tự đặt và CSDL đã áp migration (`packages/db/src/migrations`).
- Chạy thử trọn luồng với dữ liệu giả: lệnh E2E bên dưới tự dựng Postgres tạm, seed, build và khởi động web.
- Worker (`apps/worker`): tiến trình chạy thật — `node apps/worker/src/index.ts` (Node 24; relay outbox, consumer pg-boss, job định kỳ; dừng êm khi nhận SIGTERM). Cần thêm `WORKER_DATABASE_URL` (vai trò `app_worker`); lịch và cách dừng ở [`docs/RUNBOOK.md`](docs/RUNBOOK.md) §8.
- Đóng gói: [`deploy/web.Dockerfile`](deploy/web.Dockerfile) và [`deploy/worker.Dockerfile`](deploy/worker.Dockerfile) (chưa build thật trên máy có Docker; compose chưa có service ứng dụng).

## Kiểm tra (cổng chất lượng)

```bash
# lint (gồm kiểm format, giấy phép phụ thuộc, workflow CI)
pnpm lint && pnpm lint:openapi && pnpm licenses:check && python3 .xtemplates/scripts/xt.py ci-check .github/workflows
# typecheck
pnpm typecheck
# test (Vitest: project unit + db; db dùng Postgres 17 thật)
pnpm test
# build
pnpm build
# e2e (Playwright, Chromium mobile)
pnpm --filter @hm/web exec playwright test
```

Chạy cả cổng trước khi commit: `.xtemplates/scripts/dev-task.sh gate` (build → typecheck → lint → test). Chỉ test CSDL:
`pnpm vitest run --project db <mẫu tên>`. Diễn tập sao lưu/khôi phục PITR (dữ liệu giả): `bash scripts/db-backup-restore-check.sh`.
Kiểm phụ thuộc có lỗ hổng: `pnpm audit --prod`.

## Cấu trúc thư mục

| Đường dẫn | Vai trò |
|---|---|
| `apps/web` | Next.js 16: giao diện (PWA), route handler HTTP, E2E Playwright |
| `apps/worker` | worker Node: outbox relay, consumer pg-boss, job định kỳ |
| `packages/domain` | quy tắc nghiệp vụ thuần (tiền, kỳ thu, giá, trạng thái), không I/O |
| `packages/app` | command/query: transaction, phân quyền, audit, outbox, idempotency |
| `packages/db` | Kysely, migration, RLS |
| `packages/testkit` | cluster Postgres/SeaweedFS tạm, factory dữ liệu giả cho test |
| `deploy/` | compose, Caddy, Dockerfile web/worker, mẫu pgBackRest/S3, rule Prometheus cho VPS (chưa triển khai) |
| `scripts/` | môi trường dev, kiểm giấy phép/image/ERD/blueprint, diễn tập sao lưu |
| `docs/` | spec, thiết kế, ADR, nghiên cứu, vận hành, quyền riêng tư |
| `.xtemplates/` | khung quy trình X-Templates (luật cho agent, công cụ `xt.py`) — không sửa tay |

## Tài liệu

- Quy tắc cho người và agent: [`AGENTS.md`](AGENTS.md) · trạng thái: [`PROGRESS.md`](PROGRESS.md) · kế hoạch: [`docs/autopilot/PLAN.md`](docs/autopilot/PLAN.md)
- Đặc tả: [`docs/specs/`](docs/specs) · thiết kế: [`docs/design/`](docs/design) (mô hình dữ liệu [`DOMAIN-MODEL.md`](docs/design/DOMAIN-MODEL.md),
  [`ERD.md`](docs/design/ERD.md), [`THREAT-MODEL.md`](docs/design/THREAT-MODEL.md)) · quyết định: [`docs/adr/`](docs/adr), [`docs/autopilot/DECISIONS.md`](docs/autopilot/DECISIONS.md)
- Vận hành: [`docs/RUNBOOK.md`](docs/RUNBOOK.md) · bí mật chỉ nạp qua môi trường, mẫu ở `.env.example`
- Hợp đồng API: [`docs/design/API-CONTRACT.md`](docs/design/API-CONTRACT.md) (quy ước) và `apps/web/openapi.json` (sinh bằng `pnpm openapi`) · route và chế độ render: [`docs/ROUTES.md`](docs/ROUTES.md) · miền ↔ thư mục: [`docs/architecture/domains.md`](docs/architecture/domains.md), retry/trạng thái: [`docs/architecture/resilience.md`](docs/architecture/resilience.md)
- Phạm vi và rủi ro: [`SCOPE.md`](SCOPE.md) · bàn giao: [`docs/handover/accounts.md`](docs/handover/accounts.md)
- Quyền riêng tư và rủi ro: [`docs/privacy/data-map.yaml`](docs/privacy/data-map.yaml) (sổ dữ liệu cá nhân, có test đối chiếu CSDL), [`docs/privacy/ROPA.md`](docs/privacy/ROPA.md), [`docs/privacy/processors.md`](docs/privacy/processors.md), [`docs/RISKS.md`](docs/RISKS.md)
- Ứng phó sự cố, runbook, SLO: [`docs/ops/INCIDENT-RESPONSE.md`](docs/ops/INCIDENT-RESPONSE.md), [`docs/ops/SLO.md`](docs/ops/SLO.md)

## Đóng góp

Một thay đổi nhỏ một commit (Conventional Commits, tiếng Việt), qua cổng ở trên; mẫu PR ở
[`.github/pull_request_template.md`](.github/pull_request_template.md). Không dùng dữ liệu thật ở dev/test.
Giấy phép mã nguồn và kênh báo lỗ hổng: chưa có (chờ chủ dự án quyết — `PROJECT.md` §10).

## Hook git

`pnpm install` tự cài hook `pre-commit` (script `prepare` → [`scripts/install-git-hooks.mjs`](scripts/install-git-hooks.mjs) ghi một stub vào
`.git/hooks/pre-commit`, logic ở [`.githooks/pre-commit`](.githooks/pre-commit)). Hook chỉ xét **file đã stage** nên chạy dưới 30 giây:
chặn file đang bị `.gitignore` (kể cả `git add -f`), rồi `biome check --staged`. Cổng đầy đủ (build, typecheck, lint, test) để CI và
`.xtemplates/scripts/dev-task.sh gate`. Đã có hook của công cụ khác thì script giữ nguyên và báo; cài lại tay: `node scripts/install-git-hooks.mjs`.
Mọi worktree của cùng repo dùng chung một stub `.git/hooks/pre-commit`; stub thoát 0 (không làm gì) nếu nhánh/worktree không có
`.githooks/pre-commit`. Nếu `core.hooksPath` đã được đặt (cấu hình repo, toàn cục hoặc hệ thống) hoặc thư mục hooks nằm ngoài `.git` của
repo thì script **không ghi gì** (tránh sửa hook dùng chung của bạn) và cảnh báo trên stderr (trạng thái `skip-hooks-path`): tự gọi
`.githooks/pre-commit` từ hook của bạn hoặc đặt `git config core.hooksPath .githooks` cho repo này.

## Phát hành

Số phiên bản (SemVer) do [release-please](release-please-config.json) sinh từ Conventional Commits trên `main`: workflow
[`release.yml`](.github/workflows/release.yml) mở/cập nhật một "Release PR" (đổi `version` + manifest). **Không sửa tay số phiên bản**
trong PR tính năng. Người merge Release PR → Release nháp → job `assets` đợi check `quality` của commit phát hành xanh, đính tarball
mã nguồn + `SHA256SUMS`, rồi công khai và tạo tag `vX.Y.Z`. Tag `v*` bất biến nhờ ruleset [`tags.json`](.github/rulesets/tags.json)
(chủ dự án import một lần ở Settings → Rules → Rulesets, cùng `main.json`). Ghi chú phát hành nằm ở nội dung Release; `CHANGELOG.md`
vẫn do người viết.

**Release PR và CI.** PR do `GITHUB_TOKEN` tạo không kích hoạt workflow khác, nên khi chưa có token riêng Release PR không có CI và
check bắt buộc (`quality`…) đứng "Expected — waiting". Khi chưa có token riêng: **người đóng rồi mở lại Release PR** (sự kiện do
người tạo kích hoạt CI) và đợi check xanh trước khi merge. Chủ dự án có thể cấp GitHub App hoặc PAT fine-grained (chỉ repo này;
**Contents: Read and write** + **Pull requests: Read and write**) làm secret `RELEASE_PLEASE_TOKEN`; workflow tự dùng nó nếu có (không
cần đổi mã) và Release PR chạy CI ngay. Job `release-please` đỏ với `Error adding to tree: <sha>` nghĩa là token đọc được repo nhưng
không ghi được (thiếu Contents: write) — sửa quyền token, hoặc xoá secret để quay về `GITHUB_TOKEN`, rồi chạy lại workflow `Release`.
