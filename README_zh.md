# pi-extensions

个人 [pi](https://pi.dev) 扩展集合. `packages/` 下每个目录就是一个独立发布的 npm 包.

[English](README.md) | 简体中文

| 包 | 作用 |
| --- | --- |
| [`pi-timeline`](packages/timeline) | 消息时间线: 列出会话的消息节点, 精确跳转  |
| [`pi-tool-display`](packages/tool-display) | 工具调用展示密度: mini/low/medium/default |
| [`pi-thinking-display`](packages/thinking-display) | 只保留正在流式输出的 thinking 段, 以及折叠标记, 悬停高亮与点击展开 |
| [`pi-token-meter`](packages/token-meter) | token 工作行实时计量与单轮结算行展示 |

## 开发

```bash
cd packages/<包名>
node test/run.mjs       # 测试(跑在隔离副本上)
```
