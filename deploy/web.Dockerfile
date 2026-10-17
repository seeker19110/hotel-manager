# Image web (Next.js) — build từ GỐC repo: `docker build -f deploy/web.Dockerfile -t hotel-manager-web .`
# CHƯA build thật (máy dev không có Docker); test tĩnh `scripts/process-docs.test.mjs` kiểm: base ghim digest, USER không root,
# không bí mật trong image. Khi có Docker: build, chạy `GET /api/health`, rồi bỏ dòng này.
# Base: node 24.22.0 (khớp .nvmrc), Debian trixie slim. Digest = index đa kiến trúc, tra 2026-10-16 qua mirror.gcr.io và
# public.ecr.aws (cùng kết quả; Docker Hub đang giới hạn tốc độ).
FROM node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS base
WORKDIR /app

# ── build: cài đủ phụ thuộc (kể cả dev: typescript, esbuild) rồi `next build`. Build không cần biến môi trường runtime.
FROM base AS build
RUN npm install -g pnpm@12.11.2
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/app/package.json packages/app/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/testkit/package.json packages/testkit/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @hm/web build

# ── runtime: chạy bằng người dùng `node` (không root). Giữ nguyên cây đã cài vì gói workspace xuất mã TypeScript nguồn và
# `next.config.ts` cần `typescript` lúc chạy; thu nhỏ (chỉ phụ thuộc production) là việc sau, cần kiểm bằng build thật.
FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
# Mã và node_modules do root sở hữu (user `node` chỉ đọc): RCE trong ứng dụng không sửa được mã/phụ thuộc. Chỉ `.next/cache` ghi được.
COPY --from=build /app /app
WORKDIR /app/apps/web
RUN mkdir -p .next/cache && chown -R node:node .next/cache
USER node
EXPOSE 3000
# Không có bí mật trong image: DATABASE_URL, BETTER_AUTH_SECRET, S3_*, HM_PII_KEYS… chỉ nạp qua môi trường khi chạy
# (schema: packages/app/src/config/schema.ts). Web dùng danh tính S3 và vai trò CSDL RIÊNG của web (deploy/README.md).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Node là PID 1 và tự xử lý SIGTERM; đặt `stop_grace_period` ≥ 40 giây ở compose.
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
