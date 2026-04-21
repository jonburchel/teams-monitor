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

**How it works:** Each channel gets a per-channel Bridge MCP (Node.js) that polls the shared Teams MCP proxy every 5 seconds via direct HTTP. When a new message is detected, the bridge queues it and the persistent Copilot session picks it up on its next `check_messages()` call. Total detection time: ~5-8 seconds. Sessions run via copilot.exe directly (not through Agency) with per-agent config directories, so the global ~/.copilot/mcp-config.json is never modified.

**Why not Graph webhooks?** Requires a public HTTPS endpoint. **Why not a browser?** Teams' SPA DOM is fragile and headless Edge is unreliable for long-running monitoring.

## Quick Start

```powershell
git clone https://github.com/jonburchel/teams-monitor.git
cd teams-monitor && cd teams-bridge && npm install && cd ..
cp workflow.config.example.json workflow.config.json  # edit with your IDs
.\auth.cmd                      # one-time OAuth sign-in (MCPs + Graph Chat)
.\start-agents.ps1              # start monitoring
.\start-agents.ps1 -AutoUpdate  # with auto-pull from git
```

## Files

```
teams-monitor/
  start-agents.ps1              # Main launcher
  workflow.config.json          # Your config (gitignored, create from example)
  workflow.config.example.json   # Template config
  background-tasks.json         # Scheduled automations
  auth.cmd                      # One-time auth (MCPs + Graph Chat API)
  teams-bridge/
    index.mjs                   # Bridge MCP: polls, queues, replies, thread tracking
    graph-helpers.mjs            # Graph API: OAuth2 device code flow, mark self-chat unread
    auth-graph.mjs               # Standalone Graph auth setup script
  .agents/
    charter-source/             # Agent charters per channel
    memory/                     # Persistent agent memory (committed to git)
    state/                      # Runtime state (gitignored)
  teams-monitor-setup-guide.html
```

## Stopping

Ctrl+C or create `.agents\ralph-stop`. Cleans up all processes. No global config restoration needed (bridge MCPs use local config files only).
