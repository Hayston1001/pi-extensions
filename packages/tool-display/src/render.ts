/**
 * 四档渲染
 *
 * 所有工具统一用 renderShell: "self",外壳自己画:
 *   - mini/low 折叠态画单行汇总(空行组件渲染为零高度, 同批其余行整个消失)
 *   - 其余形态复刻原版外壳: Box(1, 1, 状态背景) 包住内建 renderCall/renderResult
 *     -- 与 pi 默认壳同一个组件类,视觉一致(edit 自带外壳则直接用内建组件)
 *
 * 点击由本扩展的鼠标区域接管: 汇总行 = 切换整批, 调用内容 = 切换该条
 * pi 的 context.expanded 只在 Ctrl+O 这类全局展开时才为真, 作为 "强制全展" 叠加
 * 
 */
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, MouseRegion, Text, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { debugLog, type ToolDisplayConfig } from "./config.ts";
import {
	batchIsExpanded,
	batchSummary,
	historyDurationMs,
	hoverRow,
	isRowHovered,
	isSummaryOwner,
	noteErrorLine,
	noteRowRender,
	ownedCalls,
	rowOutput,
	setRowOutput,
	toggleBatch,
	type ToolStatus,
} from "./state.ts";

export type AnyDef = ToolDefinition<any, any, any>;
export type AnyResult = { content: Array<{ type: string; text?: string }> };

/** 渲染上下文里我们用到的部分(其余字段原样透传给内建渲染器).  */
export interface RenderContextLike {
	args: any;
	toolCallId: string;
	invalidate: () => void;
	lastComponent?: Component;
	state: Record<string, unknown>;
	cwd: string;
	executionStarted: boolean;
	isPartial: boolean;
	expanded: boolean;
	isError: boolean;
}

/** 我们在 context.state 里用的键(避开内建渲染器自己的键).  */
const BOX_KEY = "__mtMergedBox";
const CALL_KEY = "__mtCallComponent";
const RESULT_KEY = "__mtResultComponent";
const MODE_KEY = "__mtRowMode";

/** 本条调用这一遍该画成什么.  */
type RowMode =
	/** 整行零高度(compact 档折叠时, 同批非汇总行) */
	| "hidden"
	/** 原版调用行 + 摘要, 不显示输出(medium 档折叠态, compact 的 summary 形态) */
	| "medium"
	/** 原版折叠态: pi 自己的输出预览, 有行数上限(default 档折叠态) */
	| "collapsed"
	/** 原版展开态(全量输出) */
	| "expanded";

/**
 * 内建渲染器依赖 context.lastComponent 做组件复用(bash/read/write 会对它
 * setText,edit 还做 instanceof 判断). 我们包了一层后必须把它上一次返回的
 * 组件原样递回去,否则复用链断裂. 
 */
function baseContext(context: RenderContextLike, key: string): RenderContextLike {
	return { ...context, lastComponent: context.state[key] as Component | undefined };
}

type BgKey = "toolPendingBg" | "toolErrorBg" | "toolSuccessBg";

function emptyText(): Component {
	return new Text("", 0, 0);
}

function statusOf(context: RenderContextLike): ToolStatus {
	return context.isError ? "error" : context.isPartial ? "pending" : "success";
}

function bgKeyFor(status: ToolStatus): BgKey {
	return status === "error" ? "toolErrorBg" : status === "pending" ? "toolPendingBg" : "toolSuccessBg";
}

/**
 * 时间记账: 执行开始时打 startedAt, 结束时补 endedAt. 内建 bash/powershell 渲染
 * 器也维护同样的字段(Elapsed/Took 靠它); 折叠档位不调用内建渲染器, 这里替它补上,
 * 否则展开后的计时会从"点击展开"才开始. 同时给 medium 摘要行提供耗时. 
 */
function noteTiming(context: RenderContextLike, finished: boolean): void {
	const state = context.state as {
		startedAt?: number;
		endedAt?: number;
		interval?: ReturnType<typeof setInterval>;
	};
	if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
	if (finished) {
		if (state.startedAt !== undefined) {
			state.endedAt ??= Date.now();
		}
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}
}

/** 本条调用的耗时(ms):实时跑读渲染上下文,历史回放读会话里的时间戳.  */
function durationOf(context: RenderContextLike): number | undefined {
	const state = context.state as { startedAt?: number; endedAt?: number };
	if (state.startedAt !== undefined) {
		return Math.max(0, (state.endedAt ?? Date.now()) - state.startedAt);
	}
	return historyDurationMs(context.toolCallId);
}

// ---------------------------------------------------------------- 折叠辅助

function textParts(result: AnyResult): string[] {
	return result.content
		.filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text);
}

function nonEmptyLines(result: AnyResult): string[] {
	return textParts(result)
		.flatMap((text) => text.split("\n"))
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/** 出错时折叠视图露出的关键一行(shell 工具的状态行在末尾).  */
export function pickErrorLine(name: string, result: AnyResult): string {
	const lines = nonEmptyLines(result);
	if (lines.length === 0) {
		return "";
	}
	if (name === "bash" || name === "powershell") {
		return lines[lines.length - 1];
	}
	return lines[0];
}

// ---------------------------------------------------------------- 摘要

/** 返回"条目"的工具:输出本身就是一个列表.  */
const LIST_TOOLS = new Set(["ls", "grep", "find"]);

/** 没找到东西时的占位文案,不该算作条目.  */
const PLACEHOLDER_LINES = new Set(["(empty directory)", "No matches found", "No files found matching pattern"]);

/**
 * 结果里有多少条. 内建结果只带"是否触顶/截断"的 details, 没有条目数字段,
 * 所以这里数输出行: 去掉尾部 "[...]" 提示块与占位文案. 仅对列表类工具给值. 
 */
function entryCount(name: string, result: AnyResult): number | undefined {
	if (!LIST_TOOLS.has(name)) {
		return undefined;
	}
	let count = 0;
	for (const line of nonEmptyLines(result)) {
		if (line.startsWith("[") && line.endsWith("]")) {
			continue;
		}
		if (PLACEHOLDER_LINES.has(line)) {
			continue;
		}
		count += 1;
	}
	return count;
}

/** shell 工具调用里设的 timeout(秒); 其它工具没有这个概念.  */
function timeoutSeconds(name: string, args: unknown): number | undefined {
	if (name !== "bash" && name !== "powershell") {
		return undefined;
	}
	const value = (args as { timeout?: unknown } | undefined)?.timeout;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) {
		return `${seconds.toFixed(1)}s`;
	}
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) {
		return `${minutes}m ${remainder}s`;
	}
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** medium 折叠态的摘要:条目数 · 耗时 · timeout(有值的才出现).  */
function summaryText(name: string, context: RenderContextLike, result: AnyResult, theme: Theme, finished: boolean): string | undefined {
	const parts: string[] = [];
	// 执行中结果还在变, 数出来的条目不准; 只给耗时, 条目等结束再算
	if (finished && !context.isError) {
		const count = entryCount(name, result);
		if (count !== undefined) {
			parts.push(`${count} ${count === 1 ? "entry" : "entries"}`);
		}
	}
	const ms = durationOf(context);
	if (ms !== undefined) {
		parts.push(formatDuration(ms));
	}
	const timeout = timeoutSeconds(name, context.args);
	if (timeout !== undefined) {
		parts.push(`timeout ${timeout}s`);
	}
	return parts.length > 0 ? theme.fg("muted", parts.join(" · ")) : undefined;
}

// ---------------------------------------------------------------- 单行构件

/** 带状态背景的行块:与原版外壳同款(上下各一行垫高).  */
function statusBox(status: ToolStatus, theme: Theme): Box {
	return new Box(1, 1, (text) => theme.bg(bgKeyFor(status), text));
}

/** compact 档折叠行里的工具名列表(超出上限收成 +N).  */
function toolNameLabel(id: string, config: ToolDisplayConfig): string {
	const calls = ownedCalls(id);
	const limit = Math.max(1, config.low.nameLimit);
	const shown = calls.slice(0, limit).map((call) => call.name);
	const rest = calls.length - shown.length;
	const text = shown.join(", ");
	return rest > 0 ? `${text} +${rest}` : text;
}

/** compact 档汇总行:mini 报数量, low 报工具名;不带背景,状态由符号承担.  */
function summaryLine(id: string, theme: Theme, expanded: boolean, config: ToolDisplayConfig): Component {
	const summary = batchSummary(id);
	const total = summary.total;
	let symbol: string;
	if (summary.pending) {
		symbol = theme.fg("muted", "⋯");
	} else if (summary.failed) {
		symbol = theme.fg("error", "✕");
	} else {
		symbol = theme.fg("success", "✓");
	}
	let label: string;
	if (config.display === "mini") {
		label = summary.pending ? `${summary.done}/${total} tools` : `${total} tool${total === 1 ? "" : "s"}`;
	} else {
		label = toolNameLabel(id, config);
	}
	const hovered = isRowHovered(id);
	const labelColor = hovered ? "text" : "muted";
	const prefix = theme.fg(hovered ? "text" : "dim", expanded ? "-" : "+");
	// 汇总行保持紧凑(不额外垫高), 上下留白用 pi 原生行距即可
	return new Text(`${prefix} ${symbol} ${theme.fg(labelColor, label)}`, 0, 0);
}

// ---------------------------------------------------------------- 鼠标区域

/**
 * 汇总行: 移入提亮, 左键切换整批展开.
 * 返回 handled 是为了不让 pi 外层那套"点行展开单条"的逻辑也跟着触发--
 * 汇总行代表整批, 单条的展开交给下面 contentRegion. 
 */
function summaryRegion(id: string, component: Component): Component {
	return new MouseRegion(component, (event) => {
		if (event.type === "move") {
			hoverRow(id);
			return undefined;
		}
		if (event.type === "click" && event.button === "left") {
			toggleBatch(id);
			return { handled: true };
		}
		return undefined;
	});
}

/** 调用内容: 左键在"摘要 / 完整输出"之间切换当前这一条.  */
function contentRegion(component: Component, onToggle: () => void): Component {
	return new MouseRegion(component, (event) => {
		if (event.type === "click" && event.button === "left") {
			onToggle();
			return { handled: true };
		}
		return undefined;
	});
}

// ---------------------------------------------------------------- 原版外壳

function fallbackCall(name: string, theme: Theme): Component {
	return new Text(theme.fg("toolTitle", theme.bold(name)), 1, 0);
}

/** 把工具路径的用户主目录前缀换成 `~`(与内建 renderToolPath 的 shortenPath 一致).  */
function shortenPath(path: string): string {
	try {
		const home = homedir();
		if (home && path.startsWith(home)) {
			return `~${path.slice(home.length)}`;
		}
	} catch {
		// 取不到主目录就原样显示
	}
	return path;
}

/**
 * medium 档自带外壳工具(edit)的调用行: 只复刻它那一行表头(工具名 + 路径),
 * 不带它自己画的 diff 预览 -- medium 的输出是不显示的. 
 */
function mediumCallLine(name: string, args: unknown, theme: Theme): Component {
	const value = (args as { file_path?: unknown; path?: unknown } | undefined) ?? {};
	const raw = value.file_path ?? value.path;
	let text = theme.fg("toolTitle", theme.bold(name));
	if (typeof raw === "string" && raw.length > 0) {
		text += ` ${theme.fg("accent", shortenPath(raw))}`;
	}
	return new Text(text, 0, 0);
}

/**
 * 这些工具的 renderCall 会把参数内容(文件正文 / diff)也画出来; medium 只要调用行,
 * 所以跳过它们自己的 renderCall, 用 mediumCallLine 只画表头. 
 */
const MEDIUM_HEADER_ONLY = new Set(["edit", "write"]);

/** 执行中每秒重画一次, 让 medium 的耗时往前走(结束时会被 noteTiming 清掉).  */
function armTick(context: RenderContextLike): void {
	const state = context.state as { interval?: ReturnType<typeof setInterval> };
	if (state.interval) {
		return;
	}
	const timer = setInterval(() => context.invalidate(), 1000);
	const maybeUnref = timer as unknown as { unref?: () => void };
	if (typeof maybeUnref.unref === "function") {
		maybeUnref.unref();
	}
	state.interval = timer;
}

function fallbackResult(result: AnyResult, theme: Theme): Component | undefined {
	const output = textParts(result).join("\n").trim();
	if (!output) {
		return undefined;
	}
	const lines = output.split("\n").slice(0, 10).map((line) => theme.fg("toolOutput", line));
	return new Text(lines.join("\n"), 0, 0);
}

/**
 * 画原版调用部分, 并把结果要落进去的外壳暂存到 context.state[BOX_KEY]:
 * edit 等自带外壳(renderShell: "self")的工具直接用内建组件, 没有 Box 可追加. 
 */
function buildStockCall(
	name: string,
	base: AnyDef,
	args: unknown,
	theme: Theme,
	context: RenderContextLike,
	mode: RowMode,
): Component {
	const selfFramed = (base.renderShell ?? "default") === "self";
	if (mode === "medium" && (selfFramed || MEDIUM_HEADER_ONLY.has(name))) {
		// medium 只要调用行: 这些工具的 renderCall 会把 diff / 文件正文也画进去, 这里跳过它自己画
		const box = statusBox(statusOf(context), theme);
		box.addChild(mediumCallLine(name, args, theme));
		context.state[CALL_KEY] = undefined;
		context.state[BOX_KEY] = box;
		return box;
	}
	const callContext = baseContext(context, CALL_KEY);
	let callComponent: Component | undefined;
	try {
		callComponent = base.renderCall?.(args as never, theme, callContext as never);
	} catch {
		callComponent = undefined;
	}
	context.state[CALL_KEY] = callComponent;
	if (selfFramed) {
		context.state[BOX_KEY] = undefined;
		return callComponent ?? fallbackCall(name, theme);
	}
	const box = statusBox(statusOf(context), theme);
	box.addChild(callComponent ?? fallbackCall(name, theme));
	context.state[BOX_KEY] = box;
	return box;
}

// ---------------------------------------------------------------- 两个渲染槽位

let firstRenderLogged = false;

/**
 * 调用槽位. 所有形态都在这里决定本行画什么(把 RowMode 记进 context.state),
 * renderResult 槽位随后据此补结果部分 -- pi 在同一次更新里先后调用两个槽位,
 * 之后才渲染,所以合成结果一次成型. 
 */
export function renderCallSlot(
	name: string,
	base: AnyDef,
	args: unknown,
	theme: Theme,
	context: RenderContextLike,
	config: ToolDisplayConfig,
): Component {
	if (!firstRenderLogged) {
		firstRenderLogged = true;
		debugLog("renderCallSlot first use", name, `tier=${config.display}`, `expanded=${String(context.expanded)}`);
	}
	noteTiming(context, false);
	const id = context.toolCallId;
	noteRowRender(id, name, args, statusOf(context), context.invalidate);

	const tier = config.display;
	// 点击都由本扩展接管, 所以 context.expanded 只可能来自 Ctrl+O(全局展开)
	const forced = context.expanded;

	if (tier === "mini" || tier === "low") {
		const owner = isSummaryOwner(id);
		const visible = batchIsExpanded(id) || forced;
		if (!visible) {
			context.state[MODE_KEY] = "hidden";
			context.state[BOX_KEY] = undefined;
			return owner ? summaryRegion(id, summaryLine(id, theme, false, config)) : emptyText();
		}
		// 单条形态: 跟 expandStyle(medium = 只给摘要, default = 原版带输出预览); 点一下翻成完整输出
		const callOutput = forced || (rowOutput(id) ?? false);
		const mode: RowMode = callOutput ? "expanded" : config.expandStyle === "default" ? "collapsed" : "medium";
		context.state[MODE_KEY] = mode;
		const content = contentRegion(buildStockCall(name, base, args, theme, context, mode), () => setRowOutput(id, !callOutput));
		if (!owner) {
			return content;
		}
		// 展开: 汇总行留在最上方(- 前缀), 下面是自己这一条的内容; 其余行各自画自己的
		const container = new Container();
		container.addChild(summaryRegion(id, summaryLine(id, theme, true, config)));
		container.addChild(content);
		return container;
	}

	const output = forced || (rowOutput(id) ?? false);
	const mode: RowMode = output ? "expanded" : tier === "medium" ? "medium" : "collapsed";
	context.state[MODE_KEY] = mode;
	return contentRegion(buildStockCall(name, base, args, theme, context, mode), () => setRowOutput(id, !output));
}

/** 结果槽位.  */
export function renderResultSlot(
	name: string,
	base: AnyDef,
	result: AnyResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContextLike,
	config: ToolDisplayConfig,
): Component {
	const finished = !options.isPartial || context.isError;
	noteTiming(context, finished);
	const errorLine = pickErrorLine(name, result);
	if (errorLine) {
		noteErrorLine(context.toolCallId, errorLine);
	}

	const mode = (context.state[MODE_KEY] as RowMode | undefined) ?? "collapsed";
	if (mode === "hidden") {
		return emptyText();
	}
	const toggleOutput = () => setRowOutput(context.toolCallId, mode !== "expanded");
	const box = context.state[BOX_KEY] as Box | undefined;

	if (mode === "medium") {
		// 原版调用行 + 摘要(不显示输出); 执行中每秒重画一次, 耗时能眼看着往上涨
		if (!finished) {
			armTick(context);
		}
		const lines: Component[] = [];
		const meta = summaryText(name, context, result, theme, finished);
		if (meta) {
			lines.push(new Text(meta, 0, 0));
		}
		if (context.isError && config.medium.showErrorLine && errorLine) {
			lines.push(new Text(theme.fg("error", errorLine), 0, 0));
		}
		if (box) {
			for (const line of lines) {
				box.addChild(line);
			}
			if (lines.length > 0) {
				box.invalidate();
			}
			return emptyText();
		}
		// 没东西可追加(不该发生): 当结果子组件返回
		return contentRegion(combine(lines), toggleOutput);
	}

	// collapsed / expanded: 完整交给内建渲染器, 只用 expanded 决定预览还是全量
	const resultContext = baseContext(context, RESULT_KEY);
	const resultOptions = { ...options, expanded: mode === "expanded" };
	let resultComponent: Component | undefined;
	try {
		resultComponent = base.renderResult?.(result as never, resultOptions as never, theme, resultContext as never);
	} catch {
		resultComponent = undefined;
	}
	context.state[RESULT_KEY] = resultComponent;
	resultComponent ??= fallbackResult(result, theme);
	if (resultComponent && box) {
		box.addChild(resultComponent);
		box.invalidate();
		return emptyText();
	}
	if (!resultComponent) {
		return emptyText();
	}
	// 自带外壳: 结果不与调用共用一个 Box, 单独包一层点击区域
	return contentRegion(resultComponent, toggleOutput);
}

/** 把若干组件合成一个(零个 = 空行, 一个 = 原样, 多个 = 容器).  */
function combine(lines: Component[]): Component {
	if (lines.length === 0) {
		return emptyText();
	}
	if (lines.length === 1) {
		return lines[0];
	}
	const container = new Container();
	for (const line of lines) {
		container.addChild(line);
	}
	return container;
}
