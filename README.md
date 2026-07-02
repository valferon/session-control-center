# Session Control Center for Claude Code

A VSCode / VSCodium extension that gives you a control center for your local
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions across every
repo, so you can context switch without leaving the editor.

> **Unofficial.** This is a community project. It is not affiliated with, endorsed by,
> or supported by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic;
> they are used here only to describe what the extension works with.

## Privacy and data handling

- **Fully local by default.** The extension reads `~/.claude/projects/*/*.jsonl`
  (Claude Code's own session logs) straight off disk to build the sidebar and dashboard.
  Nothing about your sessions, prompts, code, or files is sent anywhere.
- **No telemetry.** No analytics, no tracking, no third-party calls.
- **One optional network call, opt-in and off by default.** The "subscription usage"
  panel (`claudeControlCenter.usage.enabled`) reads your local Claude OAuth token from
  `~/.claude/.credentials.json` and calls Anthropic's own usage endpoint
  (`api.anthropic.com`) with it, the same data as the `/usage` command. The token is only
  ever sent to Anthropic as an auth header. It is never logged, stored, or sent elsewhere.
  Leave the setting off and the extension makes no network calls and never reads the token.
- Session logs may contain sensitive content (secrets, customer data) in prompts. Because
  everything stays on your machine, the extension does not transmit it, but be aware the
  sidebar/dashboard surface titles and prompt snippets on screen.

It reads Claude Code's internal, undocumented log format on a best-effort basis. That
format can change between Claude Code releases and temporarily break parsing.

## Features

- **Sidebar tree**: sessions grouped by repo with live, animated status dots:
  - active (green, working), awaiting input (blue, blocked on you via a question / plan
    approval), finished (purple, turn just ended), idle (yellow), closed.
  - Rich hover tooltips: model, tokens, est. cost, branch, files touched, PRs, subagents.
- **Dashboard webview**: metric tiles, activity chart, searchable + sortable session table.
- **Context switch**: open a session's repo in a new window, or open it and auto-start a
  Claude conversation (uses the `anthropic.claude-code` extension's commands when present).
- **Notifications** on finished turns, awaiting-input, and new PR links (all toggleable).
- **Live updates** via `fs.watch` on the projects dir.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed locally (this
  extension reads its session logs).
- The context-switch "start a conversation" actions call commands from the
  `anthropic.claude-code` extension; install it to use them. Everything else works without it.

## Settings

- `claudeControlCenter.activeThresholdMinutes` (default 5)
- `claudeControlCenter.idleThresholdHours` (default 24)
- `claudeControlCenter.projectsDir` (default auto: `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`)
- `claudeControlCenter.openFolderMode` (`newWindow` | `prompt` | `currentWindow`, default `newWindow`)
- `claudeControlCenter.sidebarHideClosed` (default true)
- `claudeControlCenter.openOnStartup` (default true)
- `claudeControlCenter.usage.enabled` (default **false**, see Privacy above)
- `claudeControlCenter.notifications.*` (master switch, on-finish, on-PR, max age)

## Build from source

```bash
pnpm install
pnpm run package   # produces session-control-center-<version>.vsix
code --install-extension session-control-center-*.vsix   # or: codium --install-extension ...
```

Open the activity-bar icon, or run **Claude Control Center: Open Dashboard**.

## License

[MIT](./LICENSE)