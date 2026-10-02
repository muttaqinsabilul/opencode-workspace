#!/usr/bin/env bash
# Opencode Workspace — local server watching this folder's OpenCode project sessions (read-only).
#
#   bash workspace.sh start   [--node|--php] [--port N] [--project DIR] [--bind ADDR]   run (idempotent)
#   bash workspace.sh stop                                                              stop server
#   bash workspace.sh restart [start opts]
#   bash workspace.sh status                                                            status, URL, log location
#   bash workspace.sh url                                                               print URL only
#   bash workspace.sh detect                                                            check Node/PHP & OpenCode
#
# Writes nothing into the project folder. Cache, PID, and log go to
#   ${WORKSPACE_STATE_DIR:-${XDG_CACHE_HOME:-~/.cache}/opencode-workspace}/<project-slug>/
# A --bind ADDR other than 127.0.0.1/localhost/::1 needs WORKSPACE_ALLOW_LAN=1; start then
#   generates an access token and every printed URL carries it.
# Optional variables: WORKSPACE_PORT, WORKSPACE_RUNTIME (node|php), WORKSPACE_BIND, WORKSPACE_STATE_DIR,
#   WORKSPACE_ALLOWED_HOSTS, WORKSPACE_TOKEN, WORKSPACE_ALLOW_LAN, WORKSPACE_EXPOSE_PATHS,
#   WORKSPACE_OPENCODE_URL, WORKSPACE_OPENCODE_BIN, WORKSPACE_OPENCODE_PASSWORD.
#   Optional per-project override: <project>/.opencode/opencode-workspace.json
set -u

RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CMD="${1:-start}"
[ $# -gt 0 ] && shift
WANT_RT="${WORKSPACE_RUNTIME:-}"
WANT_PORT=""
PROJ_ARG=""
BIND="${WORKSPACE_BIND:-127.0.0.1}"
QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --node) WANT_RT=node ;;
    --php) WANT_RT=php ;;
    --port) WANT_PORT="${2:-}"; shift ;;
    --port=*) WANT_PORT="${1#--port=}" ;;
    --project) PROJ_ARG="${2:-}"; shift ;;
    --project=*) PROJ_ARG="${1#--project=}" ;;
    --bind) BIND="${2:-}"; shift ;;
    --bind=*) BIND="${1#--bind=}" ;;
    --quiet|-q) QUIET=1 ;;
    -h|--help|help) CMD=help ;;
    *) echo "Unknown option: $1 (see: bash workspace.sh help)" >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
die() { printf 'Opencode Workspace: %s\n' "$*" >&2; exit 1; }

if [ "$CMD" = help ]; then
  sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

# ---- project & folder status
if [ -n "$PROJ_ARG" ]; then P0="$PROJ_ARG"
elif [ -n "${WORKSPACE_PROJECT:-}" ]; then P0="$WORKSPACE_PROJECT"
else P0="$PWD"; fi
PROJECT="$(cd "$P0" 2>/dev/null && pwd -P)" || die "project folder not found: $P0"
SLUG="$(printf '%s' "$PROJECT" | sed 's/[^a-zA-Z0-9]/-/g')"
STATE="${WORKSPACE_STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/opencode-workspace}/$SLUG"
ENVF="$STATE/server.env"
LOG="$STATE/server.log"
CONFIG="$PROJECT/.opencode/opencode-workspace.json"

cfg_value() {
  [ -f "$CONFIG" ] || return 0
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9a-z]*\).*/\1/p" "$CONFIG" | head -1
}
envget() { [ -f "$ENVF" ] && sed -n "s/^$1=//p" "$ENVF" | head -1; }
WIN=0; case "$(uname -o 2>/dev/null || uname -s 2>/dev/null)" in Msys|Cygwin) WIN=1 ;; esac
is_win() { [ "$WIN" = 1 ]; }
alive() {
  [ -n "${1:-}" ] || return 1
  kill -0 "$1" 2>/dev/null && return 0
  if is_win; then tasklist //FI "PID eq $1" //FO CSV //NH 2>/dev/null | grep -qi "\"$1\""; return $?; fi
  return 1
}
proc_image() {
  if is_win; then tasklist //FI "PID eq $1" //FO CSV //NH 2>/dev/null | cut -d'"' -f2
  else ps -p "$1" -o command= 2>/dev/null; fi
}
win_kill() {
  local force="${2:-}"
  if [ "$force" = -9 ]; then kill -9 "$1" 2>/dev/null && return 0; else kill "$1" 2>/dev/null && return 0; fi
  if is_win; then
    if [ "$force" = -9 ]; then taskkill //F //PID "$1" >/dev/null 2>&1; else taskkill //PID "$1" >/dev/null 2>&1; fi
    return $?
  fi
  return 1
}
oc_service() {
  if [ -n "${WORKSPACE_OPENCODE_URL:-}" ]; then printf '%s' "$WORKSPACE_OPENCODE_URL"; return 0; fi
  command -v "${WORKSPACE_OPENCODE_BIN:-opencode}" >/dev/null 2>&1 || return 1
  "${WORKSPACE_OPENCODE_BIN:-opencode}" service status 2>/dev/null | grep -oE 'https?://[^[:space:]"'\'']+' | head -1
}
have_node() { command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null; }
have_php() { command -v php >/dev/null 2>&1 && php -r 'exit(PHP_VERSION_ID >= 80100 && function_exists("mb_strlen") ? 0 : 1);' 2>/dev/null; }
project_key() {
  local pj="$PROJECT"
  case "$(uname -o 2>/dev/null || uname -s 2>/dev/null)" in
    Msys|Cygwin) pj="$(cygpath -w "$PROJECT" 2>/dev/null || (cd "$PROJECT" 2>/dev/null && pwd -W 2>/dev/null) || printf '%s' "$PROJECT")"; pj="${pj//\//\\}" ;;
  esac
  printf '%s' "$pj"
}
project_id() {
  local pj
  pj="$(project_key)"
  if command -v md5sum >/dev/null 2>&1; then printf '%s' "$pj" | md5sum | cut -c1-12
  elif command -v md5 >/dev/null 2>&1; then md5 -q -s "$pj" | cut -c1-12
  elif have_node; then node -e 'process.stdout.write(require("crypto").createHash("md5").update(process.argv[1]).digest("hex").slice(0,12))' "$pj"
  else php -r 'echo substr(md5($argv[1]), 0, 12);' "$pj"; fi
}
# What a *server* reports as project id: both runtimes hash their own realpath,
# which is the raw path on POSIX and the Windows form under Git Bash.
pid_project() {
  local pj="$1" key
  case "$(uname -o 2>/dev/null || uname -s 2>/dev/null)" in
    Msys|Cygwin) key="$(cygpath -w "$pj" 2>/dev/null || (cd "$pj" 2>/dev/null && pwd -W 2>/dev/null) || printf '%s' "$pj")" ;;
    *) key="$pj" ;;
  esac
  project_id "$key"
}
registry_file() { printf '%s' "${WORKSPACE_REGISTRY_FILE:-${XDG_CACHE_HOME:-$HOME/.cache}/opencode-workspace/registry.json}"; }
random_token() {
  if [ -r /dev/urandom ]; then head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; return 0; fi
  if have_node; then node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'; return 0; fi
  if have_php; then php -r 'echo bin2hex(random_bytes(32));'; return 0; fi
  return 1
}
# The token the servers enforce: WORKSPACE_TOKEN wins, else the one written for a --bind
# start. Same order as serve-node.mjs / index.php.
access_token() {
  local t
  t="$(envget TOKEN)"; [ -n "$t" ] || t="$(cat "$STATE/lan-token.txt" 2>/dev/null || true)"
  printf '%s' "$t"
}
# Query string the servers need right now: empty means "no token configured",
# which is why a plain local URL never changes.
access_q() {
  local t
  t="$(access_token)"
  [ -n "$t" ] || return 0
  printf '?k=%s' "$t"
}
registry_forget() {
  case "${WORKSPACE_NO_REGISTRY:-}" in ''|0) ;; *) return 0 ;; esac
  local f key
  f="$(registry_file)"
  [ -f "$f" ] || return 0
  key="$(project_key)"
  if have_node; then
    node -e 'const fs=require("fs");const[f,k]=process.argv.slice(1);try{const j=JSON.parse(fs.readFileSync(f,"utf8"));const a=Array.isArray(j)?j:(j&&Array.isArray(j.projects)?j.projects:[]);const b=a.filter(e=>!e||typeof e!=="object"||e.project!==k);if(b.length===a.length)process.exit(0);const t=`${f}.tmp-${process.pid}`;fs.writeFileSync(t,JSON.stringify(b,null,1));fs.renameSync(t,f);}catch(e){process.exit(0);}' "$f" "$key" 2>/dev/null
  elif have_php; then
    php -r '$f=$argv[1];$k=$argv[2];$j=@file_get_contents($f);if($j===false)exit(0);$d=json_decode($j,true);$a=(is_array($d)&&array_is_list($d))?$d:((is_array($d)&&isset($d["projects"])&&is_array($d["projects"]))?$d["projects"]:[]);$b=array_values(array_filter($a,static fn($e)=>!is_array($e)||($e["project"]??null)!==$k));if(count($b)===count($a))exit(0);$t=$f.".tmp-".getmypid();@file_put_contents($t,json_encode(array_slice($b,0,20),JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES));@rename($t,$f);' "$f" "$key" 2>/dev/null
  fi
  return 0
}
http_get() {
  if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 3 "$1" 2>/dev/null; return $?; fi
  if have_node; then node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(3000)}).then(r=>r.ok?r.text():Promise.reject()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))' "$1"; return $?; fi
  php -r '$c = stream_context_create(["http" => ["timeout" => 3]]); $b = @file_get_contents($argv[1], false, $c); if ($b === false) exit(1); echo $b;' "$1"
}
ping_ok() {
  local body
  body="$(http_get "http://$(host_for_url):$1/workspace/api/ping$(access_q)")" || return 1
  case "$body" in *'"app":"opencode-workspace"'*'"project":"'"$(pid_project "$PROJECT")"'"'*) return 0 ;; esac
  return 1
}
port_busy() { (exec 3<>"/dev/tcp/$(host_for_url)/$1") 2>/dev/null; }
host_for_url() {
  local b
  b="$(envget BIND)"; b="${b:-$BIND}"
  case "$b" in 0.0.0.0|::|'') echo 127.0.0.1 ;; *) echo "$b" ;; esac
}
trim_log() {
  [ -f "$LOG" ] && [ "$(wc -c <"$LOG" | tr -d ' ')" -gt 5242880 ] && : >"$LOG"
  return 0
}
PID_PROJECT="$(project_id)"

running() {
  local pid port
  pid="$(envget PID)"; port="$(envget PORT)"
  alive "$pid" && [ -n "$port" ] && ping_ok "$port"
}

stop_server() {
  local pid img i
  pid="$(envget PID)"
  registry_forget
  if alive "$pid"; then
    img="$(proc_image "$pid")"
    case "$img" in
      *serve-node.mjs*|*php*|*node*|*PHP*)
        win_kill "$pid" 2>/dev/null
        i=0; while alive "$pid" && [ $i -lt 20 ]; do sleep 0.2; i=$((i + 1)); done
        alive "$pid" && win_kill "$pid" -9 2>/dev/null
        rm -f "$ENVF" "$STATE/lan-token.txt"
        return 0 ;;
    esac
  fi
  rm -f "$ENVF" "$STATE/lan-token.txt"
  return 1
}

print_running() {
  local port rt url q
  port="$(envget PORT)"; rt="$(envget RUNTIME)"; q="$(access_q)"
  url="http://$(host_for_url):$port/workspace$q"
  say "Opencode Workspace running ($rt) for project: $(basename "$PROJECT")"
  say "  URL      : $url"
  case "$(envget BIND)" in 127.0.0.1|localhost|::1) ;; *) say "  Network  : also open on the local network (bind $(envget BIND)) — needs the URL above, which carries the access token" ;; esac
  say "  Stop     : bash \"$RUNTIME/bin/workspace.sh\" stop"
  [ -n "$(oc_service || true)" ] || say "  Note     : OpenCode service not detected — workspace fills up once 'opencode' runs in this folder."
}

start_server() {
  mkdir -p "$STATE/cache" || die "cannot create $STATE"
  trim_log
  if running; then
    if [ "$(envget RUNTIME_DIR)" = "$RUNTIME" ] && { [ -z "$WANT_RT" ] || [ "$WANT_RT" = "$(envget RUNTIME)" ]; } \
      && { [ -z "$WANT_PORT" ] || [ "$WANT_PORT" = "$(envget PORT)" ]; }; then
      print_running
      return 0
    fi
    say "Restarting (version/runtime/port changed)…"
    stop_server
  else
    stop_server >/dev/null 2>&1 || true
  fi
  local rt="$WANT_RT"
  if [ -z "$rt" ]; then
    if have_node; then rt=node; elif have_php; then rt=php; fi
  fi
  case "$rt" in
    node) have_node || die "Node ≥ 18 not found. Install Node 18+ (https://nodejs.org) or use --php." ;;
    php) have_php || die "PHP ≥ 8.1 (+ mbstring) not found. Install PHP 8.1+ or use --node." ;;
    *) die "Need Node ≥ 18 (recommended) or PHP ≥ 8.1. Install either: https://nodejs.org · https://www.php.net" ;;
  esac
  local base="${WANT_PORT:-${WORKSPACE_PORT:-$(cfg_value port)}}"
  base="${base:-8788}"
  case "$base" in ''|*[!0-9]*) die "invalid port: $base" ;; esac
  [ "$base" -ge 1024 ] && [ "$base" -le 65535 ] || die "port must be 1024–65535: $base"
  local token="${WORKSPACE_TOKEN:-}"
  case "$BIND" in
    127.*|localhost|::1) ;;
    *)
      [ "${WORKSPACE_ALLOW_LAN:-}" = 1 ] || die "bind $BIND puts this dashboard on the network with no login: anyone who can reach this address reads this project's agent activity. Re-run with WORKSPACE_ALLOW_LAN=1 to accept that, or bind 127.0.0.1."
      if [ -z "$token" ]; then
        local old_umask t0
        old_umask="$(umask)"; umask 077
        t0="$(random_token)" || t0=""
        [ -n "$t0" ] && printf '%s' "$t0" >"$STATE/lan-token.txt"
        umask "$old_umask"
        [ -s "$STATE/lan-token.txt" ] || die "cannot write the access token to $STATE/lan-token.txt"
        token="$(cat "$STATE/lan-token.txt")"
        say "Network access needs a token — generating one; the URL below carries it."
      fi ;;
  esac
  local port=$base last=$((base + 20)) pid ok i
  local st_win="$STATE"
  if is_win; then st_win="$(cygpath -w "$STATE" 2>/dev/null || printf '%s' "$STATE")"; fi
  while [ "$port" -le "$last" ]; do
    if port_busy "$port"; then port=$((port + 1)); continue; fi
    printf '\n[%s] start %s port %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rt" "$port" >>"$LOG"
    if [ "$rt" = node ]; then
      WORKSPACE_PROJECT="$PROJECT" WORKSPACE_STORAGE="$st_win" WORKSPACE_PORT="$port" WORKSPACE_BIND="$BIND" \
        WORKSPACE_ALLOW_LAN="${WORKSPACE_ALLOW_LAN:-}" WORKSPACE_TOKEN="$token" WORKSPACE_EXPOSE_PATHS="${WORKSPACE_EXPOSE_PATHS:-}" \
        nohup node "$RUNTIME/bin/serve-node.mjs" </dev/null >>"$LOG" 2>&1 &
    else
      WORKSPACE_PROJECT="$PROJECT" WORKSPACE_STORAGE="$st_win" WORKSPACE_BIND="$BIND" \
        WORKSPACE_ALLOW_LAN="${WORKSPACE_ALLOW_LAN:-}" WORKSPACE_TOKEN="$token" WORKSPACE_EXPOSE_PATHS="${WORKSPACE_EXPOSE_PATHS:-}" \
        nohup php -d display_errors=stderr -S "$BIND:$port" -t "$RUNTIME/public" "$RUNTIME/public/index.php" </dev/null >>"$LOG" 2>&1 &
    fi
    pid=$!
    wpid="$pid"; if is_win; then wpid="$(cat "/proc/$pid/winpid" 2>/dev/null || printf '%s' "$pid")"; fi
    ok=0; i=0
    while [ $i -lt 60 ]; do
      alive "$pid" || break
      if ping_ok "$port"; then ok=1; break; fi
      sleep 0.2; i=$((i + 1))
    done
    if [ $ok = 1 ]; then
      {
        echo "PID=$wpid"; echo "PORT=$port"; echo "RUNTIME=$rt"; echo "BIND=$BIND"
        echo "RUNTIME_DIR=$RUNTIME"; echo "PROJECT=$PROJECT"; echo "STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        [ -n "$token" ] && echo "TOKEN=$token"
        echo "TOKEN_MODE=1"
      } >"$ENVF"
      [ "$port" != "$base" ] && say "Port $base busy — using $port."
      print_running
      return 0
    fi
    if alive "$pid"; then win_kill "$pid" 2>/dev/null; fi
    if tail -n 5 "$LOG" | grep -qiE 'in use|already in use|busy|Failed to listen|EADDRINUSE'; then port=$((port + 1)); continue; fi
    printf 'Opencode Workspace: server failed to start. Log (%s):\n' "$LOG" >&2
    tail -n 15 "$LOG" >&2
    exit 1
  done
  die "no free port in $base–$last (use --port N)."
}

case "$CMD" in
  start) start_server ;;
  stop)
    if stop_server; then say "Opencode Workspace stopped."; else say "Opencode Workspace not running for this project."; fi ;;
  restart) stop_server >/dev/null 2>&1 || true; start_server ;;
  url)
    if running; then echo "http://$(host_for_url):$(envget PORT)/workspace$(access_q)"; else exit 1; fi ;;
  status)
    trim_log
    if running; then print_running; say "  PID      : $(envget PID) · started $(envget STARTED)"
    else say "Opencode Workspace not running for project: $(basename "$PROJECT")"; say "  Start    : bash \"$RUNTIME/bin/workspace.sh\" start"; fi
    say "  Data     : $STATE"
    svc="$(oc_service || true)"
    if [ -n "$svc" ]; then say "  OpenCode  : $svc"; else say "  OpenCode  : service not detected (run: opencode service status)"; fi
    if running; then
      body="$(http_get "http://$(host_for_url):$(envget PORT)/workspace/api/state$(access_q)" || true)"
      case "$body" in
        *'"app":"opencode-workspace"'*)
          title="$(printf '%s' "$body" | sed -n 's/.*"project":"\([^"]*\)".*/\1/p' | head -1)"
          nsub="$(printf '%s' "$body" | grep -o '"segment":' | wc -l | tr -d ' ')"
          say "  Sessions : project \"$title\" · $nsub subagents (7 days)" ;;
      esac
    fi ;;
  detect)
    echo "Opencode Workspace — environment check"
    if have_node; then echo "  node        $(node -v) (ok)"; elif command -v node >/dev/null 2>&1; then echo "  node        $(node -v) (TOO OLD, need ≥ 18)"; else echo "  node        missing"; fi
    if have_php; then echo "  php         $(php -r 'echo PHP_VERSION;') (ok)"; elif command -v php >/dev/null 2>&1; then echo "  php         $(php -r 'echo PHP_VERSION;') (need ≥ 8.1 + mbstring)"; else echo "  php         missing"; fi
    command -v curl >/dev/null 2>&1 && echo "  curl        present" || echo "  curl        missing (Node/PHP used instead)"
    if command -v "${WORKSPACE_OPENCODE_BIN:-opencode}" >/dev/null 2>&1; then echo "  opencode    $("${WORKSPACE_OPENCODE_BIN:-opencode}" --version 2>/dev/null | head -1)"; else echo "  opencode    missing (required — https://opencode.ai)"; fi
    svc="$(oc_service || true)"
    [ -n "$svc" ] && echo "  service     $svc" || echo "  service     not detected (run: opencode service status)"
    echo "  project     $PROJECT"
    echo "  server data $STATE" ;;
  *) echo "Unknown command: $CMD (start|stop|restart|status|url|detect)" >&2; exit 2 ;;
esac
