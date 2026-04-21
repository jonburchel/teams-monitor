# Teams Monitor

AI agents that live in Microsoft Teams channels, powered by GitHub Copilot CLI and Agency.

See **teams-monitor-setup-guide.html** for full interactive documentation.

## What It Does

Post a message in a Teams channel. Within seconds, a persistent AI agent responds in-thread with a styled Adaptive Card. Each agent works in a specific repo directory, has access to mail, calendar, and MCP tools, and maintains a memory file across sessions. Per-agent bridge MCPs are loaded via local config files, so your global ~/.copilot/mcp-config.json is never touched.

## Architecture

```
Teams Channels <---> Agency Teams MCP HTTP Proxy (default port 58410)
                          |
                          |---> Bridge MCP (Fabric Docs, 5s poll) ---> Copilot Session
                          |---> Bridge MCP (Foundry Docs, 5s poll) --> Copilot Session
                          +---> Bridge MCP (Home, 5s poll) ----------> Copilot Session
                                    |
                                    +--> Agent Memory (.md files)
```

**How it works:** Each channel gets a per-channel Bridge MCP (Node.js) that polls the shared Teams MCP proxy every 5 seconds via direct HTTP. When a new message is detected, the bridge queues it and the persistent Copilot session picks it up on its next `check_messages()` call. Total detection time: ~5-8 seconds.

**Why not Graph webhooks?** Requires a public HTTPS endpoint. **Why not a browser?** Teams' SPA DOM is fragile and headless Edge is unreliable for long-running monitoring.

Design validated by independent Claude Opus 4.7 architecture reviews at multiple stages.

## Quick Start

```powershell
git clone https://github.com/jonburchel/teams-monitor.git
cd teams-monitor && cd teams-bridge && npm install && cd ..
cp workflow.config.example.json workflow.config.json  # edit with your IDs
.\auth.cmd                      # one-time OAuth sign-in
.\start-agents.ps1              # start monitoring
.\start-agents.ps1 -AutoUpdate  # with auto-pull from git
```

The watcher module (teams-watcher.mjs) is experimental and not used in the default flow.

## Files

```
teams-monitor/
  start-agents.ps1              # Main launcher
  workflow.config.json          # Your config (gitignored, create from example)
  workflow.config.example.json   # Template config
  background-tasks.json         # Scheduled automations
  auth.cmd                      # One-time MCP auth
  teams-bridge/
    index.mjs                   # Bridge MCP: polls, queues, replies, thread tracking
    teams-watcher.mjs           # Browser watcher (experimental, not used in default flow)
    mark-unread.mjs             # Standalone mark-unread script (not used; agents use Playwright MCP directly)
  .agents/
    charter-source/             # Agent charters per channel
    memory/                     # Persistent agent memory (committed to git)
    state/                      # Runtime state (gitignored)
  teams-monitor-setup-guide.html
```

## Stopping

Ctrl+C or create `.agents\ralph-stop`. Cleans up all processes. No global config restoration needed (bridge MCPs use local config files only).
