# pi-tool-display

[English](README.md) | 简体中文

## 这是什么

一个让 pi 的工具调用按你想要的信息密度显示的插件

> [!IMPORTANT]
> 鼠标交互功能需要 `TUI mode`, 其余功能无要求

## 如何使用

| 档位 | 样式 |
| --- | --- |
| `mini` | 整批调用收成一行汇总: 全成功是 `✓ 5 tools`, 有失败是 `✕ 3 tools`, 还在跑是 `⋯ 2/5 tools` |
| `low` | 和 mini 类似, 但会显示工具名, 支持超过设置的数量后缩略为 `+N` |
| `medium` | 和原版类似, 但不显示输出, 而是保留一行摘要: 条目数, 耗时, 时限. 调用失败的错误会被显示 |
| `default` | 原生 pi 的样式 |

> [!TIP]
> 使用 `mini`/`low` 档位时支持点击展开, 且可以自定义展开到何种程度

### 特色

- **hover 高亮**: 鼠标移入时高亮显示

## 如何安装

```bash
pi install npm:@hayston/pi-tool-display
pi install -e npm:@hayston/pi-tool-display   # 一次性试用
```

## 配置文件

位于 `~/.pi/agent/tool-display.json`

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `display` | `"mini"/"low"/"medium"/"default"` | `"mini"` | 档位 |
| `hoverHighlight` | boolean | `true` | 鼠标所在行提亮(仅 TUI) |
| `expandStyle` | `"medium"/"default"` | `"medium"` | `mini`/`low` 展开时什么样式 |
| `low.nameLimit` | number | `3` | `low` 行最多列几个工具名, 其余收成 `+N` |
| `medium.showErrorLine` | boolean | `true` | `medium` 调用失败时多一行错误摘要 |

> [!WARNING]
> 字段缺了, 类型不对, JSON 写坏了, 都退回默认值, 所以坏配置不会把渲染搞崩. 手改完在下次 `/reload` 或开新会话时生效. 

## 开发

```bash
node test/run.mjs          # 两个测试集
node test/run.mjs unit     # 档位, 汇总行, hover, 设置命令
node test/run.mjs reload   # /reload 前后的注册时机
```
