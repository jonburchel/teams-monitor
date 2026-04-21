# Teams Monitor

AI agents that live in Microsoft Teams channels, powered by GitHub Copilot CLI and Agency.

See **teams-monitor-setup-guide.html** for full interactive documentation.

## What It Does

Post a message in a Teams channel. Within seconds, a persistent AI agent responds in-thread with a styled Adaptive Card. Each agent works in a specific repo directory, has access to mail, calendar, and any MCP servers in your global ~/.copilot/mcp-config.json, and maintains a memory file across sessions.

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

**Why not Graph webhooks?** Requires a public HTTPS endpoint. **Why not a browser watcher?** 15s is too slow for conversational feel. The browser watcher bridges the gap without external infrastructure.

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

The browser watcher runs headless by default. If cached auth is missing (first run or token expiry), it opens a visible Edge window for sign-in, then switches back to headless automatically.

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
    mark-unread.mjs             # Playwright mark-unread (experimental)
  .agents/
    charter-source/             # Agent charters per channel
    memory/                     # Persistent agent memory (committed to git)
    state/                      # Runtime state (gitignored)
  teams-monitor-setup-guide.html
```

## Stopping

Ctrl+C or create `.agents\ralph-stop`. Cleans up all processes, browser, and restores MCP config.
