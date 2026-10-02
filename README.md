# Opencode Workspace

[![ci](https://github.com/muttaqinsabilul/opencode-workspace/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/muttaqinsabilul/opencode-workspace/actions/workflows/ci.yml)

A 2D workspace floor plan that shows what OpenCode is doing in your project, in real time.

The main session becomes the **Lead** at their desk. Four team members idle in the lounge and walk to their
desks whenever OpenCode calls a subagent. When the team is busy, **freelancers** come in through the door.

Everything is driven by your local OpenCode service API — no login, no configuration file required. Session
data, counts and activity are read live from your OpenCode service with nothing faked. The exception is the
speech bubbles over idle characters: those are decorative flavour text hardcoded in the browser client, not
real agent output.

## Requirements

| Component | Notes |
|---|---|
| OpenCode | CLI installed, service running (`opencode service status`) |
| Node.js ≥ 18 *or* PHP ≥ 8.1 + `mbstring` | Node is preferred; PHP is the fallback |
| bash, curl | Bundled on macOS/Linux; Git Bash or WSL on Windows |

No npm or Composer dependencies. The browser client is plain Canvas 2D.

## Quick start

```bash
git clone https://github.com/muttaqinsabilul/opencode-workspace.git
bash opencode-workspace/skills/opencode-workspace/runtime/bin/workspace.sh start
```

```
Opencode Workspace running (node) for project: cake-shop
  URL      : http://127.0.0.1:8788/workspace
  Stop     : bash "…/runtime/bin/workspace.sh" stop
```

Open the URL. The script is idempotent — if a server is already running for that project it just prints the
URL, and a busy port moves it to the next free one.

To load it as an OpenCode skill, symlink the skill folder:

```bash
mkdir -p ~/.config/opencode/skills
ln -s "$PWD/opencode-workspace/skills/opencode-workspace" ~/.config/opencode/skills/opencode-workspace
```

Then ask OpenCode to "run workspace".

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
actually visible.

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

The **Subagent** tab lists active subagents only — each one disappears as soon as it finishes. The
**Aktivitas** tab is the live event feed for everything the session does.

## How it works

1. The runtime locates the local OpenCode service and resolves the project matching the current directory.
2. Sessions are polled over the service API. Main sessions map to the Lead; child sessions map to team
   members, then to freelancers once the team is full. Assignment is recomputed from the same data on every
   poll, so it is stable across reloads and identical on Node and PHP.
3. A local server renders the floor plan and serves a JSON state document that the browser polls every 1
   second, skipping requests while the tab is hidden. The runtime runs from the skill folder and writes nothing
   into your project.

Subagent status: `working` (active within 15 min), `done`, or `stopped` (failed, interrupted, or idle for
15 min).

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

| Key | Default |
|---|---|
| `title` | Project folder name |
| `port` | `8788`, moves up automatically if busy |
| `names.lead` | `Jack` |
| `names.team` | 4 names (`null` keeps the default for that slot) |
| `names.freelancers` | Freelancer name list |

Environment overrides: `WORKSPACE_PORT`, `WORKSPACE_RUNTIME` (`node`/`php`), `WORKSPACE_BIND` (default
`127.0.0.1`; set `0.0.0.0` to reach it from your LAN), `WORKSPACE_STATE_DIR`, `WORKSPACE_ALLOWED_HOSTS`,
`WORKSPACE_OPENCODE_URL`, `WORKSPACE_OPENCODE_BIN`, `WORKSPACE_OPENCODE_PASSWORD`. `WORKSPACE_PORT_STRICT=1`
hands the port walk to `workspace.sh` alone: the server then exits 3 on a busy port instead of moving up, which
is what the `start` retry loop expects.

## Commands

```bash
workspace.sh start | stop | restart | status
workspace.sh start --php              # force the PHP runtime
workspace.sh start --port 9000        # start from a specific port
```

The server binds `127.0.0.1` and is not reachable from another machine.

On Windows, the root `workspace.ps1` and `workspace.cmd` start the server directly instead of going through
`workspace.sh`. Both default to port `8788` and watch the current working directory. A busy port moves up the
same way it does under `workspace.sh`, so the printed URL is the one to open. Configuration stays
environment-only, so `workspace.cmd` takes no arguments:

```powershell
.\workspace.ps1                                        # http://127.0.0.1:8788/workspace
.\workspace.ps1 -Port 9000 -Project D:\projects\cake-shop
```

```cmd
set WORKSPACE_PORT=9000 && set WORKSPACE_PROJECT=D:\projects\cake-shop && workspace.cmd
```

## Privacy

- **Read:** task descriptions, tool names, relative file paths, timestamps, token counts.
- **Never read:** tool output, full prompts, user instruction text.
- Secrets are redacted on both runtimes — `sk-…`, `ghp_…`, `AKIA…`, long hex strings, emails, credentials
  in URLs, and common password/token fields become `•••`.
- The server binds to localhost, rejects foreign `Host` headers, serves GET/HEAD only, sends a strict CSP
  and `X-Frame-Options: DENY`, and loads no external resources.

## Troubleshooting

**Everything stays idle.** The dashboard only reacts to real activity in the same directory as OpenCode.
Confirm `opencode service status` answers.

**Service not detected.** Set `WORKSPACE_OPENCODE_URL=http://127.0.0.1:<port>` if the service is not on the
default URL.

**Blank floor plan.** The browser needs Canvas 2D; the side panel keeps working without it. Try another
browser or enable hardware acceleration.

**Choppy animation.** Expected on low-powered devices. Enable the system "reduce motion" setting to skip
animations.

## Uninstall

1. `workspace.sh stop` in every project using it.
2. Remove the skill symlink, if you created one.
3. `rm -rf ~/.cache/opencode-workspace`, and delete `.opencode/opencode-workspace.json` if present.

## Contributing

Issues and pull requests welcome.

| Prerequisite | Notes |
|---|---|
| Node.js ≥ 18 | Runs the suite |
| PHP ≥ 8.1 + `mbstring` | Required — the parity half boots `php -S` and fails without it |

Run the whole suite with one command. It lints the JS, compares the Node and PHP servers byte for byte, boots a
throwaway server for `check.mjs`, asserts the port was released afterwards, and exits non-zero on any failure:

```bash
node skills/opencode-workspace/runtime/bin/test.mjs [--project=<dir>] [--php-port=8803] [--node-port=8804] [--check-port=8805]
```

It is plain Node, so it behaves the same in cmd, PowerShell and bash, and its default ports (8803/8804/8805)
never collide with a dashboard on 8788. `parity.mjs` is the internal Node-vs-PHP comparison that `test.mjs`
wraps — reach for it only when debugging parity itself.

The server is implemented twice and both sides must change together: `runtime/lib/node/*.mjs` against
`runtime/lib/php/*.php`, behind the entry points `runtime/bin/serve-node.mjs` and `runtime/public/index.php`. A
one-sided edit fails the suite. CI runs it on `ubuntu-latest` and `windows-latest` across Node 18, 20 and 22.

Never include real session contents, project paths, or screenshots containing real data in examples, fixtures
or docs.

## License

[MIT](LICENSE) © muttaqinsabilul. No JS framework or runtime dependencies — the browser client is plain Canvas 2D.
The bundled Plus Jakarta Sans font is the one third-party component, under SIL OFL 1.1; its license text is at
`skills/opencode-workspace/runtime/public/assets/fonts/OFL.txt`.
