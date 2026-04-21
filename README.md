# Teams Monitor

AI agents that live in Microsoft Teams channels, powered by GitHub Copilot CLI and Agency.

See **teams-monitor-setup-guide.html** for full interactive documentation.

## What It Does

Post a message in a Teams channel. Within seconds, a persistent AI agent responds in-thread with a styled Adaptive Card. Each agent works in a specific repo directory, has access to your full MCP toolkit (WorkIQ, ADO, mail, calendar, Playwright, memory, context7), and maintains a memory file across sessions.

## Architecture

```
Teams Web (MutationObserver per channel)
     |
     v (push via MutationObserver, no polling)
Browser Watcher -----> Notification Files -----> Bridge MCPs (fast 3s poll)
                                                      |
Teams Channels <---> Agency Teams MCP Proxy <---------+
                     (port 58410)                     |
                                                      v
                                              Copilot Sessions (persistent)
                                              + Agent Memory (.md files)
```

**Three-tier detection:**
1. **Browser watcher** injects a MutationObserver into each channel tab via `page.exposeFunction()`. When a new message DOM node appears, it calls directly into Node.js (true push, no polling)
2. **Bridge MCP** switches to 3s fast polling when watcher signals activity, 15s normal otherwise
3. **Copilot sessions** call `check_messages()` continuously, process immediately with full context

**Why not just Graph API webhooks?** Requires a public HTTPS endpoint. **Why not just poll?** 15s is too slow for conversational feel. The browser watcher bridges the gap without external infrastructure.

Design validated by independent Claude Opus 4.7 architecture reviews at multiple stages.

## Quick Start

```powershell
git clone https://github.com/jonburchel/teams-monitor.git
cd teams-monitor && cd teams-bridge && npm install && cd ..
.\auth.cmd                      # one-time OAuth sign-in
.\start-agents.ps1              # start monitoring
.\start-agents.ps1 -AutoUpdate  # with auto-pull from git
```

On first run, the browser watcher opens an Edge window for Teams sign-in. After that, auth persists across restarts.

## Files

```
teams-monitor/
  start-agents.ps1              # Main launcher
  workflow.config.json          # Channel/agent config (user-specific)
  background-tasks.json         # Scheduled automations
  auth.cmd                      # One-time MCP auth
  teams-bridge/
    index.mjs                   # Bridge MCP: polls, queues, replies, thread tracking
    teams-watcher.mjs           # Browser watcher: sidebar badge detection (2s)
    mark-unread.mjs             # Playwright mark-unread (experimental)
  .agents/
    charter-source/             # Agent charters per channel
    memory/                     # Persistent agent memory (committed to git)
    state/                      # Runtime state (gitignored)
  teams-monitor-setup-guide.html
```

## Stopping

Ctrl+C or create `.agents\ralph-stop`. Cleans up all processes, browser, and restores MCP config.
