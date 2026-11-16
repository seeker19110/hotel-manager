# Postgres 17 + pgBackRest cho VPS (ADR-0002). Base ghim digest (tra Docker Hub 2026-11-16: `17.12-trixie` dựng 2026-11-15, vá các
# CVE High của postgresql-17 17.11); pgBackRest ≥ 2.59.3 (bản vá mã hoá) lấy từ kho PGDG có sẵn trong image chính thức.
# zlib1g: image chính thức còn `1.3.1-1+b1` (CVE-2026-76844, CVE-2026-85091) — ghim bản vá `+deb13u1` từ trixie-security
# cho tới khi base dựng lại có sẵn bản này.
FROM postgres:17.12-trixie@sha256:0d938e975177bef9f1f61f3f9dbcf2e0aa0a139568f66d3415ed8892eb97f6ac
RUN apt-get update \
 && apt-get install -y --no-install-recommends "pgbackrest=2.59.3-*" "zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1" \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 0750 /var/log/pgbackrest /var/spool/pgbackrest /tmp/pgbackrest
