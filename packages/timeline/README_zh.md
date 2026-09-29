# pi-timeline

[English](README.md) | 简体中文

## 这是什么

为解决 pi 中长对话无法便捷跳转节点而打造的消息时间线概览, 可列出会话里的用户消息(含 `!` shell 命令), 输入关键字过滤, 选中后精准滚动 transcript 视口

> [!IMPORTANT]
> 必须使用 **TUI 模式**

## 如何使用

| 按键 | 作用 |
| --- | --- |
| `alt+h`(可自定义) | 打开消息列表 |
| 直接输入 | 过滤消息 |
| `↑`/`↓`(或 `PgUp`/`PgDn`) | 移动选中项 |
| `Enter` | 跳转 |
| `Ctrl+Enter` | 把消息原文放进输入框 |
| `Esc` | 关闭 |

> [!TIP]
> `/timeline-settings` 打开设置面板

> [!NOTE] 落脚点
> `user` 用户消息  
> `reply` 最终回答

> [!WARNING]
> 不合法的快捷键会被拒绝. 不带修饰键的键只有命名键(如 `f2`)才放行.

## 如何安装

```sh
pi install npm:pi-timeline
pi -e npm:pi-timeline             # 一次性试用
```

## 配置文件

位于 `~/.pi/agent/timeline.json`

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `shortcut` | 字符串/字符串数组/null | `"alt+h"` | 大小写不敏感, 自动去重 |
| `jumpTo` | 字符串 | `"user"` | `"user"`/`"reply"` |
| `language` | 字符串 | `"auto"` | `"auto"`/`"zh"`/`"en"` |

> [!WARNING]
> 值不合法时退回默认值, 并在会话启动时弹警告.`jumpTo` 每次调用都重读, 改完立即生效; 快捷键在加载期注册, 改动要 `/reload`.

## 开发

```sh
node test/run.mjs                # 全部测试
node test/run.mjs unit config    # 指定测试集: unit | real | config
```
