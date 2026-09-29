/**
 * token-meter · 计量引擎
 * 
 * 估算规则: provider 在流式过程中上报 usage 时直接采信; 未上报前,
 * 输入侧用请求时刻的上下文估算值, 输出侧用已生成内容按
 * "CJK ≈ 1 token/字, 其余 ≈ 4 字符/token" 保守估算.
 * message_end 时以 provider 的最终 usage 为准覆盖估算值.
 * 
 */

import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";

export type RoundOutcome = "completed" | "aborted" | "error" | "deferred";

export interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	/** true = 其中至少有一部分是估算值(provider 未给出精确数字) */
	estimated: boolean;
}

export interface ModelUse {
	id: string;
	name: string;
}

export interface MessageRecord {
	model: ModelUse;
	thinkingLevel: string;
	/** provider 最终上报的用量(message_end 时写入) */
	real: Totals | null;
	/** 实时估算 / 上报值(流式过程中滚动更新) */
	live: Totals;
	stopReason: string;
	/** 模型调用开始(发出请求) */
	startedAt: number;
	/** 首个输出 token 到达时刻(生成起点) */
	firstTokenAt?: number;
	endedAt?: number;
}

/** 未上报前的输入侧估算(与 pi 底栏口径对齐: input / cacheRead / cacheWrite 分开) */
export interface PromptEstimate {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface RoundSummary {
	totals: Totals;
	/** 本轮内使用的模型(按出现顺序去重) */
	models: ModelUse[];
	/** 本轮内出现过的思考强度(按出现顺序去重) */
	thinkingLevels: string[];
	outcome: RoundOutcome;
	turns: number;
	messages: number;
	/** 本轮完整耗时: 用户发出消息到本轮落定(墙钟时间, 与 genMs 的纯生成时长不同) */
	durationMs: number;
	/** 纯生成时长合计(各模型调用从首个输出 token 到结束, 不含工具执行) */
	genMs: number;
	/** 生成速度 = 输出 token ÷ genMs(tok/s) */
	tps: number;
	/** 工具内嵌套模型调用的用量(token/cost 已并入 totals) */
	toolUsage: Totals | null;
	/** 本轮内发生过上下文压缩 */
	compacted: boolean;
}

export function emptyTotals(): Totals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, estimated: false };
}

export function usageToTotals(u: Usage | undefined): Totals {
	if (!u) return emptyTotals();
	return {
		input: u.input ?? 0,
		output: u.output ?? 0,
		cacheRead: u.cacheRead ?? 0,
		cacheWrite: u.cacheWrite ?? 0,
		totalTokens: u.totalTokens ?? 0,
		cost: u.cost?.total ?? 0,
		estimated: false,
	};
}

export function addTotals(target: Totals, other: Totals): void {
	target.input += other.input;
	target.output += other.output;
	target.cacheRead += other.cacheRead;
	target.cacheWrite += other.cacheWrite;
	target.totalTokens += other.totalTokens;
	target.cost += other.cost;
	target.estimated = target.estimated || other.estimated;
}

function cloneTotals(t: Totals): Totals {
	return { ...t };
}

/** 输入侧总量(↑ 的口径) */
export function promptSide(t: Totals): number {
	return t.input + t.cacheRead + t.cacheWrite;
}

/**
 * 输出 token 估算(已用真实 provider 用量标定, 平均绝对误差 ≈ 10%):
 * CJK 字符 ≈ 0.9 token/字, 其余 ≈ 4 字符/token, 每条工具调用加 40 token 结构开销
 * (provider 对函数调用的序列化计费远高于裸字符数).
 * 仅用于 provider 未上报前的实时显示; 结算一律以真实 usage 为准.
 */
export function estimateOutputTokens(m: AssistantMessage): number {
	let cjk = 0;
	let other = 0;
	let toolCalls = 0;
	const count = (s: string) => {
		for (const ch of s) {
			const cp = ch.codePointAt(0)!;
			if (
				(cp >= 0x4e00 && cp <= 0x9fff) ||
				(cp >= 0x3400 && cp <= 0x4dbf) ||
				(cp >= 0x3000 && cp <= 0x303f) ||
				(cp >= 0xff00 && cp <= 0xffef) ||
				(cp >= 0x3040 && cp <= 0x30ff)
			) {
				cjk++;
			} else {
				other++;
			}
		}
	};
	for (const block of m.content ?? []) {
		if (block.type === "text") count(block.text);
		else if (block.type === "thinking") count(block.thinking);
		else if (block.type === "toolCall") {
			toolCalls++;
			count(block.name);
			try {
				count(JSON.stringify(block.arguments));
			} catch {
				// 参数无法序列化时忽略, 估算值影响甚微
			}
		}
	}
	return Math.ceil(cjk * 0.9 + other / 4 + toolCalls * 40);
}

/**
 * 计算花费(USD). 与 pi-ai 的 calculateCost 同口径:
 * 价目表为每百万 token 单价, 支持按输入量分档; 1 小时缓存写按 2 倍输入计价.
 */
export function computeCost(model: Model<any> | undefined, t: Totals, cacheWrite1h = 0): number {
	const cost = model?.cost;
	if (!cost) return 0;
	const inputTokens = t.input + t.cacheRead + t.cacheWrite;
	let rates = cost;
	let matched = -1;
	for (const tier of cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
			rates = tier;
			matched = tier.inputTokensAbove;
		}
	}
	const longWrite = Math.min(cacheWrite1h, t.cacheWrite);
	const shortWrite = t.cacheWrite - longWrite;
	return (
		(rates.input / 1e6) * t.input +
		(rates.output / 1e6) * t.output +
		(rates.cacheRead / 1e6) * t.cacheRead +
		(rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1e6
	);
}

interface RoundState {
	/** 本轮起点: 用户发出消息的时刻(见 markPromptSubmitted), 早于 agent 启动 */
	startedAt: number;
	turns: number;
	messages: MessageRecord[];
	current: MessageRecord | null;
	toolUsage: Totals | null;
	compacted: boolean;
	outcome: RoundOutcome;
	models: ModelUse[];
	thinkingLevels: string[];
}

/** 轮次计量器: 一轮 = 从用户发出消息到完全落定(含自动重试, 压缩续跑, 排队消息) */
export class Meter {
	private round: RoundState | null = null;
	/** 用户发出消息的时刻, 留作下一轮耗时的起点 */
	private promptAt: number | null = null;

	get active(): boolean {
		return this.round !== null;
	}

	/**
	 * 用户发出消息(before_agent_start): 本轮耗时的起点, 比 agent 启动更早, 
	 * 中间的排队与提示词准备都算进"一轮对话的完整时间".
	 */
	markPromptSubmitted(): void {
		// 已有一轮在跑(排队消息并入本轮): 不动起点, 一轮按第一个消息算
		if (this.round) return;
		this.promptAt = Date.now();
	}

	/** 本轮已耗时(毫秒): 用户发出消息到现在的墙钟时间 */
	elapsedMs(): number {
		return this.round ? Date.now() - this.round.startedAt : 0;
	}

	beginRound(): void {
		if (this.round) return;
		this.round = {
			startedAt: this.promptAt ?? Date.now(),
			turns: 0,
			messages: [],
			current: null,
			toolUsage: null,
			compacted: false,
			outcome: "completed",
			models: [],
			thinkingLevels: [],
		};
	}

	/** 放弃当前轮(切会话等场景), 返回是否确有进行中的轮次 */
	abandonRound(): boolean {
		const had = this.round !== null;
		this.round = null;
		this.promptAt = null;
		return had;
	}

	beginAssistantMessage(model: ModelUse, thinkingLevel: string): void {
		if (!this.round) this.beginRound();
		const round = this.round!;
		round.current = {
			model,
			thinkingLevel,
			real: null,
			live: emptyTotals(),
			stopReason: "pending",
			startedAt: Date.now(),
		};
		round.messages.push(round.current);
		pushUnique(round.models, model, (m) => m.id);
		pushUnique(round.thinkingLevels, thinkingLevel, (l) => l);
	}

	/**
	 * 流式更新: 上报值优先, 未上报部分用估算值补齐.
	 * promptEstimate 为请求时刻的输入侧估算(已按缓存命中拆分).
	 */
	updatePartial(partial: AssistantMessage, promptEstimate: PromptEstimate, model: Model<any> | undefined): void {
		const cur = this.round?.current;
		if (!cur) return;
		if (cur.firstTokenAt === undefined) cur.firstTokenAt = Date.now();
		const u = partial.usage;
		const reportedPrompt = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
		const live = cur.live;
		let estimated = false;
		if (reportedPrompt > 0) {
			live.input = u!.input ?? 0;
			live.cacheRead = u!.cacheRead ?? 0;
			live.cacheWrite = u!.cacheWrite ?? 0;
		} else {
			live.input = Math.max(0, promptEstimate.input);
			live.cacheRead = Math.max(0, promptEstimate.cacheRead);
			live.cacheWrite = Math.max(0, promptEstimate.cacheWrite);
			estimated = true;
		}
		if ((u?.output ?? 0) > 0) {
			live.output = u!.output;
		} else {
			live.output = Math.max(live.output, estimateOutputTokens(partial));
			estimated = true;
		}
		live.estimated = estimated;
		live.totalTokens = promptSide(live) + live.output;
		live.cost = (u?.cost?.total ?? 0) > 0 ? u!.cost.total : computeCost(model, live, u?.cacheWrite1h);
	}

	/** assistant 消息结束: provider 的最终 usage 覆盖估算 */
	endAssistantMessage(final: AssistantMessage, model: Model<any> | undefined): void {
		const cur = this.round?.current;
		if (!cur) return;
		cur.stopReason = final.stopReason ?? "stop";
		cur.endedAt = Date.now();
		if (cur.firstTokenAt === undefined) cur.firstTokenAt = cur.endedAt;
		const u = final.usage;
		const hasReal = !!u && (u.totalTokens > 0 || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) > 0);
		if (hasReal) {
			const t = usageToTotals(u);
			// provider 只报输出不报输入(部分 OpenAI 兼容端)时保留输入侧估算
			if (t.input + t.cacheRead + t.cacheWrite === 0 && cur.live.estimated) {
				t.input = cur.live.input;
				t.cacheRead = cur.live.cacheRead;
				t.cacheWrite = cur.live.cacheWrite;
				t.estimated = true;
			}
			if (t.cost === 0) t.cost = computeCost(model, t, u?.cacheWrite1h);
			cur.real = t;
		} else {
			// 中断 / 错误时 provider 可能不报用量: 沿用估算并标记
			const t = cloneTotals(cur.live);
			t.estimated = true;
			t.cost = computeCost(model, t);
			cur.real = t;
		}
		cur.live = cloneTotals(cur.real);
		if (final.stopReason === "aborted") this.recordOutcome("aborted");
		else if (final.stopReason === "error") this.recordOutcome("error");
		else if (final.stopReason === "deferred") this.recordOutcome("deferred");
	}

	/** 工具内部嵌套模型调用的用量(如子代理), 并入本轮 */
	foldToolUsage(u: Usage | undefined): void {
		if (!u || !this.round) return;
		const t = usageToTotals(u);
		if (t.totalTokens === 0 && t.cost === 0 && t.input + t.output === 0) return;
		if (!this.round.toolUsage) this.round.toolUsage = emptyTotals();
		addTotals(this.round.toolUsage, t);
	}

	/** 一轮内发生压缩时并入其消耗 */
	foldCompactionUsage(u: Usage | undefined): void {
		if (!this.round) return;
		this.round.compacted = true;
		if (!u) return;
		const t = usageToTotals(u);
		if (t.totalTokens === 0 && t.cost === 0) return;
		if (!this.round.toolUsage) this.round.toolUsage = emptyTotals();
		addTotals(this.round.toolUsage, t);
	}

	markTurn(): void {
		if (this.round) this.round.turns++;
	}

	recordOutcome(outcome: RoundOutcome): void {
		if (!this.round) return;
		// 优先级: 错误 > 中断 > 延迟 > 完成; 保留更严重的状态
		const rank: Record<RoundOutcome, number> = { completed: 0, deferred: 1, aborted: 2, error: 3 };
		if (rank[outcome] > rank[this.round.outcome]) this.round.outcome = outcome;
	}

	/** 各模型调用的纯生成时长合计(当前消息未结束时实时累计) */
	private genMsSoFar(): number {
		const round = this.round;
		if (!round) return 0;
		const now = Date.now();
		let ms = 0;
		for (const m of round.messages) {
			ms += (m.endedAt ?? now) - (m.firstTokenAt ?? m.startedAt);
		}
		return ms;
	}

	/** 主模型输出 token(不含工具内嵌套调用, 与 genMs 同口径) */
	private assistantOutput(): number {
		const round = this.round;
		if (!round) return 0;
		let out = 0;
		for (const m of round.messages) {
			out += (m.real ?? m.live).output;
		}
		return out;
	}

	/** 实时生成速度(tok/s)= 输出 token ÷ 纯生成时长 */
	tps(): number {
		const ms = this.genMsSoFar();
		if (ms <= 0) return 0;
		return this.assistantOutput() / (ms / 1000);
	}

	/** 当前(或最近一条)assistant 消息的模型与思考强度, 供动态行显示 */
	currentInfo(): { model: ModelUse; thinkingLevel: string } | undefined {
		const cur = this.round?.current;
		if (!cur) return undefined;
		return { model: cur.model, thinkingLevel: cur.thinkingLevel };
	}

	/** 实时合计: 已定稿消息 + 当前消息的实时/估算值 */
	liveTotals(): Totals {
		const out = emptyTotals();
		const round = this.round;
		if (!round) return out;
		for (const m of round.messages) {
			addTotals(out, m.real ?? m.live);
		}
		if (round.toolUsage) addTotals(out, round.toolUsage);
		return out;
	}

	/** 结束本轮并返回汇总(无消息且无消耗时返回 null, 不打扰用户) */
	endRound(): RoundSummary | null {
		const round = this.round;
		this.round = null;
		this.promptAt = null;
		if (!round) return null;
		const totals = emptyTotals();
		for (const m of round.messages) addTotals(totals, m.real ?? m.live);
		if (round.toolUsage) addTotals(totals, round.toolUsage);
		const now = Date.now();
		let genMs = 0;
		let assistantOutput = 0;
		for (const m of round.messages) {
			genMs += (m.endedAt ?? now) - (m.firstTokenAt ?? m.startedAt);
			assistantOutput += (m.real ?? m.live).output;
		}
		const summary: RoundSummary = {
			totals,
			models: round.models,
			thinkingLevels: round.thinkingLevels,
			outcome: round.outcome,
			turns: round.turns,
			messages: round.messages.length,
			durationMs: now - round.startedAt,
			genMs,
			tps: genMs > 0 ? assistantOutput / (genMs / 1000) : 0,
			toolUsage: round.toolUsage ? cloneTotals(round.toolUsage) : null,
			compacted: round.compacted,
		};
		if (totals.totalTokens === 0 && totals.cost === 0 && round.messages.length === 0) return null;
		return summary;
	}
}

function pushUnique<T>(arr: T[], item: T, key: (t: T) => string): void {
	if (arr.some((x) => key(x) === key(item))) return;
	arr.push(item);
}
