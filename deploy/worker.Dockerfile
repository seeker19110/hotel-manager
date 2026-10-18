# Image worker (outbox relay, pg-boss, job định kỳ) — build từ GỐC repo: `docker build -f deploy/worker.Dockerfile -t hotel-manager-worker .`
# CHƯA build thật (máy dev không có Docker); test tĩnh `scripts/process-docs.test.mjs` kiểm: base ghim digest, USER không root,
# không bí mật trong image. Khi có Docker: build, chạy với CSDL giả, kiểm log `worker.started`, rồi bỏ dòng này.
# Base: node 24.22.0 (khớp .nvmrc), Debian trixie slim; digest tra 2026-10-16 qua mirror.gcr.io và public.ecr.aws.
FROM node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS base
WORKDIR /app

# ── deps: chỉ phụ thuộc production của worker và gói workspace nó dùng (@hm/app, @hm/db, @hm/domain). Không cần build:
# Node 24 chạy thẳng TypeScript (`node apps/worker/src/index.ts`, RUNBOOK §8); gói workspace nằm ngoài node_modules nên được phép.
FROM base AS deps
RUN npm install -g pnpm@12.11.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/app/package.json packages/app/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/testkit/package.json packages/testkit/
RUN pnpm install --frozen-lockfile --prod --filter "@hm/worker..."
COPY apps/worker apps/worker
COPY packages/app packages/app
COPY packages/db packages/db
COPY packages/domain packages/domain

# ── runtime: người dùng `node` (không root), không pnpm/npm trong lệnh chạy.
FROM base AS runtime
ENV NODE_ENV=production
# Mã và node_modules do root sở hữu (user `node` chỉ đọc); worker không ghi gì vào cây mã.
COPY --from=deps /app /app
# Không dùng npm lúc chạy (CMD gọi thẳng node): xoá npm đi kèm image nền để runtime không mang theo phụ thuộc của npm
# (undici, brace-expansion… — `.grype.yaml` chỉ bỏ qua chúng ở image nền, T-802). Build/deps vẫn dùng npm ở stage trước.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER node
# Không có bí mật trong image: DATABASE_URL, WORKER_DATABASE_URL, S3_*, SMTP_URL, HM_PII_KEYS… chỉ nạp qua môi trường khi chạy.
# Worker dùng vai trò CSDL `app_worker` và danh tính S3 RIÊNG của worker (deploy/README.md). Không mở cổng.
# SIGTERM ⇒ dừng êm (chờ job đang chạy tối đa 25 giây, RUNBOOK §8); đặt `stop_grace_period` ≥ 40 giây ở compose.
CMD ["node", "apps/worker/src/index.ts"]
