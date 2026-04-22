# Teams Monitor

AI agents that live in Microsoft Teams channels, powered by GitHub Copilot CLI and Agency.

See the **[Interactive Setup Guide](https://htmlpreview.github.io/?https://gist.githubusercontent.com/jonburchel/a40170ab2b5faf6feb3a480cb0a72cd6/raw/teams-monitor-setup-guide.html)** for full documentation, or browse [teams-monitor-setup-guide.html](teams-monitor-setup-guide.html) locally.

## What It Does

Post a message in a Teams channel. Within seconds, a persistent AI agent responds in-thread with a styled Adaptive Card. Each agent works in a specific repo directory, has access to mail, calendar, and MCP tools, and maintains a memory file across sessions. Per-agent bridge MCPs are loaded via local config files, so your global ~/.copilot/mcp-config.json is never touched.

## Background

This project was inspired by [Jen Weigel's demo](https://github.com/bradygaster/squad) of using Microsoft Teams to interact with Squad, a multi-agent dev team orchestrator for GitHub Copilot. That demo sparked the idea: what if you could talk to your own Copilot CLI agents from Teams, with each channel mapped to a specific repo?

We explored Squad for this, but the two tools optimize for different interaction models. Squad is built around GitHub issue triage: a coordinator agent routes issues to specialist agents (frontend, backend, tester) with shared decision governance. Teams Monitor solves a different problem: persistent, single-agent-per-channel conversations in real time, where the "routing" is trivially handled by channel identity. Adding Squad's coordination layer on top would have been overhead without benefit for this use case.

So Teams Monitor is not "Squad in Teams." It's a separate tool, built for a different workflow, that started from a Squad demo. Squad remains excellent for multi-agent GitHub orchestration; Teams Monitor fills a gap for people who want to interact with repo-specific Copilot CLI agents through a familiar Teams interface.

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

## Current Limitations

The current implementation uses Agency's Teams MCP (backed by M365 Copilot/WorkIQ) to poll for messages, because we do not yet have the Entra ID app registration or Graph API permissions needed for direct Teams API access. This works, but introduces constraints:

- **No bot identity.** Messages appear from the authenticated user's account, not a dedicated bot. We decorate replies with Adaptive Cards to distinguish them visually, but the sender is still "you."
- **No read/unread control.** When the agent replies, the channel doesn't show as unread for other users. There's no way to signal "new response here" through the Teams notification system.
- **No reactions or processing indicators.** Can't add a 👀 reaction when processing or ✅ when complete. Users get no feedback between posting a request and receiving the reply.
- **Polling latency.** Detection time is ~5-8 seconds (Graph API polling). With the optional Azure Function + Service Bus push mode, this drops to sub-second, but that requires additional infrastructure.
- **Single-user auth.** All activity runs under one user's OAuth token.

## Roadmap: With Proper Teams App Registration

These limitations are not inherent to the architecture. They go away in tiers with proper permissions:

**With an Entra ID app registration + Graph API permissions:**
- Dedicated bot identity (messages come from "Teams Monitor," not you)
- `ChannelMessage.Read.All` for direct message access without MCP polling
- Change Notifications (webhooks) for real-time push detection (the Azure Function webhook handler is already built; see `azure-function/` and `create-subscriptions.ps1`)
- Message reactions via Graph API (beta)

**Still constrained by the Teams platform (no API exists):**
- Marking channel messages as unread (no Graph API for this)
- Typing indicators in channel messages

## Quick Start

```powershell
git clone https://github.com/jonburchel/teams-monitor.git
cd teams-monitor && cd teams-bridge && npm install && cd ..
cp workflow.config.example.json workflow.config.json  # edit with your IDs
.\auth.cmd                      # one-time OAuth sign-in
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
  auth.cmd                      # One-time MCP auth
  create-subscriptions.ps1      # Graph webhook subscription setup (requires permissions)
  teams-bridge/
    index.mjs                   # Bridge MCP: polls, queues, replies, thread tracking
  azure-function/
    src/functions/               # Azure Function webhook handler for Graph push notifications
  .agents/
    charter-source/             # Agent charters per channel
    memory/                     # Persistent agent memory (committed to git)
    state/                      # Runtime state (gitignored)
  teams-monitor-setup-guide.html
```

## Stopping

Ctrl+C or create `.agents\ralph-stop`. Cleans up all processes. No global config restoration needed (bridge MCPs use local config files only).
