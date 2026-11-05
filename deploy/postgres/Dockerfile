# Postgres 17 + pgBackRest cho VPS (ADR-0002). Base ghim digest (tra Docker Hub 2026-11-05: bản dựng lại có apt 3.0.4 vá CVE-2026-109518, D-157); pgBackRest ≥ 2.59.3 (bản vá mã hoá)
# lấy từ kho PGDG có sẵn trong image chính thức.
FROM postgres:17.11-trixie@sha256:748a18a54d3842d43bc156f0840d78029b8d349e0feca98c12b9c4ce3404a6b3
RUN apt-get update \
 && apt-get install -y --no-install-recommends "pgbackrest=2.59.3-*" \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 0750 /var/log/pgbackrest /var/spool/pgbackrest /tmp/pgbackrest
