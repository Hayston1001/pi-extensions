# pi-thinking-display

[English](README.md) | 简体中文

## 这是什么

让 pi 的 thinking 块在流式生成时保持展开, 结束后自动折叠的扩展.

> [!IMPORTANT]
> 自动折叠在 `regular mode` 正常生效  
> 但部分功能如 hover/点击展开需要 `TUI mode`

### 特色

- **流式折叠**: 助手消息生成过程中, 正在输出的 thinking 块保持展开. 一旦后面开始出现可见内容就自动收起
- **鼠标交互**: thinking 块展示折叠标记; 指针悬停时高亮, 点击可展开/收起

> [!NOTE]
> 尊重 pi 原生 `Ctrl+T` 展开 thinking 块的行为且不会主动覆盖

## 如何安装

```bash
pi install npm:pi-thinking-display
pi install -e npm:pi-thinking-display     # 一次性试用
```

## 配置文件

> [!TIP]
> 使用 `/thinking-display-settings` 命令打开可视化设置面板

位于 `~/.pi/agent/thinking-display.json`

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `streaming` | boolean | `true` | 仅流式输出的 thinking 块展开 |
| `decorate` | boolean | `true` | 启用折叠标记, hover 高亮 |

> [!WARNING]
> 字段缺失, 类型不对, JSON 写坏都会退回默认值, 坏配置不会把渲染搞崩. 手改文件后下次 `/reload` 或新会话生效.

## 开发

```bash
node test/run.mjs           # 全部
node test/run.mjs unit      # 配置, 流式规则, 标记/hover/点击, 设置面板
node test/run.mjs lifecycle # 真 AgentSession: 发现扩展, 配置生效时机, /reload
```
