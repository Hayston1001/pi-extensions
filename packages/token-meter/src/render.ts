/**
 * token-meter · 渲染与格式化
 * 界面上会出现的文字(模型未知时的占位)走 i18n.ts, 按 config.language 解析
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TokenMeterConfig } from "./config.ts";
import { messages } from "./i18n.ts";
import type { RoundSummary, Totals } from "./meter.ts";

/** 紧凑数字: 12.3k / 456k / 1.2M */
export function formatTokens(n: number): string {
	const v = Math.max(0, Math.round(n));
	if (v < 1000) return `${v}`;
	if (v < 10_000) return `${(v / 1000).toFixed(1)}k`;
	if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
	return `${(v / 1_000_000).toFixed(1)}M`;
}

/** 金额: 有效数字式, $0.000053 / $0.0042 / $0.043 / $0.43 / $4.3 */
export function formatCost(v: number): string {
	const x = Math.max(0, v);
	if (x === 0) return "$0";
	if (x < 0.01) return `$${x.toPrecision(2)}`;
	if (x < 0.1) return `$${x.toFixed(3)}`;
	if (x < 10) return `$${x.toFixed(2)}`;
	return `$${x.toFixed(1)}`;
}

/** 速度: 6.4tok/s / 45tok/s(数字与单位之间不留空格) */
export function formatTps(v: number): string {
	const x = Math.max(0, v);
	return `${x < 10 ? x.toFixed(1) : Math.round(x)}tok/s`;
}

/**
 * 本轮耗时: 复合两级, 单位自适应(如 `47s` / `3m32s` / `2h05m`). 
 * 低位不足两位补零, 低位为 0 就省掉(`3m`, `2h`). 
 */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	if (total < 3600) {
		const minutes = Math.floor(total / 60);
		const seconds = total % 60;
		return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
	}
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	return minutes > 0 ? `${hours}h${String(minutes).padStart(2, "0")}m` : `${hours}h`;
}

/** 模型显示: 与 pi 模型列表 / 底栏一致, 用模型 ID */
export function formatModels(summary: RoundSummary, unknownLabel: string): string {
	const ids = summary.models.map((m) => m.id);
	return ids.length <= 1 ? (ids[0] ?? unknownLabel) : ids.join("→");
}

/** 缓存段: R13.4M W1.2k(与 pi 底栏一致, 非零才显示) */
export function formatCache(t: Totals): string | undefined {
	if (t.cacheRead <= 0 && t.cacheWrite <= 0) return undefined;
	const parts: string[] = [];
	if (t.cacheRead > 0) parts.push(`R${formatTokens(t.cacheRead)}`);
	if (t.cacheWrite > 0) parts.push(`W${formatTokens(t.cacheWrite)}`);
	return parts.join(" ");
}

type Side = "input" | "output";

export interface LiveInfo {
	tps: number;
	/** 本轮已耗时(毫秒): 用户发出消息到现在的墙钟时间 */
	elapsedMs: number;
	totals: Totals;
	/** 当前模型 ID(动态行显示模型时用) */
	model?: string;
	thinkingLevel?: string;
}

/**
 * 动态计数器: 显示值向目标值做指数逼近, 形成"数字跳跃增长"的效果.
 * - 常亮(steady): ↑↓ 都在; 哪个数字在变化, 哪个箭头亮, 否则灰色
 * - 闪烁(blink): 同上, 但变化中的箭头按帧闪烁
 * - 合并(merge): 两路合并成一个槽位, 只显示最近正在变化的那一路
 */
export class LiveCounter {
	private dispInput = 0;
	private dispOutput = 0;
	private dispCost = 0;
	private phase = 0;
	private grewInput = false;
	private grewOutput = false;
	private lastSide: Side = "output";

	reset(): void {
		this.dispInput = 0;
		this.dispOutput = 0;
		this.dispCost = 0;
		this.phase = 0;
		this.grewInput = false;
		this.grewOutput = false;
		this.lastSide = "output";
	}

	/**
	 * 推进一帧动画.
	 * @returns 显示值是否发生变化(无变化时调用方可以跳过重绘)
	 */
	tick(target: Totals): boolean {
		const tIn = target.input;
		const tOut = target.output;
		const prevIn = this.dispInput;
		const prevOut = this.dispOutput;
		const prevCost = this.dispCost;
		this.dispInput = approach(this.dispInput, tIn);
		this.dispOutput = approach(this.dispOutput, tOut);
		this.dispCost = approach(this.dispCost, target.cost);
		this.grewInput = this.dispInput < tIn;
		this.grewOutput = this.dispOutput < tOut;
		const dIn = this.dispInput - prevIn;
		const dOut = this.dispOutput - prevOut;
		// 合并模式: 记录最近变化的一侧; 同时变化时显示变化量大的一侧
		if (dIn > 0 || dOut > 0) {
			this.lastSide = dIn > dOut ? "input" : dOut > dIn ? "output" : this.lastSide;
		}
		this.phase = (this.phase + 1) % 2;
		return dIn > 0 || dOut > 0 || this.dispCost !== prevCost;
	}

	/** 渲染动态行(两部分: 计数区 · 信息区), 例如: ↑452 ↓246 R589k 57tok/s 42s · mimo-v2.6-pro (high) $0.0025 */
	render(theme: Theme, cfg: TokenMeterConfig, info: LiveInfo): string {
		const mode = cfg.animation;
		const head: string[] = [];

		const arrowText = (side: Side): string => {
			const ch = side === "input" ? "↑" : "↓";
			const grew = side === "input" ? this.grewInput : this.grewOutput;
			const value = side === "input" ? this.dispInput : this.dispOutput;
			let color: "accent" | "muted" = "muted";
			if (grew) color = mode === "blink" && this.phase === 1 ? "muted" : "accent";
			// 数字与箭头同色: 亮起时变绿, 否则同灰. 箭头与数字之间不留空格
			return `${theme.fg(color, ch)}${theme.fg(color, formatTokens(value))}`;
		};

		if (cfg.liveShowArrows) {
			if (mode === "merge") {
				head.push(arrowText(this.lastSide));
			} else {
				head.push(arrowText("input"), arrowText("output"));
			}
		}
		const cache = formatCache(info.totals);
		if (cache && cfg.liveShowCache) head.push(theme.fg("muted", cache));
		if (cfg.liveShowTps && info.tps > 0) head.push(theme.fg("muted", formatTps(info.tps)));
		if (cfg.liveShowDuration && info.elapsedMs > 0) head.push(theme.fg("muted", formatDuration(info.elapsedMs)));
		const tail: string[] = [];
		const label = composeLabel(cfg.liveShowModel, cfg.liveShowThinking, info.model, info.thinkingLevel);
		if (label) tail.push(theme.fg("muted", label));
		if (cfg.liveShowCost) tail.push(theme.fg("muted", formatCost(this.dispCost)));
		if (tail.length === 0) return head.join(" ");
		if (head.length === 0) return tail.join(" ");
		return `${head.join(" ")} ${theme.fg("muted", "·")} ${tail.join(" ")}`;
	}
}

function approach(current: number, target: number): number {
	if (current >= target) return target;
	const gap = target - current;
	// 小步快跑: 至少 +1, 最大一步吃掉差距的 40%
	return Math.min(target, current + Math.max(1, Math.ceil(gap * 0.4)));
}

/** 模型/思考强度标签: 两个开关独立控制, 组合效果 `model (high)` */
function composeLabel(showModel: boolean, showThinking: boolean, model: string | undefined, level: string | undefined): string | undefined {
	const parts: string[] = [];
	if (showModel && model) parts.push(model);
	if (showThinking && level) parts.push(`(${level})`);
	return parts.length ? parts.join(" ") : undefined;
}

/**
 * 结算行(两部分: 计数区 · 信息区, 写入对话末尾).
 * 静态记录不鹤立: 一律灰色.
 */
export function buildResultLine(summary: RoundSummary, cfg: TokenMeterConfig, theme: Theme): string {
	const m = messages(cfg.language);
	const t = summary.totals;
	const head: string[] = [];
	if (cfg.showArrows) {
		head.push(
			`${theme.fg("muted", "↑")}${theme.fg("muted", formatTokens(t.input))}`,
			`${theme.fg("muted", "↓")}${theme.fg("muted", formatTokens(t.output))}`,
		);
	}
	const cache = formatCache(t);
	if (cache && cfg.showCache) head.push(theme.fg("muted", cache));
	if (cfg.showTps && summary.tps > 0) head.push(theme.fg("muted", formatTps(summary.tps)));
	if (cfg.showDuration && summary.durationMs > 0) head.push(theme.fg("muted", formatDuration(summary.durationMs)));
	const tail: string[] = [];
	const level = summary.thinkingLevels.length ? summary.thinkingLevels.join("→") : undefined;
	const model = summary.models.length ? formatModels(summary, m.unknownModel) : undefined;
	const label = composeLabel(cfg.showModel, cfg.showThinking, model, level);
	if (label) tail.push(theme.fg("muted", label));
	if (cfg.showCost) tail.push(theme.fg("muted", formatCost(t.cost)));
	if (tail.length === 0) return head.join(" ");
	if (head.length === 0) return tail.join(" ");
	return `${head.join(" ")} ${theme.fg("muted", "·")} ${tail.join(" ")}`;
}
