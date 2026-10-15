#!/usr/bin/env bash
# Diễn tập sao lưu/khôi phục PITR (PLAN T-012, ADR-0002, backlog T099) — chỉ dữ liệu giả, cluster tạm, xoá khi xong.
#   Postgres 17 + pgBackRest (repo cục bộ, mã hoá aes-256-cbc, khoá sinh ngẫu nhiên chỉ sống trong thư mục tạm):
#   lô 1 → full backup → lô 2 (chỉ có trong WAL) → điểm khôi phục → lô 3 (giả "ghi nhầm") → verify →
#   restore PITR về điểm khôi phục → so số dòng, Σ Nợ/Có, số policy RLS với ảnh chụp tại điểm đó.
# Dùng: bash scripts/db-backup-restore-check.sh   (cần: scripts/dev-env-setup.sh đã chạy; exit 0 = khôi phục đúng)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/17/bin}"
MIN_PGBACKREST="2.59.3" # bản vá bảo mật mã hoá (ADR-0002)
STANZA="hm"
DB="hm_backup_check"
TARGET="hm_t012_target"

log() { printf '[backup-check] %s\n' "$*"; }
die() {
  printf '[backup-check] ✗ %s\n' "$*" >&2
  exit 1
}

[ -x "$PG_BIN/initdb" ] || die "không có PostgreSQL 17 ở $PG_BIN — chạy scripts/dev-env-setup.sh"
command -v pgbackrest >/dev/null || die "không có pgbackrest — chạy scripts/dev-env-setup.sh"
command -v node >/dev/null || die "không có node — chạy scripts/dev-env-setup.sh --only node"
for bin in openssl python3; do command -v "$bin" >/dev/null || die "thiếu $bin"; done
ver="$(pgbackrest version | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1)"
[ "$(printf '%s\n%s\n' "$MIN_PGBACKREST" "$ver" | sort -V | head -n1)" = "$MIN_PGBACKREST" ] ||
  die "pgBackRest $ver < $MIN_PGBACKREST"

# initdb/pg_ctl/pgbackrest phải chạy bằng chủ thư mục dữ liệu: root → user postgres.
if [ "$(id -u)" = 0 ]; then
  as_pg() { runuser -u postgres -- "$@"; }
else
  as_pg() { "$@"; }
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/hm-pitr-XXXXXX")"
data="$work/data"
conf="$work/pgbackrest.conf"
running=0
cleanup() {
  if [ "$running" = 1 ]; then as_pg "$PG_BIN/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/repo" "$work/log" "$work/lock" "$work/spool" "$work/sock"
[ "$(id -u)" = 0 ] && chown -R postgres:postgres "$work"

port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
admin_url="postgres://postgres@127.0.0.1:${port}/postgres"
db_url="postgres://postgres@127.0.0.1:${port}/${DB}"
fixture() { node "$root/packages/testkit/src/backup-fixture.ts" "$@"; }
pgbr() { as_pg pgbackrest --config="$conf" --stanza="$STANZA" "$@"; }

# Khoá mã hoá repo: ngẫu nhiên mỗi lần chạy, chỉ nằm trong file 0600 của thư mục tạm (không log, không commit).
umask 077
cat >"$conf" <<EOF
[global]
repo1-path=$work/repo
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$(openssl rand -base64 48 | tr -d '\n')
repo1-retention-full=2
log-path=$work/log
lock-path=$work/lock
spool-path=$work/spool
log-level-console=warn
start-fast=y

[$STANZA]
pg1-path=$data
pg1-port=$port
pg1-socket-path=$work/sock
# Role superuser của cluster tạm (initdb -U postgres) — không phụ thuộc tên user hệ điều hành đang chạy (vd. runner của CI).
pg1-user=postgres
EOF
umask 022
[ "$(id -u)" = 0 ] && chown postgres:postgres "$conf"

log "initdb cluster tạm (cổng $port)"
as_pg "$PG_BIN/initdb" -D "$data" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
cat >>"$data/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = $port
unix_socket_directories = '$work/sock'
wal_level = replica
archive_mode = on
archive_command = 'pgbackrest --config=$conf --stanza=$STANZA archive-push %p'
max_wal_senders = 3
EOF
start_pg() {
  as_pg "$PG_BIN/pg_ctl" -D "$data" -l "$work/log/postgres.log" -w -t 120 start >/dev/null
  running=1
}
start_pg

log "chuẩn bị DB giả + migrate"
ids="$(fixture prepare "$admin_url" "$DB")"
org="$(printf '%s' "$ids" | python3 -c 'import sys,json; print(json.load(sys.stdin)["orgId"])')"
prop="$(printf '%s' "$ids" | python3 -c 'import sys,json; print(json.load(sys.stdin)["propertyId"])')"
person="$(printf '%s' "$ids" | python3 -c 'import sys,json; print(json.load(sys.stdin)["personId"])')"

pgbr stanza-create
pgbr check
fixture write "$db_url" "$org" "$prop" "$person" 40 >/dev/null
log "full backup (repo mã hoá)"
pgbr --type=full backup
fixture write "$db_url" "$org" "$prop" "$person" 25 >/dev/null # chỉ có trong WAL — PITR phải phát lại được

expected="$(fixture summary "$db_url")"
as_pg "$PG_BIN/psql" -h "$work/sock" -p "$port" -U postgres -d "$DB" -qAtc "select pg_create_restore_point('$TARGET')" >/dev/null
fixture write "$db_url" "$org" "$prop" "$person" 30 >/dev/null # "ghi nhầm" sau điểm khôi phục — phải biến mất
after="$(fixture summary "$db_url")"
[ "$expected" != "$after" ] || die "lô ghi sau điểm khôi phục không làm đổi dữ liệu — diễn tập vô nghĩa"
pgbr check # ép chuyển WAL và chờ lưu trữ xong

info="$(pgbr --output=json info)"
printf '%s' "$info" | python3 -c '
import sys, json
s = json.load(sys.stdin)[0]
assert s["cipher"] == "aes-256-cbc", "repo không mã hoá: %s" % s["cipher"]
assert any(b["type"] == "full" for b in s["backup"]), "không có full backup"
assert s["status"]["code"] == 0, s["status"]
' || die "pgbackrest info không đạt (mã hoá/full backup)"
log "verify repo"
pgbr verify

log "dừng cluster, restore PITR về điểm '$TARGET'"
as_pg "$PG_BIN/pg_ctl" -D "$data" -m fast -w stop >/dev/null
running=0
pgbr --delta --type=name --target="$TARGET" --target-action=promote restore
start_pg
for _ in $(seq 1 120); do
  r="$(as_pg "$PG_BIN/psql" -h "$work/sock" -p "$port" -U postgres -d postgres -qAtc 'select pg_is_in_recovery()')"
  [ "$r" = f ] && break
  sleep 1
done
[ "$r" = f ] || die "cluster vẫn đang recovery sau 120 giây"

restored="$(fixture summary "$db_url")"
log "kỳ vọng:   $expected"
log "khôi phục: $restored"
[ "$restored" = "$expected" ] || die "dữ liệu sau PITR khác ảnh chụp tại điểm khôi phục"
printf '%s' "$restored" | python3 -c '
import sys, json
s = json.load(sys.stdin)
assert s["sum_debit"] == s["sum_credit"], "sổ không cân sau khôi phục"
assert int(s["journal_entries"]) == 65, "kỳ vọng 65 bút toán (40 trong backup + 25 từ WAL), có %s" % s["journal_entries"]
assert int(s["rls_policies"]) > 0 and int(s["rls_forced_tables"]) > 0, "mất RLS sau khôi phục"
' || die "kiểm sau khôi phục không đạt"
log "✓ PITR đúng: 40 bút toán từ full backup + 25 phát lại từ WAL, 30 bút toán sau điểm khôi phục đã loại, sổ cân, RLS còn nguyên"
