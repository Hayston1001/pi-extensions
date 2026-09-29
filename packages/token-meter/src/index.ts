/**
 * token-meter · 会话 token 计量显示
 *
 * 一轮 = 从用户发出消息(before_agent_start)到完全落定(agent_settled)之间,
 * 中间的所有模型调用, 工具内嵌套调用, 上下文压缩消耗都会累计进来.
 */

import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getLastAssistantUsage } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ensureConfigFile, loadConfig, saveConfig, type TokenMeterConfig } from "./config.ts";
import { messages } from "./i18n.ts";
import { Meter, type PromptEstimate, type RoundSummary, type RoundOutcome } from "./meter.ts";
import { LiveCounter, buildResultLine, formatDuration } from "./render.ts";
import { openSettingsDialog, openSettingsPanel, statusText } from "./panel.ts";

const STATUS_KEY = "token-meter";
const ENTRY_TYPE = "token-meter.summary";
const SETTLE_DEBOUNCE_MS = 700;
const MAX_SETTLE_POSTPONES = 300;

/**
 * pi 自带的 working 行文案(默认 "Working"). 
 *
 * 我们要在这个词后面跟上本轮计时, 但 pi 没有暴露"读取当前 working 文案"的接口
 * (`setWorkingMessage(undefined)` 只会恢复这个默认值), 所以只能自己复刻一份. 
 * 固定英文, 不进 i18n: 它是 pi 的文案, 跟斜杠命令描述一样, 不该随界面语言变. 
 */
const PI_WORKING_MESSAGE = "Working";

type Role = { role?: string };

function asAssistant<T>(m: T): AssistantMessage | undefined {
	return (m as Role)?.role === "assistant" ? (m as unknown as AssistantMessage) : undefined;
}

function toolResultUsage<T>(m: T): Usage | undefined {
	return (m as Role)?.role === "toolResult" ? (m as unknown as { usage?: Usage }).usage : undefined;
}

export default function tokenMeter(pi: ExtensionAPI) {
	const meter = new Meter();
	const counter = new LiveCounter();
	let cfg: TokenMeterConfig = loadConfig();

	let lastCtx: ExtensionContext | undefined;
	let currentModel: Model<any> | undefined;
	let promptEstimate: PromptEstimate = { input: 0, cacheRead: 0, cacheWrite: 0 };
	let ticker: ReturnType<typeof setInterval> | undefined;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let settlePostpones = 0;

	// ---------------------------------------------------------------- 显示

	function paintLive(): void {
		const ctx = lastCtx;
		if (!ctx || !meter.active || !cfg.live) return;
		const totals = meter.liveTotals();
		if (totals.totalTokens === 0 && totals.cost === 0) {
			// 模型还没开始返回: 先在 pi 的 working 文案后面跟上本轮计时
			// (等首 token 到达, 再用完整动态行把整行换掉; 关掉"显示耗时"就直接把 working 交还给 pi)
			if (ctx.mode === "tui") {
				if (cfg.liveShowDuration) {
					// working 文案的颜色是"思考强度边框色"(跟编辑器边框同色, 随思考强度变), 
					// 所以前缀用同一个上色函数, 计时自己套 muted -- 与动态行里耗时的颜色一致. 
					const border = ctx.ui.theme.getThinkingBorderColor(pi.getThinkingLevel());
					const timer = ctx.ui.theme.fg("muted", formatDuration(meter.elapsedMs()));
					ctx.ui.setWorkingMessage(`${border(PI_WORKING_MESSAGE)} ${timer}`);
				} else {
					ctx.ui.setWorkingMessage(undefined);
				}
			}
			return;
		}
		counter.tick(totals);
		const info = meter.currentInfo();
		const line = counter.render(ctx.ui.theme, cfg, {
			tps: meter.tps(),
			elapsedMs: meter.elapsedMs(),
			totals,
			model: info?.model.id,
			thinkingLevel: info?.thinkingLevel,
		});
		// 工作行(spinner 旁)是主展示位; RPC 等无工作行的模式用状态条兜底
		if (ctx.mode === "tui") ctx.ui.setWorkingMessage(line);
		else ctx.ui.setStatus(STATUS_KEY, line);
	}

	function startTicker(): void {
		stopTicker();
		if (!cfg.live) return;
		ticker = setInterval(paintLive, cfg.refreshMs);
	}

	function stopTicker(): void {
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
	}

	function clearDisplay(ctx: ExtensionContext | undefined): void {
		if (!ctx) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (ctx.mode === "tui") ctx.ui.setWorkingMessage(undefined);
	}

	function showResult(summary: RoundSummary): void {
		// 结果只写入对话末尾, 底部不重复显示
		clearDisplay(lastCtx);
		if (cfg.resultInTranscript) {
			pi.appendEntry(ENTRY_TYPE, summary as unknown as Record<string, unknown>);
		}
	}

	// ---------------------------------------------------------------- 结算

	function noteActivity(): void {
		settlePostpones = 0;
		if (settleTimer !== undefined) {
			clearTimeout(settleTimer);
			settleTimer = undefined;
		}
	}

	function scheduleSettle(): void {
		if (settleTimer !== undefined) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			const ctx = lastCtx;
			// 自动重试 / 压缩续跑 / 排队消息期间不算一轮结束
			if (ctx && !ctx.isIdle() && settlePostpones < MAX_SETTLE_POSTPONES) {
				settlePostpones++;
				scheduleSettle();
				return;
			}
			settleRound();
		}, SETTLE_DEBOUNCE_MS);
	}

	function settleRound(): void {
		if (settleTimer !== undefined) {
			clearTimeout(settleTimer);
			settleTimer = undefined;
		}
		if (!meter.active) return;
		stopTicker();
		const summary = meter.endRound();
		counter.reset();
		if (!summary) {
			clearDisplay(lastCtx);
			return;
		}
		showResult(summary);
	}

	function mapOutcome(o: string): RoundOutcome {
		return o === "aborted" || o === "error" || o === "deferred" ? o : "completed";
	}

	/**
	 * 输入侧估算(与 pi 底栏口径对齐): 上一请求的前缀可复用为缓存命中,
	 * 未上报前按 上下文规模 - 上次前缀 拆分 input / cacheRead.
	 */
	function estimatePrompt(ctx: ExtensionContext): PromptEstimate {
		const promptSide = ctx.getContextUsage()?.tokens ?? 0;
		const last = getLastAssistantUsage(ctx.sessionManager.getBranch());
		const lastPrompt = last ? (last.input ?? 0) + (last.cacheRead ?? 0) + (last.cacheWrite ?? 0) : 0;
		const cacheActive = !!last && ((last.cacheRead ?? 0) > 0 || (last.cacheWrite ?? 0) > 0);
		const cacheRead = cacheActive ? Math.min(lastPrompt, promptSide) : 0;
		return { input: Math.max(0, promptSide - cacheRead), cacheRead, cacheWrite: 0 };
	}

	// ---------------------------------------------------------------- 事件

	pi.on("session_start", (_event, ctx) => {
		// 首次使用时落一份默认配置(让用户找得到这个文件); 只读目录等场景静默降级
		try {
			ensureConfigFile();
		} catch {
			/* 配置落不了盘不影响会话 */
		}
		lastCtx = ctx;
		noteActivity();
		stopTicker();
		meter.abandonRound();
		counter.reset();
		clearDisplay(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		noteActivity();
		stopTicker();
		meter.abandonRound();
		clearDisplay(ctx);
	});

	pi.on("before_agent_start", () => {
		// 用户发出消息: 本轮耗时的起点(比 agent 启动更早)
		meter.markPromptSubmitted();
		noteActivity();
	});

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		noteActivity();
		meter.beginRound();
		counter.reset();
		currentModel = ctx.model;
		clearDisplay(ctx);
		startTicker();
	});

	pi.on("turn_start", (_event, ctx) => {
		lastCtx = ctx;
		noteActivity();
		meter.beginRound();
		meter.markTurn();
	});

	pi.on("message_start", (event, ctx) => {
		lastCtx = ctx;
		noteActivity();
		const assistant = asAssistant(event.message);
		if (!assistant) return;
		meter.beginRound();
		const id = assistant.model ?? ctx.model?.id ?? "unknown";
		// 显示名与 pi 模型列表 / 底栏一致: 用模型 ID
		meter.beginAssistantMessage({ id, name: id }, pi.getThinkingLevel());
		currentModel = ctx.model;
		promptEstimate = estimatePrompt(ctx);
	});

	pi.on("message_update", (event) => {
		const assistant = asAssistant(event.message);
		if (!assistant) return;
		noteActivity();
		meter.updatePartial(assistant, promptEstimate, currentModel);
	});

	pi.on("message_end", (event, ctx) => {
		lastCtx = ctx;
		const assistant = asAssistant(event.message);
		if (assistant) {
			meter.endAssistantMessage(assistant, currentModel);
			return;
		}
		const toolUsage = toolResultUsage(event.message);
		if (toolUsage) meter.foldToolUsage(toolUsage);
	});

	pi.on("turn_end", (event) => {
		meter.recordOutcome(mapOutcome(event.outcome));
	});

	pi.on("agent_before_settle", (event) => {
		meter.recordOutcome(mapOutcome(event.outcome));
		// 还有排队消息 / 明确要求继续: 一轮尚未结束
		if (event.continue || (event.context?.pendingMessages?.length ?? 0) > 0) noteActivity();
	});

	pi.on("agent_end", () => {
		scheduleSettle();
	});

	pi.on("agent_settled", () => {
		settleRound();
	});

	pi.on("session_before_compact", (event) => {
		if (event.willRetry) noteActivity();
	});

	pi.on("session_compact", (event) => {
		const usage = (event.compactionEntry as { usage?: Usage } | undefined)?.usage;
		meter.foldCompactionUsage(usage);
		if (event.willRetry) noteActivity();
	});

	pi.on("model_select", (event) => {
		currentModel = event.model;
	});

	// ---------------------------------------------------------------- 对话区结算行

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme: Theme): Component | undefined => {
		const summary = entry.data as RoundSummary | undefined;
		if (!summary || !summary.totals) return undefined;
		const line = buildResultLine(summary, cfg, theme);
		return {
			render(width: number): string[] {
				return [truncateToWidth(line, width, theme.fg("dim", "..."))];
			},
			invalidate(): void {},
		};
	});

	// ---------------------------------------------------------------- 命令

	const applyLive = (ctx: ExtensionCommandContext): void => {
		saveConfig(cfg);
		// 刷新频率 / 动态开关变化立即生效
		if (meter.active) {
			counter.reset();
			if (cfg.live) startTicker();
			else {
				stopTicker();
				if (ctx.mode === "tui") ctx.ui.setWorkingMessage(undefined);
			}
			paintLive();
		}
	};

	const openSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
		// 按能力分派: TUI 开面板; 有 UI 但没自定义组件(RPC)逐项询问; 没界面只报当前设置
		if (!ctx.hasUI) {
			ctx.ui.notify(statusText(cfg, messages(cfg.language)), "info");
			return;
		}
		if (ctx.mode !== "tui") {
			await openSettingsDialog(ctx, cfg, () => applyLive(ctx));
			return;
		}
		// 语言换了就用新语言重开面板(循环, 不是递归 -- 递归会把栈越堆越深)
		for (;;) {
			const result = await openSettingsPanel(ctx, cfg, () => applyLive(ctx));
			if (!result?.languageChanged) return;
		}
	};

	// 命令描述固定成英文的 "<扩展名> Settings(<配置文件>)", 不参与 i18n(斜杠命令的约定)
	pi.registerCommand("token-meter-settings", {
		description: "Token Meter Settings(token-meter.json)",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			// 参数一律不解析(不做文本通道): 带了只给一句用法提示, 绝不改变配置
			if (args.trim() !== "") {
				ctx.ui.notify(messages(cfg.language).usageHint, "warning");
				return;
			}
			await openSettings(ctx);
		},
	});
}
