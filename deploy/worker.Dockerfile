# Image worker (outbox relay, pg-boss, job định kỳ) — build từ GỐC repo: `docker build -f deploy/worker.Dockerfile -t hotel-manager-worker .`
# Đã build/quét cục bộ 2026-11-01 bằng dữ liệu giả trên digest base CŨ; bằng chứng docs/ops/evidence/supply-chain-2026-11-01.json.
# Digest base hiện tại (D-157) chưa có evidence cục bộ — bằng chứng quét là job CI `image-scan (node-base)` trên main.
# Kiểm startup/PWA/shutdown ở docs/ops/evidence/local-images-2026-11-01.json; chưa triển khai production.
# Base: node 24.22.2 (khớp .nvmrc), Debian trixie slim; digest kiểm SHA-256 manifest và kéo/chạy qua mirror.gcr.io 2026-11-01 (D-139); đổi digest 2026-11-05 lấy apt 3.0.4 (CVE-2026-109518, D-157).
FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS prepared
WORKDIR /app
# D-140: Corepack xác minh/cài đúng pnpm đã ghim; bỏ npm khỏi base dùng chung cho build và runtime.
# Không giữ các gói npm CLI có lỗ hổng trong bất kỳ stage ứng dụng nào; CI quét chính stage base này.
RUN corepack prepare pnpm@12.16.1 --activate \
 && corepack enable pnpm \
 && pnpm --version \
 && test "$(pnpm --version)" = "12.16.1" \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Gom filesystem đã chuẩn bị để bỏ cả bytes npm trong layer cũ, không chỉ thêm whiteout.
# Giữ nguyên Node/pnpm, OS, thư viện và metadata của image Node đã ghim; không nới ngân sách 285 MB.
FROM scratch AS base
COPY --from=prepared / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin NODE_VERSION=24.22.2 YARN_VERSION=1.22.22
WORKDIR /app
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node"]

# ── deps: chỉ phụ thuộc production của worker và gói workspace nó dùng (@hm/app, @hm/db, @hm/domain). Không cần build:
# Node 24 chạy thẳng TypeScript (`node apps/worker/src/index.ts`, RUNBOOK §8); gói workspace nằm ngoài node_modules nên được phép.
FROM base AS deps
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
# Giữ giấy phép dự án và ghi công phụ thuộc trong artifact phân phối (CMP-LIC-001).
COPY LICENSE THIRD_PARTY_NOTICES.md /app/
# Không dùng npm lúc chạy (CMD gọi thẳng node): xoá npm đi kèm image nền để runtime không mang theo phụ thuộc của npm
# D-140: base đã xoá npm; giữ bước phòng vệ ở runtime khi đổi base/copy stage trong tương lai.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER node
# Không có bí mật trong image: DATABASE_URL, WORKER_DATABASE_URL, S3_*, SMTP_URL, HM_PII_KEYS… chỉ nạp qua môi trường khi chạy.
# Worker dùng vai trò CSDL `app_worker` và danh tính S3 RIÊNG của worker (deploy/README.md). Không mở cổng.
# SIGTERM ⇒ dừng êm (chờ job đang chạy tối đa 25 giây, RUNBOOK §8); đặt `stop_grace_period` ≥ 40 giây ở compose.
CMD ["node", "apps/worker/src/index.ts"]
