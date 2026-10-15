# Postgres 17 + pgBackRest cho VPS (ADR-0002). Base ghim digest (tra Docker Hub 2026-10-15); pgBackRest ≥ 2.59.3 (bản vá mã hoá)
# lấy từ kho PGDG có sẵn trong image chính thức.
FROM postgres:17.11-trixie@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3
RUN apt-get update \
 && apt-get install -y --no-install-recommends "pgbackrest=2.59.3-*" \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 0750 /var/log/pgbackrest /var/spool/pgbackrest /tmp/pgbackrest
