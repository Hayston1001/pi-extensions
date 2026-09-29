# pi-thinking-display

English | [简体中文](README_zh.md)

## What it is

An extension that keeps pi's thinking blocks expanded while they stream, and
collapses them once they are done.

> [!IMPORTANT]
> Automatic collapsing works in `regular mode`  
> Some features, such as hover / click-to-expand, require `TUI mode`

### Features

- **Streaming collapse**: while an assistant message is being generated, the
  thinking block still being output stays expanded. As soon as visible content
  starts appearing after it, it collapses on its own.
- **Mouse interaction**: thinking blocks show a fold marker; the pointer
  highlights it on hover, and a click expands / collapses it.

> [!NOTE]
> Respects pi's native `Ctrl+T` behavior for expanding thinking blocks and never
> overrides it.

## Install

```bash
pi install npm:pi-thinking-display
pi install -e npm:pi-thinking-display     # one-shot trial
```

## Configuration file

> [!TIP]
> Use `/thinking-display-settings` to open the visualization settings panel

At `~/.pi/agent/thinking-display.json`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `streaming` | boolean | `true` | Expand only the thinking block that is still streaming |
| `decorate` | boolean | `true` | Enable the fold marker and hover highlight |

> [!WARNING]
> A missing field, a wrong type, or broken JSON falls back to the default; a bad
> config never breaks rendering. Hand edits apply on the next `/reload` or in a
> new session.

## Development

```bash
node test/run.mjs           # all
node test/run.mjs unit      # config, streaming rules, marker/hover/click, settings panel
node test/run.mjs lifecycle # real AgentSession: extension discovery, when config applies, /reload
```
