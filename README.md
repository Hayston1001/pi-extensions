# pi-extensions

A collection of personal [pi](https://pi.dev) extensions. Each directory under `packages/` is an npm package published on its own.

English | [简体中文](README_zh.md)

| Package | What it does |
| --- | --- |
| [`pi-timeline`](packages/timeline) | Message timeline: lists a session's message nodes and jumps to one precisely |
| [`pi-tool-display`](packages/tool-display) | Density of tool call rendering: mini/low/medium/default |
| [`pi-thinking-display`](packages/thinking-display) | Keeps only the thinking block that is currently streaming, plus fold markers, hover highlight and click to expand |
| [`pi-token-meter`](packages/token-meter) | Live token metering on the working line and a settlement line per turn |

## Development

```bash
cd packages/<name>
node test/run.mjs       # tests (run against an isolated copy)
```
