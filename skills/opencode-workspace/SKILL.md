---
name: opencode-workspace
description: Zero-config 2D workspace floor plan (Canvas 2D) at http://127.0.0.1:8788/workspace showing what OpenCode is doing in this project. The Lead (main session) works at their desk; 4 team members (Alex, Mia, Leo, Emma) hang out in the relaxing rooms (musolla, nonton TV, ping pong, warung kopi, garasi bakso), then sit down to work every time OpenCode calls a subagent; when the team is full, freelancers come through the door. All from the local OpenCode service API, read-only, no files written to the project. Node ≥ 18 (or PHP ≥ 8.1). Use when the user wants to view/start/stop the workspace, the subagent dashboard, or its public URL.
argument-hint: "[start|stop|status|public|stop-public] [--node|--php] [--port N]"
---

The ready-to-run runtime lives in this skill directory (`runtime/`) — **nothing is copied into the project**. All commands use
`bash "<skill-dir>/runtime/bin/workspace.sh" <command>` and run in the **current project root** (the folder where
OpenCode was opened), because sessions are looked up for that project via the OpenCode service API.

Needs: `opencode` CLI installed and the OpenCode service running (`opencode service status` answers with a URL). The server
finds the service automatically; override via env `WORKSPACE_OPENCODE_URL`, `WORKSPACE_OPENCODE_BIN`,
`WORKSPACE_OPENCODE_PASSWORD`.

User args: $ARGUMENTS

## Steps
1. **Pick the command from the args** (no args = `start`):
   - `start` / empty → `bash "<skill-dir>/runtime/bin/workspace.sh" start` (pass `--node`, `--php`, `--port N` through when given).
   - `stop` → `… workspace.sh stop` · `status` → `… workspace.sh status` · `restart` → `… workspace.sh restart`.
   - `public` / `tunnel` / `--public` → run `start` first, then `… workspace.sh tunnel` (needs `cloudflared`).
   - `stop-public` / `tunnel-stop` → `… workspace.sh tunnel-stop`.
2. The script is idempotent: if a server already runs for this project it just prints the URL; busy port → automatically
   moves to the next free port; Node ≥ 18 is used when available, otherwise PHP ≥ 8.1. If neither exists, relay
   the script's error message verbatim (how to install Node/PHP), then stop.
3. **Report briefly** (in English): local URL (the `URL :` line), runtime, how to stop
   (`workspace.sh stop` or the printed `Stop` command). If the script prints `Note     : OpenCode service not
   detected…`, explain the workspace fills up once OpenCode is used in this folder (all characters idle until there
   is activity).
4. **Offer the public URL in one sentence** (never run it without explicit approval). When the user asks for it,
   after `tunnel` succeeds relay its warning: anyone with the link can see agent activity (read-only,
   redacted), share only with trusted people, turn it off with `workspace.sh tunnel-stop`.

## Reading the workspace (for answering user questions)
- **Lead** (default "Jack") = the newest active OpenCode main session; more than one active session → a "+N other sessions" note.
- **Team** (Alex, Mia, Leo, Emma) = child sessions (subagents). A new subagent → the first free member (fixed order) walks
  to their desk; done/failed/interrupted → "Done!" then back to idle. Assignment is recomputed from the same data
  so it stays stable.
- **Freelancer** = subagents while all four team members are busy: enter through the door, sit at spare desks (max 4 desks,
  the rest on a "+N" card), leave through the door when done.
- Name/title/port overrides via `<project>/.opencode/opencode-workspace.json` (optional, see README):
  `{"title": "…", "port": 8788, "names": {"lead": "…", "team": ["…","…","…","…"], "freelancers": ["…"]}}`.

## Project switcher
- Every running server registers itself in `~/.cache/opencode-workspace/registry.json` (`project`, `port`, `title`, `updated`);
  the "Switch…" dropdown lists the other live projects and jumps to their port.
- `stop` unregisters the project, and the API drops entries older than 10 min plus duplicate ports, so the list never
  offers a dead server or two entries on one port. Busy base port is not an error — the next free port in `base…base+20`
  is used automatically, so two projects can run side by side (8788 and 8789, …). Pin a port per project with
  `{"port": N}` when you want a stable URL.

## Rules
- Read-only against the project and the OpenCode API; never create or modify files in the project unless the user asks for
  `.opencode/opencode-workspace.json`. Cache/PID/log live in `~/.cache/opencode-workspace/<project-slug>/`.
- Never open a public tunnel without user approval; never paste tool output / session contents into replies
  (summaries only: tool name, subagent description, first line of text).
- Optional verification: `node "<skill-dir>/runtime/bin/check.mjs" <base-url>`; when both Node **and** PHP exist:
  `node "<skill-dir>/runtime/bin/parity.mjs" --project="$PWD"` (must print "PARITY OK").
