# pi-timeline

English | [简体中文](README_zh.md)

A message timeline overview built for the case where a long conversation in pi
makes it painful to get back to a point: it lists the session's user messages
(`!` shell commands included), filters them as you type, and scrolls the
transcript viewport precisely to the one you pick.

> [!IMPORTANT]
> The **TUI mode** is required.

## Usage

| Key | Action |
| --- | --- |
| `alt+h` (configurable) | Open the message list |
| just type | Filter messages |
| `↑`/`↓` (or `PgUp`/`PgDn`) | Move the selection |
| `Enter` | Jump |
| `Ctrl+Enter` | Insert the message text into the editor |
| `Esc` | Close |

> [!TIP]
> `/timeline-settings` opens the settings panel.

> [!NOTE] Jump target
> `user` the user message itself  
> `reply` the final answer

> [!WARNING]
> Invalid shortcuts are rejected. Without a modifier, only named keys (such as
> `f2`) are accepted.

## Install

```sh
pi install npm:pi-timeline
pi -e npm:pi-timeline             # one-shot trial
```

## Configuration file

At `~/.pi/agent/timeline.json`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `shortcut` | string / array of strings / null | `"alt+h"` | Case-insensitive; duplicates removed automatically |
| `jumpTo` | string | `"user"` | `"user"` / `"reply"` |
| `language` | string | `"auto"` | `"auto"` / `"zh"` / `"en"` |

> [!WARNING]
> A bad value falls back to the default and raises a warning when the session starts. `jumpTo` is re-read on every invocation, so changing it applies immediately; the shortcut is registered at load time, so changing it needs `/reload`.

## Development

```sh
node test/run.mjs                # all tests
node test/run.mjs unit config    # named suites: unit | real | config
```
