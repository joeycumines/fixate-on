#!/usr/bin/env bash
# slot.sh — single-run lease for the E2E orchestrator.
#
# WHY THIS EXISTS. The harness runs campaigns against a live host in a shared
# work directory. Two concurrent runs corrupt each other's state, so neither
# run's result means anything. requires: "a concurrent second run SKIP-not-FAILs
# on slot/lease." This is the mechanism.
#
# LEASE SEMANTICS. One lease file per host type (v1, v2). The lease contains:
# - PID of the holding process
# - Timestamp of acquisition (epoch seconds)
# - Campaign name
# If the holding process dies without releasing, the lease is STALE after
# STALE_AFTER_SECONDS and can be stolen by the next run.
#
# Usage:
# source slot.sh
# acquire_lease "v1" "campaign-name" || { echo "SKIP: no lease"; exit 0; }
#... run campaigns...
# release_lease "v1"
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEASE_DIR="$HERE/slots"
mkdir -p "$LEASE_DIR" 2>/dev/null || true

STALE_AFTER_SECONDS=300

acquire_lease() {
  local host_type="$1"
  local campaign="${2:-unnamed}"
  local pid=$$
  local now
  now=$(date +%s)
  local lease="$LEASE_DIR/${host_type}.lock"

 # Try to steal a stale lease first
  if [ -f "$lease" ]; then
    local lease_pid
    lease_pid=$(head -1 "$lease" 2>/dev/null || echo "")
    local lease_ts
    lease_ts=$(sed -n '2p' "$lease" 2>/dev/null || echo "0")
    local age=$((now - lease_ts))

    if [ -n "$lease_pid" ] && ! kill -0 "$lease_pid" 2>/dev/null; then
      if [ "$age" -gt "$STALE_AFTER_SECONDS" ]; then
        rm -f "$lease"
        echo "slot.sh: stole stale $host_type lease (pid $lease_pid dead, age ${age}s)" >&2
      fi
    fi
  fi

 # Atomic acquire via hard link
  local tmp="$LEASE_DIR/.${host_type}.tmp.$$"
  printf '%s\n%s\n%s\n' "$pid" "$now" "$campaign" > "$tmp"

  if ln "$tmp" "$lease" 2>/dev/null; then
    rm -f "$tmp"
    echo "slot.sh: acquired $host_type lease for '$campaign'" >&2
    return 0
  fi
  rm -f "$tmp"

  echo "slot.sh: $host_type lease held by another process" >&2
  return 1
}

release_lease() {
  local host_type="$1"
  local lease="$LEASE_DIR/${host_type}.lock"
  rm -f "$lease"
  echo "slot.sh: released $host_type lease" >&2
}
