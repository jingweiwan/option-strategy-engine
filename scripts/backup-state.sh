#!/usr/bin/env bash
#
# Back up the engine's IRREPLACEABLE state.
#
# Why this exists: on 2026-08 a server process was killed mid-write, the
# snapshot book was truncated, and the next scan overwrote 90 days / 5,695 rows
# / 1,095 settled outcomes with a fresh empty book. cache/ is gitignored, so
# there was no remote copy and nothing to restore. That data cannot be
# regenerated — settled outcomes are real elapsed time.
#
# Two tiers, because the data has two shapes:
#   1. VERSIONED (small, mutates in place) — the learning book, the RH bridge
#      files and the IV history are rewritten on every scan, so a point-in-time
#      history matters. Tarred daily, 30 copies kept.
#   2. MIRROR (large, append-only) — archived option chains are written once per
#      (day, symbol) and never modified, so a plain mirror is enough and a
#      versioned copy would just multiply 388MB.
#
# Usage:  ./scripts/backup-state.sh
# Config: OSE_BACKUP_DIR   destination root (default ~/OSE-Backups)
#         OSE_KEEP_DAYS    versioned archives to keep (default 30)
#
# Point OSE_BACKUP_DIR at a synced folder (iCloud/Dropbox/OneDrive) to get an
# off-machine copy. NOTE: rh-positions.json / rh-strategy-pnl.json contain the
# full portfolio and net worth — keep the destination private, never a repo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$REPO_ROOT/server"
DEST="${OSE_BACKUP_DIR:-$HOME/OSE-Backups}"
KEEP="${OSE_KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -d "$SERVER/cache" ]]; then
  echo "[backup] FATAL: $SERVER/cache not found — wrong repo root?" >&2
  exit 1
fi

mkdir -p "$DEST/versioned" "$DEST/chains"

# --- Health check first: a backup is only useful if you know what it contains.
BOOK="$SERVER/cache/recommendations/snapshots.json"
book_status="missing"
book_rows=0
if [[ -f "$BOOK" ]]; then
  if book_rows=$(node -e '
      const a = require(process.argv[1]);
      if (!Array.isArray(a)) { console.error("not-an-array"); process.exit(2) }
      process.stdout.write(String(a.length))
    ' "$BOOK" 2>/dev/null); then
    book_status="ok"
  else
    book_status="CORRUPT"
    book_rows=0
  fi
fi

# --- Tier 1: versioned tarball of the small, mutating state.
ARCHIVE="$DEST/versioned/ose-state-$STAMP.tar.gz"
tar -czf "$ARCHIVE" \
  -C "$SERVER" \
  cache/recommendations \
  $( [[ -f "$SERVER/cache/rh-positions.json" ]]   && echo cache/rh-positions.json ) \
  $( [[ -f "$SERVER/cache/rh-strategy-pnl.json" ]] && echo cache/rh-strategy-pnl.json ) \
  $( [[ -f "$SERVER/data/iv-history.json" ]]      && echo data/iv-history.json ) \
  2>/dev/null

# --- Retention: keep the newest $KEEP archives.
mapfile -t stale < <(ls -1t "$DEST/versioned"/ose-state-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) || true)
for f in "${stale[@]:-}"; do [[ -n "$f" ]] && rm -f "$f"; done

# --- Tier 2: mirror the append-only chain archive (incremental).
chains_note="skipped (no data/chains)"
if [[ -d "$SERVER/data/chains" ]]; then
  rsync -a --delete "$SERVER/data/chains/" "$DEST/chains/"
  chains_note="mirrored $(du -sh "$DEST/chains" | cut -f1)"
fi

echo "[backup] $STAMP -> $DEST"
echo "[backup]   snapshot book : $book_status ($book_rows rows)"
echo "[backup]   versioned     : $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1)), keeping $KEEP"
echo "[backup]   chains        : $chains_note"

# Exit nonzero on a corrupt book so cron/launchd surfaces it instead of the
# failure sitting silent — the whole point of this script.
if [[ "$book_status" == "CORRUPT" ]]; then
  echo "[backup] WARNING: snapshots.json did not parse — archived anyway as evidence." >&2
  exit 2
fi
