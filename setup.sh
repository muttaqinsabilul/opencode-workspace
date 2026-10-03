#!/usr/bin/env bash
# Opencode Workspace — one-command first run.
#
#   bash setup.sh [--project DIR] [--port N] [--node|--php] [--copy]
#
# Does three things, then you never run it again:
#   1. Detects the environment (opencode CLI, Node ≥ 18 or PHP ≥ 8.1).
#   2. Symlinks the skill into the OpenCode skills dir, so any agent
#      session answers "run workspace" from now on.
#   3. Starts the dashboard server for the project and prints its URL.
#
# Run it from the project you want to watch, or pass --project.
# Refusing to watch this repo itself: pass --project <your-project>.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL="$ROOT/skills/opencode-workspace"
SH="$SKILL/runtime/bin/workspace.sh"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/opencode-workspace"

PROJ_ARG=""
PROJ_GIVEN=0
COPY=0
START_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJ_ARG="${2:-}"; PROJ_GIVEN=1; START_ARGS+=("$1" "$2"); shift 2 ;;
    --project=*) PROJ_ARG="${1#--project=}"; PROJ_GIVEN=1; START_ARGS+=("$1"); shift ;;
    --port|--bind) START_ARGS+=("$1" "${2:-}"); shift 2 ;;
    --port=*|--bind=*) START_ARGS+=("$1"); shift ;;
    --node|--php) START_ARGS+=("$1"); shift ;;
    --copy) COPY=1; shift ;;
    -h|--help|help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      echo "Everything else is passed to: bash workspace.sh start --project DIR --port N --node/--php"
      exit 0 ;;
    *) echo "Unknown option: $1 (see: bash setup.sh --help)" >&2; exit 2 ;;
  esac
done

# ---- 1. detect: which project, and is the toolchain there?
if [ -n "$PROJ_ARG" ]; then P0="$PROJ_ARG"; else P0="$PWD"; fi
PROJECT="$(cd "$P0" 2>/dev/null && pwd -P)" || { echo "Opencode Workspace: project folder not found: $P0" >&2; exit 1; }
if [ "$PROJECT" = "$ROOT" ]; then
  echo "Opencode Workspace: this watches the clone itself — run setup.sh from your project" >&2
  echo "  or pass: bash setup.sh --project <your-project>" >&2
  exit 1
fi
command -v opencode >/dev/null 2>&1 || echo "Note: 'opencode' CLI not on PATH — the dashboard starts anyway and fills up once OpenCode runs here."
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" -ge 18 ] 2>/dev/null; then
  RT="node $(node -v)"
elif command -v php >/dev/null 2>&1 && php -r 'exit(PHP_VERSION_ID >= 80100 ? 0 : 1);' 2>/dev/null; then
  RT="php $(php -r 'echo PHP_VERSION;' 2>/dev/null)"
else
  echo "Opencode Workspace: need Node ≥ 18 or PHP ≥ 8.1 (+ mbstring). Install one: https://nodejs.org · https://www.php.net" >&2
  exit 1
fi
echo "Project : $PROJECT"
echo "Runtime : $RT"

# ---- 2. install the skill (idempotent absolute symlink, verified)
# NOTE: ln -s on Git Bash without Developer Mode / elevation silently makes a
# real directory copy instead of a link (a stale copy misleads the agent after
# updates), so a fresh link is verified and a silent copy is never kept.
mkdir -p "$(dirname "$DEST")"
if [ "$COPY" = 1 ]; then
  rm -rf "$DEST"
  cp -r "$SKILL" "$DEST"
  echo "Skill   : copied to $DEST (re-run setup.sh --copy after updating the clone)"
elif [ -e "$DEST" ] || [ -L "$DEST" ]; then
  if [ -L "$DEST" ] && [ "$(cd "$DEST" 2>/dev/null && pwd -P)" = "$SKILL" ]; then
    echo "Skill   : already installed ($DEST)"
  else
    echo "Opencode Workspace: $DEST already exists and is not this clone's link." >&2
    echo "  Remove or back it up first — or pass --copy to install a plain copy instead." >&2
    exit 1
  fi
else
  ln -s "$SKILL" "$DEST" 2>/dev/null
  if [ -L "$DEST" ]; then
    echo "Skill   : linked $DEST"
  else
    rm -rf "$DEST"
    echo "Opencode Workspace: cannot create a symlink (needs Developer Mode or an elevated shell)." >&2
    echo "  Retry elevated, enable Developer Mode, or pass --copy for a plain copy." >&2
    exit 1
  fi
fi

# ---- 3. start the server for the project
if [ "$PROJ_GIVEN" = 1 ]; then bash "$SH" start "${START_ARGS[@]}"
else bash "$SH" start --project "$PROJECT" "${START_ARGS[@]}"; fi
echo "From now on, just ask OpenCode: run workspace"
