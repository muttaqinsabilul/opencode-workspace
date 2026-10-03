#!/usr/bin/env bash
# Opencode Workspace — one-command first run.
#
#   bash setup.sh [--project DIR] [--port N] [--bind ADDR] [--node|--php] [--quiet] [--copy]
#
# Does three things, then you never run it again:
#   1. Detects the environment (opencode CLI, Node ≥ 18 or PHP ≥ 8.1).
#   2. Symlinks the skill into the OpenCode skills dir, so any agent
#      session answers "run workspace" from now on.
#   3. Starts the dashboard server for the project and prints its URL.
#
# Run it from the project you want to watch, or pass --project.
# Refuses to watch this repo itself: pass --project <your-project>.
# --copy installs a plain folder copy instead of a symlink (re-run after updates).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL="$ROOT/skills/opencode-workspace"
SH="$SKILL/runtime/bin/workspace.sh"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/opencode-workspace"

die() { printf 'Opencode Workspace: %s\n' "$*" >&2; exit 1; }
[ -d "$SKILL" ] || die "skill folder missing: $SKILL (is this the full clone?)"
[ -f "$SH" ] || die "launcher missing: $SH"

PROJ_ARG=""
PROJ_GIVEN=0
COPY=0
WANT_RT=""
START_ARGS=()
need_val() { # $1 = flag, $2 = value or empty
  [ -n "${2:-}" ] || { printf 'Opencode Workspace: %s needs a value (see: bash setup.sh --help)\n' "$1" >&2; exit 2; }
}
while [ $# -gt 0 ]; do
  case "$1" in
    --project) need_val "$1" "${2:-}"; PROJ_ARG="$2"; PROJ_GIVEN=1; START_ARGS+=("$1" "$2"); shift 2 ;;
    --project=*) need_val "$1" "${1#--project=}"; PROJ_ARG="${1#--project=}"; PROJ_GIVEN=1; START_ARGS+=("$1"); shift ;;
    --port|--bind) need_val "$1" "${2:-}"; START_ARGS+=("$1" "$2"); shift 2 ;;
    --port=*|--bind=*) need_val "$1" "${1#*=}"; START_ARGS+=("$1"); shift ;;
    --node) WANT_RT=node; START_ARGS+=("$1"); shift ;;
    --php) WANT_RT=php; START_ARGS+=("$1"); shift ;;
    --quiet|-q) START_ARGS+=("$1"); shift ;;
    --copy) COPY=1; shift ;;
    -h|--help|help)
      sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      echo "Forwarded to 'workspace.sh start': --project DIR --port N --bind ADDR --node/--php --quiet"
      exit 0 ;;
    *) printf 'Opencode Workspace: unknown option: %s (see: bash setup.sh --help)\n' "$1" >&2; exit 2 ;;
  esac
done

# ---- 1. detect: which project, and is the toolchain there?
if [ -n "$PROJ_ARG" ]; then P0="$PROJ_ARG"; else P0="$PWD"; fi
PROJECT="$(cd "$P0" 2>/dev/null && pwd -P)" || die "project folder not found: $P0"
if [ "$PROJECT" = "$ROOT" ] || case "$PROJECT" in "$ROOT"/*) true ;; *) false ;; esac; then
  die "this watches the clone itself — run setup.sh from your project or pass --project <your-project>"
fi
command -v opencode >/dev/null 2>&1 || echo "Note: 'opencode' CLI not on PATH — the dashboard starts anyway and fills up once OpenCode runs here."
if [ "$WANT_RT" = php ]; then
  command -v php >/dev/null 2>&1 && php -r 'exit(PHP_VERSION_ID >= 80100 ? 0 : 1);' 2>/dev/null \
    && RT="php $(php -r 'echo PHP_VERSION;' 2>/dev/null) (requested)" \
    || die "need PHP ≥ 8.1 (+ mbstring) for --php: https://www.php.net"
elif [ "$WANT_RT" = node ]; then
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" -ge 18 ] 2>/dev/null \
    && RT="node $(node -v) (requested)" \
    || die "need Node ≥ 18 for --node: https://nodejs.org"
elif command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" -ge 18 ] 2>/dev/null; then
  RT="node $(node -v)"
elif command -v php >/dev/null 2>&1 && php -r 'exit(PHP_VERSION_ID >= 80100 ? 0 : 1);' 2>/dev/null; then
  RT="php $(php -r 'echo PHP_VERSION;' 2>/dev/null)"
else
  die "need Node ≥ 18 or PHP ≥ 8.1 (+ mbstring). Install one: https://nodejs.org · https://www.php.net"
fi
echo "Project : $PROJECT"
echo "Runtime : $RT"

# ---- 2. install the skill (idempotent absolute symlink, verified)
# NOTE: ln -s on Git Bash without Developer Mode / elevation silently makes a
# real directory copy instead of a link (a stale copy misleads the agent after
# updates), so a fresh link is verified and a silent copy is never kept.
mkdir -p "$(dirname "$DEST")" || die "cannot create $(dirname "$DEST")"
if [ "$COPY" = 1 ]; then
  rm -rf "$DEST"
  cp -rp "$SKILL" "$DEST" || die "copy failed"
  echo "Skill   : copied to $DEST (re-run setup.sh --copy after updating the clone)"
elif [ -e "$DEST" ] || [ -L "$DEST" ]; then
  if [ -L "$DEST" ] && [ "$(cd "$DEST" 2>/dev/null && pwd -P)" = "$SKILL" ]; then
    echo "Skill   : already installed ($DEST)"
  else
    die "$DEST already exists and is not this clone's link — remove or back it up first, or pass --copy"
  fi
else
  ln -s "$SKILL" "$DEST" 2>/dev/null
  if [ -L "$DEST" ]; then
    echo "Skill   : linked $DEST"
  else
    rm -rf "$DEST"
    die "cannot create a symlink (needs Developer Mode or an elevated shell) — retry elevated or pass --copy"
  fi
fi

# ---- 3. start the server for the project (failure propagates, no false success)
if [ "$PROJ_GIVEN" = 1 ]; then bash "$SH" start "${START_ARGS[@]}"
else bash "$SH" start --project "$PROJECT" "${START_ARGS[@]}"; fi
[ $? -eq 0 ] || exit 1
echo "From now on, just ask OpenCode: run workspace"
