# fabric-docs Agent Memory

Persistent record of decisions, learnings, and context across sessions.


## 2026-04-21 Removed calendar-guard background task
Jon requested removal of the calendar-guard task from background-tasks.json since WorkIQ can't perform calendar write actions (declining invites). Considered Playwright alternative but deemed impractical due to Outlook UI instability, auth complexity, and maintenance burden. Suggested Graph API with Calendars.ReadWrite as the right solution if this feature is wanted in the future. Reply to Teams failed (NotFound on both message IDs).
