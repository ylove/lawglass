#!/bin/sh
# Starts `serve` and keeps the app's state across Cloud Run instance restarts.
#
# Cloud Run's filesystem lives in memory and disappears when an instance stops. The app needs a
# real POSIX directory (it checks file modes, takes `wx` lock files and refuses symlinks), so it
# keeps working in ~/.lawglass as usual, and this script copies that state to and from one
# tarball on a mounted Cloud Storage bucket:
#   - at boot, restore the tarball if there is one;
#   - every INTERVAL seconds, save a new tarball if something changed and the state has been
#     quiet for QUIET seconds (no write in progress);
#   - on SIGTERM, stop the server and save once more. Cloud Run allows 10 seconds for this.
# A save is discarded, not kept, if any file changed while tar was reading, so a tarball never
# mixes old and new state. A snapshot that cannot be read is moved aside, never overwritten.
# Without a writable SNAPSHOT_DIR the server runs without persistence.
# The script waits on the server itself, so a crash ends the container at once and Cloud Run
# starts a fresh one; the periodic saves run in a background loop.
set -u

STATE_PARENT="$HOME"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-/snapshots}"
SNAPSHOT="$SNAPSHOT_DIR/state.tar.gz"
INTERVAL="${SNAPSHOT_INTERVAL_SECONDS:-60}"
QUIET="${SNAPSHOT_QUIET_SECONDS:-30}"
SAVED_MARK="$HOME/.snapshot-saved"
QUIET_MARK="$HOME/.snapshot-quiet"
START_MARK="$HOME/.snapshot-start"
# What is saved, relative to $HOME. Models ship in the image and raw downloads are only a cache.
STATE_PATHS=".lawglass/registry.json .lawglass/docs .lawglass/store .lawglass/history .lawglass/sponsors .lawglass/cache/answers"

log() {
  printf '{"level":"%s","event":"snapshot","message":"%s"}\n' "$1" "$2" >&2
}

snapshots_enabled() {
  [ -d "$SNAPSHOT_DIR" ] && [ -w "$SNAPSHOT_DIR" ]
}

# State paths that exist right now; tar and find fail on missing ones.
present_paths() {
  for path in $STATE_PATHS; do
    [ -e "$STATE_PARENT/$path" ] && printf '%s ' "$path"
  done
}

# True when any saved path was modified after the given marker file.
changed_after() {
  paths=$(present_paths)
  [ -n "$paths" ] || return 1
  # shellcheck disable=SC2086 # the path list is split on purpose
  [ -n "$(cd "$STATE_PARENT" && find $paths -newer "$1" -print -quit 2>/dev/null)" ]
}

# Removes restored state, for a restore that failed partway.
clear_state() {
  for path in $STATE_PATHS; do
    rm -rf "${STATE_PARENT:?}/$path"
  done
}

restore() {
  if [ ! -f "$SNAPSHOT" ]; then
    log info "no snapshot yet; starting with empty state"
    return
  fi
  # A second try covers a transient read error on the mounted bucket.
  for attempt in 1 2; do
    if gzip -t "$SNAPSHOT" 2>/dev/null && tar -xzpf "$SNAPSHOT" -C "$STATE_PARENT"; then
      log info "state restored"
      return
    fi
    clear_state
    [ "$attempt" = 1 ] && sleep 2
  done
  # Keep the unreadable file for inspection; the next save must not overwrite it.
  aside="$SNAPSHOT_DIR/state.unreadable-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  if mv -f "$SNAPSHOT" "$aside"; then
    log error "snapshot unreadable; kept as $(basename "$aside"); starting with empty state"
  else
    log error "snapshot unreadable and could not be moved aside; saving is off for this instance"
    SNAPSHOTS=off
  fi
}

save() {
  paths=$(present_paths)
  [ -n "$paths" ] || return 0
  touch "$START_MARK"
  tmp="$SNAPSHOT.tmp"
  # shellcheck disable=SC2086 # the path list is split on purpose
  if ! (cd "$STATE_PARENT" && tar -czpf "$tmp" --exclude='*.lock' $paths); then
    rm -f "$tmp"
    log error "save failed"
    return 1
  fi
  if changed_after "$START_MARK"; then
    rm -f "$tmp"
    log info "state changed during save; will retry"
    return 1
  fi
  if gzip -t "$tmp" && mv -f "$tmp" "$SNAPSHOT"; then
    # The start time, not the finish time, so a write that lands during the save is caught.
    mv -f "$START_MARK" "$SAVED_MARK"
    log info "state saved"
  else
    rm -f "$tmp"
    log error "save could not be verified"
    return 1
  fi
}

save_if_due() {
  changed_after "$SAVED_MARK" || return 0
  touch -d "@$(($(date +%s) - QUIET))" "$QUIET_MARK"
  changed_after "$QUIET_MARK" && return 0
  save || true
}

# Runs in the background. A TERM only sets a flag: it interrupts the sleep at once, but a save
# that is already running completes, so the final save after shutdown has less left to do.
snapshot_loop() {
  stop=0
  trap 'stop=1' TERM
  while [ "$stop" = 0 ]; do
    sleep "$INTERVAL" &
    wait $!
    [ "$stop" = 0 ] && save_if_due
  done
}

mkdir -p "$HOME/.lawglass"
chmod 700 "$HOME/.lawglass"
SNAPSHOTS=off
if snapshots_enabled; then
  SNAPSHOTS=on
  restore
else
  log warning "no writable $SNAPSHOT_DIR; state will not survive a restart"
fi
# Restored files keep their archived times, so they count as already saved.
touch "$SAVED_MARK"

node /app/dist/cli.js serve "$@" &
server=$!
loop=
if [ "$SNAPSHOTS" = on ]; then
  snapshot_loop &
  loop=$!
fi
trap 'kill -TERM "$server" 2>/dev/null' TERM INT

wait "$server"
status=$?
# A trapped signal makes `wait` return early; keep waiting until the server has really exited.
while kill -0 "$server" 2>/dev/null; do
  wait "$server"
  status=$?
done

if [ -n "$loop" ]; then
  kill -TERM "$loop" 2>/dev/null
  wait "$loop" 2>/dev/null
fi
if [ "$SNAPSHOTS" = on ] && changed_after "$SAVED_MARK"; then
  save || true
fi
exit "$status"
