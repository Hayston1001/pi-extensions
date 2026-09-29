# pi-token-meter

English | [简体中文](README_zh.md)

## What it is

A session token meter for pi. It shows the numbers growing in real time, and
prints a settlement line when a round ends (that line never enters the model
context).

Live line (next to the spinner):

```
── ⠋ ↓1.2k 45tok/s 12s ──────────────────────────
```

Result line:

```
↑286k ↓1.2k R13.4M W1.2M 57tok/s 3m32s · claude-opus-5 (high) $20.16
```

> [!TIP]
> `↑ input` input (uncached input)  
> `↓ output` output (thinking tokens included)  
> `R`/`W` cache read / cache write (shown when non-zero)  
> `model name` the model ID (the same one pi's model list and status bar show)  
> `cost` computed from the model price list (per-million-token prices, tiered
> pricing included, 1h cache writes doubled); same source and same accounting as
> pi's status-bar cost  
> `tok/s` output tokens ÷ pure generation time. Generation time accumulates
> "first output token → end" per model call, so it excludes first-token wait and
> tool execution  
> `round duration` wall-clock time of a whole round, from the moment the message
> is sent until the round settles  
> `estimates` a usage report the provider sends while streaming is taken as-is.
> Before it reports, the input side is split into input / cache read by "context
> size − last cached prefix", and the output side is estimated from what has
> been generated so far (CJK ≈ 0.9 token/char, otherwise ≈ 4 chars/token, +40
> structural overhead per tool call; calibrated against real provider usage,
> average error ≈ 10%). After `message_end` the provider's final numbers always
> overwrite the estimates, so the result line is the final accounting and agrees
> with the bill exactly

### Features

- **Live counters**: ↑ input / ↓ output / R/W cache / $ cost / speed / duration,
  growing in real time
- **Arrow animation presets**: **Steady** (the arrow of the counter that is
  growing lights up, otherwise grey), **Blink** (the growing arrow blinks per
  frame), **Merge** (the default; both counters merge into one slot that shows
  only the side that is changing)
- **Wait timer**: after a message is sent, the round's timer is appended to pi's
  working line (`Working 12s`), and is replaced by the full live line as soon as
  the model starts answering; with "show duration" off, the wait timer is hidden
  too
- **Round settlement**: one round = from sending the message to fully settling
  (automatic retries / compaction continuations / queued messages included).
  Once it ends, one line is written at the end of the transcript
- **Complete accounting**: every model call in the round is summed; nested model
  calls inside tools (subagents and the like) and the summary generation of
  automatic compaction count as well; on interrupt or error, whatever was spent
  is still settled
- **Visual configuration**: `/token-meter-settings` opens a settings panel in the
  same style as pi's own `/settings`

> [!NOTE]
> Numbers during streaming are estimates or incremental reports; the round
> settlement is what counts (the settled value agrees with the provider bill
> exactly)  
> Idle-time cache warming happens outside a round and is not counted in it; it
> does count toward pi's own session totals  
> When a model has no prices configured (`cost` is 0) the cost shows `$0`; token
> counting is unaffected

## Install

```bash
pi install npm:@hayston/pi-token-meter
pi install -e npm:@hayston/pi-token-meter     # one-shot trial
```

## Configuration file

> [!TIP]
> Use `/token-meter-settings` to open the visualization settings panel

At `~/.pi/agent/token-meter.json`

**Global**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `animation` | string | `"merge"` | `steady` / `blink` / `merge` |
| `live` | boolean | `true` | Show the live line |
| `resultInTranscript` | boolean | `true` | Show the result line |
| `refreshMs` | number | `120` | Live refresh interval (80/120/200/320/500ms) |
| `language` | string | `"auto"` | `"auto"` / `"zh"` / `"en"` |

**Live line fields** (submenu)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `liveShowArrows` | boolean | `true` | ↑↓ |
| `liveShowCache` | boolean | `false` | Cache read / cache write |
| `liveShowCost` | boolean | `false` | Estimated cost |
| `liveShowTps` | boolean | `true` | Speed (tok/s) |
| `liveShowDuration` | boolean | `true` | Full duration of the round |
| `liveShowModel` | boolean | `false` | Model ID |
| `liveShowThinking` | boolean | `false` | Thinking level |

**Result line fields** (submenu)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `showArrows` | boolean | `true` | ↑↓ |
| `showCache` | boolean | `true` | Cache read / cache write |
| `showCost` | boolean | `true` | Estimated cost |
| `showTps` | boolean | `true` | Speed (tok/s) |
| `showDuration` | boolean | `true` | Duration of the round |
| `showModel` | boolean | `true` | Model ID |
| `showThinking` | boolean | `true` | Thinking level |

> [!WARNING]
> Missing fields, wrong types and broken JSON all fall back to the defaults, and
> the refresh interval snaps to a preset, so a bad file can never drag a session
> down  
> `language` is re-resolved every time the panel opens. Changing **Language** in
> the panel reopens it immediately in the new language

## Development

```bash
node test/run.mjs           # all
node test/run.mjs unit      # copy, config, metering, formatting, panel, event wiring
node test/run.mjs lifecycle # real AgentSession: extension discovery, registration result, /reload
```
