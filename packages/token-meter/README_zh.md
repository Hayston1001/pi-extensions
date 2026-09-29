# pi-token-meter

[English](README.md) | 简体中文

## 这是什么

pi 的会话 token 计量插件. 支持实时显示数字变化, 支持一轮结束时显示结算行(不会进入模型上下文).

工作行(spinner旁):

```
── ⠋ ↓1.2k 45tok/s 12s ──────────────────────────
```

结算行:

```
↑286k ↓1.2k R13.4M W1.2M 57tok/s 3m32s · claude-opus-5 (high) $20.16
```

> [!TIP] 符号注解
> `↑输入` input(未缓存输入)  
> `↓输出` output(含思考 token)  
> `R/W` 缓存读/缓存写(非零时显示)  
> `模型名` 模型 ID(与 pi 模型列表/底栏显示一致)  
> `金额` 按模型价目表(每百万 token 单价, 支持分档定价, 1h 缓存写加倍)计算, 与 pi 底栏的花费统计同源同口径  
> `tok/s` 输出 token ÷ 纯生成时长. 生成时长按每个模型调用"首个输出 token → 结束" 累计, 不含首 token 等待与工具执行  
> `本轮耗时` 一轮对话的完整墙钟时间, 从发出消息那一刻算到本轮落定  
> `估算机制` provider 在流式过程中上报 usage 时直接采信; 未上报前, 输入侧按"上下文规模 - 上次缓存前缀"拆分 input/缓存读估算, 输出侧按已生成内容估算(CJK ≈ 0.9 token/字, 其余 ≈ 4 字符/token, 每条工具调用 +40 结构开销, 已用真实 provider 用量标定, 平均误差 ≈ 10%). `message_end` 后一律以 provider 的最终数字覆盖估算, 因此结算行即最终口径, 与账单精确一致

### 特色

- **动态计数**: ↑输入 / ↓输出 / R/W 缓存 / $ 金额 / 速度 / 耗时, 实时增长
- **箭头动画预设**: **常亮**(哪个数字在变哪个箭头亮, 否则灰色), **闪烁**(变化中的箭头按帧闪烁), **合并**(默认; 两路合并成一个槽位, 只显示正在变化的那一路).
- **等待计时**: 消息发出后在 pi 的 working 行后面跟上本轮计时(`Working 12s`), 模型一开始返回就换成完整动态行; 关掉「显示耗时」后等待计时也一并隐藏
- **轮次结算**: 一轮 = 从发出消息到完全落定(自动重试 / 压缩续跑 / 排队消息都在内). 结束后在对话末尾写一行结算
- **完整口径**: 一轮内所有模型调用累加; 工具内嵌套模型调用(子代理等), 自动压缩的摘要生成消耗一并计入; 中断 / 报错时已消耗的部分照常结算
- **配置可视化**: `/token-meter-settings` 唤起与原生 `/settings` 同风格的设置面板

> [!NOTE] 限制
> 流式过程中的数字是估算或增量上报值, 最终以轮次结算为准(结算值与 provider 账单精确一致)  
> 闲时缓存预热(cache warming)发生在轮次之外, 不计入本轮; 它会计入 pi 自带的会话总统计  
> 模型未配置价目(`cost` 为 0)时金额显示为 `$0`, token 计数不受影响

## 如何安装

```bash
pi install npm:@hayston/pi-token-meter
pi install -e npm:@hayston/pi-token-meter     # 一次性试用
```

## 配置文件

> [!TIP]
> 使用 `/token-meter-settings` 命令打开可视化设置面板

位于 `~/.pi/agent/token-meter.json`

**全局**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `animation` | 字符串 | `"merge"` | `steady` 常亮/`blink` 闪烁/`merge` 合并 |
| `live` | 布尔 | `true` | 动态行显示 |
| `resultInTranscript` | 布尔 | `true` | 结算行显示 |
| `refreshMs` | 数字 | `120` | 动态刷新间隔(80/120/200/320/500ms) |
| `language` | 字符串 | `"auto"` | `"auto"`/`"zh"`/`"en"` |

**动态行显示项**(子菜单)

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `liveShowArrows` | 布尔 | `true` | ↑↓ |
| `liveShowCache` | 布尔 | `false` | 缓存读/缓存写 |
| `liveShowCost` | 布尔 | `false` | 预估金额 |
| `liveShowTps` | 布尔 | `true` | 速度(tok/s) |
| `liveShowDuration` | 布尔 | `true` | 本轮完整耗时 |
| `liveShowModel` | 布尔 | `false` | 模型 ID |
| `liveShowThinking` | 布尔 | `false` | 思考强度 |

**结算行显示项**(子菜单)

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `showArrows` | 布尔 | `true` | ↑↓ |
| `showCache` | 布尔 | `true` | 缓存读/缓存写 |
| `showCost` | 布尔 | `true` | 预估金额 |
| `showTps` | 布尔 | `true` | 速度(tok/s) |
| `showDuration` | 布尔 | `true` | 本轮耗时 |
| `showModel` | 布尔 | `true` | 模型 ID |
| `showThinking` | 布尔 | `true` | 思考强度 |

> [!WARNING]
> 字段缺失, 类型不对, JSON 写坏都会退回默认值, 刷新间隔也会吸附到档位, 坏配置不会拖垮会话  
> `language` 每次打开面板时重新解析. 在面板里改 **Language** 会立即用新语言重开面板 

## 开发

```bash
node test/run.mjs           # 全部
node test/run.mjs unit      # 文案, 配置, 计量, 格式化, 面板, 事件接线
node test/run.mjs lifecycle # 真 AgentSession: 发现扩展, 注册结果, /reload
```
