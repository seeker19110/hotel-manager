# Image web (Next.js) — build từ GỐC repo: `docker build -f deploy/web.Dockerfile -t hotel-manager-web .`
# Đã build/quét cục bộ 2026-11-01 bằng dữ liệu giả; bằng chứng docs/ops/evidence/supply-chain-2026-11-01.json.
# Kiểm startup/PWA/shutdown ở docs/ops/evidence/local-images-2026-11-01.json; chưa triển khai production.
# Base: node 24.22.2 (khớp .nvmrc), Debian trixie slim. Digest = index đa kiến trúc, kiểm SHA-256 manifest qua mirror.gcr.io
# và kéo/chạy image 2026-11-01 (D-139).
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS base
WORKDIR /app
# D-140: Corepack xác minh/cài đúng pnpm đã ghim; bỏ npm khỏi base dùng chung cho build và runtime.
# Không giữ các gói npm CLI có lỗ hổng trong bất kỳ stage ứng dụng nào; CI quét chính stage base này.
RUN corepack prepare pnpm@12.16.1 --activate \
 && corepack enable pnpm \
 && pnpm --version \
 && test "$(pnpm --version)" = "12.16.1" \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# ── build: cài đủ phụ thuộc (kể cả dev: typescript, esbuild) rồi `next build`. Build không cần biến môi trường runtime.
FROM base AS build
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

# ── runtime: Next standalone đã trace cả monorepo (D-144), không copy cây source/node_modules của builder.
# public và .next/static không được Next copy tự động; route Serwist force-static nằm trong .next/server được trace.
# Nguồn: https://nextjs.org/docs/app/api-reference/config/next-config-js/output
FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# Mã và node_modules do root sở hữu (user `node` chỉ đọc): RCE trong ứng dụng không sửa được mã/phụ thuộc. Chỉ `.next/cache` ghi được.
COPY --from=build /app/apps/web/.next/standalone /app
COPY --from=build /app/apps/web/public /app/apps/web/public
COPY --from=build /app/apps/web/.next/static /app/apps/web/.next/static
# Giữ văn bản giấy phép và ghi công khi chỉ phân phối closure runtime (CMP-LIC-001).
COPY --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.md /app/
# Không dùng npm lúc chạy (CMD gọi thẳng node): xoá npm đi kèm image nền để runtime không mang theo phụ thuộc của npm
# D-140: base đã xoá npm; giữ bước phòng vệ ở runtime khi đổi base/copy stage trong tương lai.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app/apps/web
RUN mkdir -p .next/cache && chown -R node:node .next/cache
WORKDIR /app
USER node
EXPOSE 3000
# Không có bí mật trong image: DATABASE_URL, BETTER_AUTH_SECRET, S3_*, HM_PII_KEYS… chỉ nạp qua môi trường khi chạy
# (schema: packages/app/src/config/schema.ts). Web dùng danh tính S3 và vai trò CSDL RIÊNG của web (deploy/README.md).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Node là PID 1 và tự xử lý SIGTERM; đặt `stop_grace_period` ≥ 40 giây ở compose.
CMD ["node", "apps/web/server.js"]
