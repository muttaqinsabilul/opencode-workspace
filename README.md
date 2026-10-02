# Opencode Workspace

A 2D workspace floor plan that shows what OpenCode is doing in your project, in real time.

The main session becomes the **Lead** at their desk. Four team members idle in the lounge and walk to their
desks whenever OpenCode calls a subagent. When the team is busy, **freelancers** come in through the door.

Everything is driven by your local OpenCode service API — no simulated data, no login, no configuration file
required.

## Requirements

| Component | Notes |
|---|---|
| OpenCode | CLI installed, service running (`opencode service status`) |
| Node.js ≥ 18 *or* PHP ≥ 8.1 + `mbstring` | Node is preferred; PHP is the fallback |
| bash, curl | Bundled on macOS/Linux; Git Bash or WSL on Windows |

No npm or Composer dependencies. The browser client is plain Canvas 2D.

## Quick start

```bash
git clone https://github.com/sabiluldev-bit/opencode-workspace.git
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
3. A local server renders the floor plan and serves a JSON state document that the browser polls every 3
   seconds. The runtime runs from the skill folder and writes nothing into your project.

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
`WORKSPACE_OPENCODE_URL`, `WORKSPACE_OPENCODE_BIN`, `WORKSPACE_OPENCODE_PASSWORD`.

## Commands

```bash
workspace.sh start | stop | restart | status | tunnel | tunnel-stop
workspace.sh start --php              # force the PHP runtime
workspace.sh start --port 9000        # start from a specific port
```

`tunnel` exposes the dashboard publicly via `cloudflared`. Anyone with the link can see agent activity, so
share it deliberately and turn it off with `tunnel-stop`.

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

Issues and pull requests welcome. The server is implemented twice — `runtime/lib/node/*.mjs` and
`runtime/lib/php/*.php` — and both must stay in sync. After changing either, run
`node skills/opencode-workspace/runtime/bin/parity.mjs --project=<test-project>` and confirm `PARITY OK`.
Never include session contents or real project data in examples or screenshots.

## License

[MIT](LICENSE) © sabiluldev-bit. No third-party libraries — the browser client is plain Canvas 2D.
