# pi-tool-display

English | [简体中文](README_zh.md)

## What it is

An extension that renders pi's tool calls at the information density you want.

> [!IMPORTANT]
> Mouse interaction requires `TUI mode`; everything else works without it

## Usage

| Tier | Rendering |
| --- | --- |
| `mini` | The whole batch collapses into one summary line: `✓ 5 tools` when everything succeeds, `✕ 3 tools` when something failed, `⋯ 2/5 tools` while it is still running |
| `low` | Like `mini`, but also lists tool names; past the configured maximum the rest fold into `+N` |
| `medium` | Like the native style, but without output -- it keeps a one-line summary instead: entry count, duration, timeout. Errors from failed calls are still shown |
| `default` | pi's native rendering |

> [!TIP]
> With `mini` / `low`, the line can be clicked to expand, and you can configure how far it expands

### Features

- **Hover highlight**: the row under the pointer is brightened

## Install

```bash
pi install npm:@hayston/pi-tool-display
pi install -e npm:@hayston/pi-tool-display   # one-shot trial
```

## Configuration file

> [!TIP]
> Use `/tool-display-settings` to open the visualization settings panel

At `~/.pi/agent/tool-display.json`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `display` | `"mini"` / `"low"` / `"medium"` / `"default"` | `"mini"` | Tier |
| `hoverHighlight` | boolean | `true` | Brighten the row under the pointer (TUI only) |
| `expandStyle` | `"medium"` / `"default"` | `"medium"` | What style `mini` / `low` expands into |
| `low.nameLimit` | number | `3` | Maximum tool names listed on a `low` row; the rest become `+N` |
| `medium.showErrorLine` | boolean | `true` | Extra error summary line when a `medium` call fails |

> [!WARNING]
> A missing field, a wrong type, or broken JSON falls back to the default, so a
> bad config never breaks rendering. Hand edits apply on the next `/reload` or in
> a new session.

## Development

```bash
node test/run.mjs          # both suites
node test/run.mjs unit     # tiers, summary lines, hover, settings command
node test/run.mjs reload   # registration timing around /reload
```
