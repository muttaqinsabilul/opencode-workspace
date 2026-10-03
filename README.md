# Opencode Workspace

[![ci](https://github.com/muttaqinsabilul/opencode-workspace/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/muttaqinsabilul/opencode-workspace/actions/workflows/ci.yml)

A 2D workspace floor plan that shows what OpenCode is doing in your project, in real time, at
`http://127.0.0.1:8788/workspace`.

The main session becomes the **Lead** at their desk. Four team members idle in the lounge and walk to their
desks whenever OpenCode calls a subagent. When the team is busy, **freelancers** come in through the door.
Everything is driven by your local OpenCode service API — no login, no configuration file required.

## Requirements

| Component | Notes |
|---|---|
| OpenCode | CLI installed, service running (`opencode service status`) |
| Node.js ≥ 18 *or* PHP ≥ 8.1 + `mbstring` | Node is preferred; PHP is the fallback |
| bash, curl | Bundled on macOS/Linux; Git Bash or WSL on Windows for `workspace.sh` |

No npm or Composer dependencies at runtime. The browser client is plain Canvas 2D.

## Quick start

Run the launcher from the **project you want to watch** (sessions are looked up for the current directory),
not from the cloned repo.

macOS / Linux:

```bash
git clone https://github.com/muttaqinsabilul/opencode-workspace.git
cd <your-project>
bash <path-to>/opencode-workspace/skills/opencode-workspace/runtime/bin/workspace.sh start
```

Windows (native, no bash needed — run from your project directory):

```powershell
git clone https://github.com/muttaqinsabilul/opencode-workspace.git
cd <your-project>
<path-to>\opencode-workspace\workspace.ps1
```

```cmd
cd <your-project>
set WORKSPACE_PROJECT=<your-project> && <path-to>\opencode-workspace\workspace.cmd
```

Expected output:

```
Opencode Workspace running (node) for project: cake-shop
  URL      : http://127.0.0.1:8788/workspace
  Stop     : bash "…/runtime/bin/workspace.sh" stop
```

Open the URL. Starting is idempotent — if a server already runs for that project it just prints the URL,
and a busy port moves to the next free one automatically.

To load it as an OpenCode skill:

```bash
# macOS / Linux — use the absolute path, then verify
mkdir -p ~/.config/opencode/skills
ln -s /absolute/path/to/opencode-workspace/skills/opencode-workspace ~/.config/opencode/skills/opencode-workspace
```

```powershell
# Windows (elevated prompt for the symlink; otherwise copy the folder instead)
New-Item -ItemType Directory -Force -Path $env:USERPROFILE\.config\opencode\skills
New-Item -ItemType SymbolicLink -Path $env:USERPROFILE\.config\opencode\skills\opencode-workspace -Target C:\absolute\path\to\opencode-workspace\skills\opencode-workspace
```

Then ask OpenCode to "run workspace".

## Commands

```bash
cd <your-project>
bash workspace.sh start                    # idempotent: prints URL if already running
bash workspace.sh start --php              # force the PHP runtime (--node forces Node)
bash workspace.sh start --port 9000        # start searching from a specific port
bash workspace.sh start --project DIR --bind ADDR --quiet
bash workspace.sh stop | restart | status | url | detect
bash workspace.sh help
```

| Command | What it does |
|---|---|
| `start` | Launches the server (Node ≥ 18 when available, else PHP ≥ 8.1); reuses the running server if there is one |
| `stop` | Stops the server for this project and unregisters it |
| `restart` | `stop` + `start` (accepts the same options as `start`) |
| `status` | URL, PID, start time, state directory, OpenCode service, live session count |
| `url` | Prints the dashboard URL only (exit 1 when not running) |
| `detect` | Environment check: Node, PHP, curl, `opencode` CLI, service, project, state dir |

`workspace.ps1` / `workspace.cmd` are minimal foreground launchers for Windows: they start the Node server
for the current directory (or `-Project DIR` / `WORKSPACE_PROJECT=DIR`) and stop with `Ctrl+C`. They have
no `stop`/`status`/`restart`/`url`/`detect`, no PHP fallback, and `workspace.cmd` takes no arguments — all
configuration is via environment variables. Use `workspace.sh stop` (from that project) to stop a
`workspace.sh`-launched server.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `WORKSPACE_PORT` | `8788` | Base port; moves up automatically when busy (see below) |
| `WORKSPACE_RUNTIME` | auto | `node` when Node ≥ 18 exists, else `php` (`--node` / `--php` flags do the same) |
| `WORKSPACE_BIND` | `127.0.0.1` | `--bind ADDR`; anything non-loopback needs `WORKSPACE_ALLOW_LAN=1` **and** a token |
| `WORKSPACE_ALLOW_LAN` | unset | Set to `1` to allow binding a LAN address |
| `WORKSPACE_TOKEN` | auto-generated | Required with `WORKSPACE_ALLOW_LAN=1`; if unset, a token is generated into `lan-token.txt` and every printed URL carries it |
| `WORKSPACE_STATE_DIR` | `$XDG_CACHE_HOME/opencode-workspace` (else `~/.cache/opencode-workspace`) | Per-project state lives in `<dir>/<project-slug>/` |
| `WORKSPACE_REGISTRY_FILE` | `<cache>/opencode-workspace/registry.json` | Cross-project server list behind the "Switch…" dropdown |
| `WORKSPACE_NO_REGISTRY` | unset | Set to `1` to skip registry registration |
| `WORKSPACE_ALLOWED_HOSTS` | — | Extra `Host` values the server accepts |
| `WORKSPACE_EXPOSE_PATHS` | unset | Set to `1` to include absolute project paths in the JSON state (off by default) |
| `WORKSPACE_OPENCODE_URL` | auto-detected | Set to `http://127.0.0.1:<port>` when the service is not on the default URL |
| `WORKSPACE_OPENCODE_BIN` | `opencode` | Alternate CLI binary |
| `WORKSPACE_OPENCODE_PASSWORD` | — | Password for a protected OpenCode service |
| `WORKSPACE_PROJECT` | current directory | Project to watch (`--project DIR` flag does the same) |
| `WORKSPACE_PORT_STRICT` | unset | `=1` disables the auto-walk (server exits 3 on a busy port); set automatically by `workspace.sh`, which owns the retry loop — do not set it manually |

Port precedence: `--port` › `WORKSPACE_PORT` › `port` in `.opencode/opencode-workspace.json` › `8788`.
The `json` port is read by `workspace.sh` only; launching `serve-node.mjs` directly (including via
`workspace.ps1` / `workspace.cmd`) uses `WORKSPACE_PORT` or `8788`. On a busy port the server walks
`base…base+20` and prints the URL it actually got — open the printed URL. LAN binding refuses to start
without the token precisely because anyone who can reach the address could read agent activity.

## Files

Nothing is written into the watched project (except the optional config file you create yourself):

```
<skill-dir>/runtime/                        # the whole server; runs in place
  bin/workspace.sh                          # full launcher: start|stop|restart|status|url|detect|help
  bin/serve-node.mjs                        # Node entry point (what .ps1/.cmd execute)
  public/index.php                          # PHP entry point (php -S fallback)
  lib/node/*.mjs  +  lib/php/*.php          # implemented twice — change both sides together
  defaults.json                             # default names and timing windows
<project>/.opencode/opencode-workspace.json # optional overrides (you create this)
<cache>/opencode-workspace/
  registry.json                             # live servers for the project switcher
  <project-slug>/server.env                 # PID, PORT, URLs for stop/status/url
  <project-slug>/server.log                 # server log — read this first when debugging
  <project-slug>/lan-token.txt              # auto-generated LAN token, when applicable
```

## Configuration

Optional. Create `.opencode/opencode-workspace.json` in the project you are watching:

```json
{
  "title": "Cake Shop",
  "port": 8790,
  "names": {
    "lead": "Jack",
    "team": ["Alex", "Mia", "Leo", "Emma"],
    "freelancers": ["Oliver", "Sophia"]
  }
}
```

| Key | Default | Notes |
|---|---|---|
| `title` | Project folder name | Max 60 characters |
| `port` | `8788`, moves up automatically if busy | Read by `workspace.sh` only (see Environment) |
| `names.lead` | `Jack` | Max 20 characters |
| `names.team` | 4 names | Positional: index `i` overrides slot `i`; `null`/empty keeps the default for that slot |
| `names.freelancers` | 12 built-in names | Your list replaces the default list |

Unknown keys are ignored and an invalid JSON file is silently treated as `{}`.

## Map & panel

| Action | How |
|---|---|
| Pan | drag (touch: one finger) |
| Zoom | wheel / pinch / double-click |
| Reset view | double-click while zoomed in |
| Inspect an agent | click them |
| Switch panel view | the **Subagent** / **Aktivitas** tabs |

One panel, docked right and always open: active subagents on one tab, the live activity feed (with its category
filter) on the other. The last tab is remembered per browser, and the map is centred in the space that is
actually visible. The **Subagent** tab lists active subagents only — each one disappears as soon as it finishes.

## Rooms

| Room | What is in it |
|---|---|
| **Studio Utama** | the Lead's and the team members' desks |
| **Studio CX** | the spare desks used by freelancers |
| **Musolla** | prayer room — mihrab, sajadah, wudu place, shoe rack |
| **Nonton TV** | big screen, sofas, bean bags, snack cart |
| **Ping Pong** | table, net, rackets, scoreboard, benches |
| **Warung Kopi** | coffee bar, espresso machine, pastry case, menu board |
| **Garasi** | roller door, workbench, tool board, tyre rack |
| **Ruang Santai** | sofas, bookcases, a sleeping cat |
| **Gerai Bakso** | outside, east of the building — cart, stools, vendor, street lamp |

## How it works

1. The runtime locates the local OpenCode service and resolves the project matching the current directory.
2. Sessions are polled over the service API. Main sessions map to the Lead; child sessions map to team
   members, then to freelancers once the team is full. Assignment is recomputed from the same data on every
   poll, so it is stable across reloads and identical on Node and PHP.
3. A local server renders the floor plan and serves a JSON state document that the browser polls every 1
   second, skipping requests while the tab is hidden. The runtime runs from the skill folder and writes nothing
   into your project.

Subagent status: `working` (active within 15 min), `done`, or `stopped` (failed, interrupted, or idle for
15 min). Speech bubbles over idle characters are decorative flavour text hardcoded in the browser client,
not real agent output — sessions, counts and the activity feed all come from the OpenCode service.

## Privacy

- **Read:** task descriptions, tool names, relative file paths, timestamps, token counts.
- **Never read:** tool output, full prompts, user instruction text.
- Secrets are redacted on both runtimes — `sk-…`, `ghp_…`, `AKIA…`, long hex strings, emails, credentials
  in URLs, and common password/token fields become `•••`.
- The server binds to localhost, rejects foreign `Host` headers, serves GET/HEAD only, sends a strict CSP
  and `X-Frame-Options: DENY`, and loads no external resources.

## Troubleshooting

Start here — these two answer most questions:

```bash
bash workspace.sh detect   # Node/PHP/curl/opencode/service all in one place
bash workspace.sh status   # is it running, on which port, log location
```

| Symptom | Fix |
|---|---|
| Everything stays idle | The dashboard only reacts to real activity in the watched directory. Confirm `opencode service status` answers and you started the launcher from that project. |
| Service not detected | Set `WORKSPACE_OPENCODE_URL=http://127.0.0.1:<port>` if the service is not on the default URL. |
| Wrong port / port busy | Expected: the server walks `base…base+20` and prints the URL it got. Open the printed URL, or pin one with `--port N` / `{"port": N}`. |
| Stale server / won't start | `status` compares the recorded PID against a live check; `stop` + `start` clears it. The log is at `<cache>/opencode-workspace/<project-slug>/server.log`. |
| `Need Node ≥ 18` / PHP errors | Install Node 18+ (preferred) or PHP ≥ 8.1 **with** `mbstring`; `detect` shows exactly which half is missing. |
| Blank floor plan | The browser needs Canvas 2D; the side panel keeps working without it. Try another browser or enable hardware acceleration. |
| Choppy animation | Expected on low-powered devices. Enable the system "reduce motion" setting to skip animations. |

## Uninstall

1. Stop every server: `workspace.sh stop` in each watched project (`Ctrl+C` for foreground `workspace.ps1` / `workspace.cmd` runs).
2. Remove the skill symlink (or copied folder), if you created one:
   `rm ~/.config/opencode/skills/opencode-workspace` (POSIX) or delete
   `%USERPROFILE%\.config\opencode\skills\opencode-workspace` (Windows).
3. Delete the cache dir (`~/.cache/opencode-workspace`, or `%USERPROFILE%\.cache\opencode-workspace` /
   `$XDG_CACHE_HOME/opencode-workspace` if set) and any `.opencode/opencode-workspace.json` you created.

## Contributing

Issues and pull requests welcome.

| Prerequisite | Notes |
|---|---|
| Node.js ≥ 18 | Runs the suite |
| PHP ≥ 8.1 + `mbstring` | Required — the parity half boots `php -S` and fails without it |

Run the whole suite with one command. It compares the Node and PHP servers byte for byte, boots a
throwaway server for `check.mjs`, asserts the ports were released afterwards, and exits non-zero on any failure:

```bash
node skills/opencode-workspace/runtime/bin/test.mjs [--project=<dir>] [--php-port=8803] [--node-port=8804] [--check-port=8805]
```

It is plain Node, so it behaves the same in cmd, PowerShell and bash, and its default ports (8803/8804/8805)
never collide with a dashboard on 8788. `parity.mjs` is the internal Node-vs-PHP comparison that `test.mjs`
wraps — reach for it only when debugging parity itself (note: it uses hardcoded ports, so two copies
collide with each other).

The server is implemented twice and both sides must change together: `runtime/lib/node/*.mjs` against
`runtime/lib/php/*.php`, behind the entry points `runtime/bin/serve-node.mjs` and `runtime/public/index.php`. A
one-sided edit fails the suite. CI runs it on `ubuntu-latest` and `windows-latest` across Node 18, 20 and 22.

Never include real session contents, project paths, or screenshots containing real data in examples, fixtures
or docs.

## License

[MIT](LICENSE) © muttaqinsabilul. No JS framework or runtime dependencies — the browser client is plain Canvas 2D.
The bundled Plus Jakarta Sans font is the one third-party component, under SIL OFL 1.1; its license text is at
`skills/opencode-workspace/runtime/public/assets/fonts/OFL.txt`.
