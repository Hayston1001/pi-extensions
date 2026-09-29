/**
 * 工具行状态, 批次归属与 hover 状态. 
 *
 * mini 档要把"同一条助手消息里连续发起的多个工具调用"汇总成一行,而 pi 的渲染
 * 是每个调用一行,所以这里自己记账:
 *   - rows:      toolCallId -> 行状态(名称 / 参数 / 成败 / 错误行 / 失效重绘句柄)
 *   - batches:   批次 -> 有序 toolCallId 列表(批次键 = 消息里第一个 toolCallId)
 *
 * 批次来源(按可靠性):
 *   1. message_update / message_end 事件携带的助手消息(实时,随流式逐个补全)
 *   2. 会话分支扫描(历史回放;也补实时事件漏掉的)
 *   3. 临时"自己一批"(流式极早期,事件还没带出来时的兜底)
 *
 * hover:pi-tui 不会通知"鼠标移出",移出清除靠给 TUI 的 handleMouseEvent 打
 * 原型补丁--每个原始鼠标事件先清 hover,随后正常派发会把指针所在行重新点亮. 
 * 补丁打不上时退回计时器清除,避免高亮永久卡住. 
 */
import type { TuiMouseEvent } from "@earendil-works/pi-tui";

export type ToolStatus = "pending" | "success" | "error";

export interface RowState {
	name: string;
	args: unknown;
	status: ToolStatus;
	errorLine: string;
	hovered: boolean;
	/** 该条是否显示完整输出(undefined = 还没点过, 跟随 expandStyle 的默认) */
	output?: boolean;
	invalidate?: () => void;
}

export interface CallInfo {
	id: string;
	name: string;
	status: ToolStatus;
	args: unknown;
	errorLine: string;
}

interface BatchInfo {
	ids: string[];
	names: Map<string, string>;
	/** 整批是否展开(由汇总行所在的行驱动, 其余行据此跟着展开/收起) */
	expanded: boolean;
}

type SessionLookup = { getBranch(): unknown[]; getLeafId(): string };

const rows = new Map<string, RowState>();
const batches = new Map<string, BatchInfo>();
const batchOf = new Map<string, string>();
const scanStatuses = new Map<string, ToolStatus>();
/** 历史回放里的耗时: toolCallId -> ms(由助手消息与 toolResult 消息的时间戳推得) */
const scanDurations = new Map<string, number>();
const callStartedAt = new Map<string, number>();
const ownedTools = new Set<string>();
/** 已扫过的分支长度; 长度没变就不重扫(避免每行渲染都遍历整个分支) */
let scannedBranchLength = -1;
let sessionLookup: SessionLookup | undefined;

// ---------------------------------------------------------------- 行状态

function rowFor(id: string): RowState {
	let row = rows.get(id);
	if (!row) {
		row = { name: "tool", args: undefined, status: "pending", errorLine: "", hovered: false };
		rows.set(id, row);
	}
	return row;
}

export function noteRowRender(
	id: string,
	name: string,
	args: unknown,
	status: ToolStatus,
	invalidate: () => void,
): void {
	const row = rowFor(id);
	row.name = name;
	row.args = args;
	row.status = status;
	row.invalidate = invalidate;
}

export function noteErrorLine(id: string, line: string): void {
	if (line) {
		rowFor(id).errorLine = line;
	}
}

export function noteToolStart(id: string, name: string, args?: unknown): void {
	const row = rowFor(id);
	row.name = name;
	if (args !== undefined) {
		row.args = args;
	}
	row.status = "pending";
	invalidateBatch(id);
}

export function noteToolEnd(id: string, isError: boolean): void {
	const row = rowFor(id);
	row.status = isError ? "error" : "success";
	invalidateBatch(id);
}

export function rowStatus(id: string): ToolStatus {
	return rows.get(id)?.status ?? scanStatuses.get(id) ?? "pending";
}

// ---------------------------------------------------------------- 批次

export function setSessionLookup(lookup: SessionLookup | undefined): void {
	sessionLookup = lookup;
	// 换会话时重新扫历史(分支内容整体变了)
	scannedBranchLength = -1;
}

export function setOwnedTools(names: Iterable<string>): void {
	ownedTools.clear();
	for (const name of names) {
		ownedTools.add(name);
	}
}

function collectToolCalls(message: unknown): Array<{ id: string; name: string }> {
	const msg = message as { role?: string; content?: unknown[] } | undefined;
	if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) {
		return [];
	}
	const calls: Array<{ id: string; name: string }> = [];
	for (const block of msg.content) {
		const item = block as { type?: string; id?: string; name?: string };
		if (item.type === "toolCall" && typeof item.id === "string") {
			calls.push({ id: item.id, name: typeof item.name === "string" ? item.name : "tool" });
		}
	}
	return calls;
}

/** 注册 / 更新一个批次;有变化返回 true.  */
function registerBatch(calls: Array<{ id: string; name: string }>): boolean {
	if (calls.length === 0) {
		return false;
	}
	const key = calls[0].id;
	const ids = calls.map((c) => c.id);
	const previous = batches.get(key);
	if (previous && previous.ids.length === ids.length && previous.ids.every((id, i) => id === ids[i])) {
		return false;
	}
	const names = new Map<string, string>();
	for (const call of calls) {
		names.set(call.id, call.name);
	}
	batches.set(key, { ids, names, expanded: previous?.expanded ?? false });
	for (const id of ids) {
		batchOf.set(id, key);
	}
	return true;
}

/** 实时事件:助手消息(可能还在流式增长).  */
export function noteAssistantMessage(message: unknown): void {
	const calls = collectToolCalls(message);
	if (registerBatch(calls)) {
		for (const call of calls) {
			invalidateRow(call.id);
		}
	}
}

/** 扫描会话分支,补齐历史批次与 toolResult 成败(回放时没有事件).  */
function ensureScan(): void {
	if (!sessionLookup) {
		return;
	}
	let entries: unknown[];
	try {
		entries = sessionLookup.getBranch();
	} catch {
		return;
	}
	if (entries.length === scannedBranchLength) {
		return;
	}
	scannedBranchLength = entries.length;
	for (const entry of entries) {
		const item = entry as { type?: string; message?: unknown };
		if (item.type !== "message") {
			continue;
		}
		const msg = item.message as {
			role?: string;
			content?: unknown[];
			toolCallId?: string;
			isError?: boolean;
			timestamp?: number;
		};
		if (!msg) {
			continue;
		}
		if (msg.role === "assistant") {
			const calls = collectToolCalls(msg);
			if (typeof msg.timestamp === "number") {
				for (const call of calls) {
					callStartedAt.set(call.id, msg.timestamp);
				}
			}
			registerBatch(calls);
		} else if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
			// 只补没有行状态的(行状态来自渲染上下文,更新)
			if (!rows.has(msg.toolCallId)) {
				scanStatuses.set(msg.toolCallId, msg.isError ? "error" : "success");
			}
			const startedAt = callStartedAt.get(msg.toolCallId);
			if (startedAt !== undefined && typeof msg.timestamp === "number" && msg.timestamp > startedAt) {
				scanDurations.set(msg.toolCallId, msg.timestamp - startedAt);
			}
		}
	}
}

function resolveBatch(id: string): BatchInfo {
	const key = batchOf.get(id);
	const found = key !== undefined ? batches.get(key) : undefined;
	if (found) {
		return found;
	}
	ensureScan();
	const key2 = batchOf.get(id);
	const found2 = key2 !== undefined ? batches.get(key2) : undefined;
	if (found2) {
		return found2;
	}
	// 兜底:自己临时算一批(流式极早期 / 事件没带出来)
	const row = rows.get(id);
	const info: BatchInfo = { ids: [id], names: new Map([[id, row?.name ?? "tool"]]), expanded: false };
	batches.set(id, info);
	batchOf.set(id, id);
	return info;
}

function nameOf(info: BatchInfo, id: string): string {
	return info.names.get(id) ?? rows.get(id)?.name ?? "tool";
}

/** 该批次里由本扩展渲染(即被 mini 合并)的调用,按发起顺序.  */
export function ownedCalls(id: string): CallInfo[] {
	const info = resolveBatch(id);
	const out: CallInfo[] = [];
	for (const callId of info.ids) {
		const name = nameOf(info, callId);
		if (!ownedTools.has(name)) {
			continue;
		}
		const row = rows.get(callId);
		out.push({
			id: callId,
			name,
			status: rowStatus(callId),
			args: row?.args,
			errorLine: row?.errorLine ?? "",
		});
	}
	return out;
}

/** mini 汇总行的数字与状态.  */
export function batchSummary(id: string): { total: number; done: number; failed: boolean; pending: boolean } {
	const calls = ownedCalls(id);
	let done = 0;
	let failed = false;
	let pending = false;
	for (const call of calls) {
		if (call.status === "pending") {
			pending = true;
		} else {
			done += 1;
			if (call.status === "error") {
				failed = true;
			}
		}
	}
	return { total: calls.length, done, failed, pending };
}

/** 汇总行归批次里的第一个被合并调用(其余行折叠成零高度).  */
export function isSummaryOwner(id: string): boolean {
	const calls = ownedCalls(id);
	return calls.length > 0 && calls[0].id === id;
}

/** 整批是否展开(由汇总行的点击切换).  */
export function batchIsExpanded(id: string): boolean {
	return resolveBatch(id).expanded;
}

/** 切换整批的展开状态, 并重绘本批所有行(含汇总行).  */
export function toggleBatch(id: string): void {
	const info = resolveBatch(id);
	info.expanded = !info.expanded;
	for (const callId of info.ids) {
		rows.get(callId)?.invalidate?.();
	}
}

/** 该条的输出开关: undefined = 还没点过, 跟随 expandStyle 的默认.  */
export function rowOutput(id: string): boolean | undefined {
	return rows.get(id)?.output;
}

/** 设置某条是否显示完整输出(点击切换; expandStyle 只决定初始值).  */
export function setRowOutput(id: string, value: boolean): void {
	const row = rowFor(id);
	row.output = value;
	row.invalidate?.();
}

/** 历史回放里这条调用的耗时(ms); 实时跑时用渲染上下文里的时间戳, 这里只做回放兜底.  */
export function historyDurationMs(id: string): number | undefined {
	if (scanDurations.has(id)) {
		return scanDurations.get(id);
	}
	ensureScan();
	return scanDurations.get(id);
}

export function invalidateRow(id: string): void {
	rows.get(id)?.invalidate?.();
}

export function invalidateBatch(id: string): void {
	const info = resolveBatch(id);
	for (const callId of info.ids) {
		rows.get(callId)?.invalidate?.();
	}
}

export function invalidateAll(): void {
	for (const row of rows.values()) {
		row.invalidate?.();
	}
}

// ---------------------------------------------------------------- hover

const HOVER_DECAY_MS = 1500;

let hoveredId: string | undefined;
let decayTimer: ReturnType<typeof setTimeout> | undefined;
let mousePatchInstalled = false;
let lastPatchedEventAt = 0;
let lastHoverEventAt = 0;

function clearDecay(): void {
	if (decayTimer !== undefined) {
		clearTimeout(decayTimer);
		decayTimer = undefined;
	}
}

function unhover(): void {
	const id = hoveredId;
	hoveredId = undefined;
	clearDecay();
	if (id === undefined) {
		return;
	}
	const row = rows.get(id);
	if (row?.hovered) {
		row.hovered = false;
		row.invalidate?.();
	}
}

/**
 * 计时兜底:静默一段时间后, 仅在"鼠标补丁没有真实生效"时熄灭. 
 * 补丁生效时移出由补丁即时处理, 计时器不干预(鼠标停在行上不熄灭). 
 * 判定"生效"用事实而非标志: 补丁路径收到过与 hover 几乎同时的原始事件. 
 */
function armDecay(): void {
	clearDecay();
	decayTimer = setTimeout(() => {
		decayTimer = undefined;
		const patchLive = mousePatchInstalled && lastPatchedEventAt > 0 && lastHoverEventAt - lastPatchedEventAt < 100;
		if (!patchLive) {
			unhover();
		}
	}, HOVER_DECAY_MS);
	if (typeof decayTimer.unref === "function") {
		decayTimer.unref();
	}
}

/** 鼠标移到某行上(由行的 MouseRegion 在 move 事件里调用).  */
export function hoverRow(id: string): void {
	lastHoverEventAt = Date.now();
	if (hoveredId === id) {
		armDecay();
		return;
	}
	unhover();
	hoveredId = id;
	const row = rowFor(id);
	row.hovered = true;
	row.invalidate?.();
	armDecay();
}

export function isRowHovered(id: string): boolean {
	return hoveredId === id;
}

/** 补丁包裹器每收到一个原始鼠标事件就先熄灭 hover, 派发时目标行会重新点亮.  */
function onRawMouseEvent(): void {
	lastPatchedEventAt = Date.now();
	unhover();
}

const PATCH_SINK = "__toolDisplayHoverSink";
const PATCH_FLAG = "__toolDisplayMousePatch";

/**
 * 给 TUI 的鼠标派发打补丁--等价于"移出即熄灭". 
 *
 * 两个关键点: 
 * 1. 打在类原型上(TUI 模式切换重建实例后依然生效); 包装器每次调用都从
 *    原型上取"当前模块"的清除回调, 因此扩展 /reload 重载模块后旧包装器
 *    不会失效(之前这里闭包了旧模块的状态, 导致高亮永不熄灭). 
 * 2. 不信"已安装"标志, 信事实: 计时器会根据补丁是否真的收到过事件决定
 *    是否兜底熄灭, 补丁失效也能自愈. 
 */
export function installMousePatch(tui: unknown): void {
	try {
		if (!tui || typeof tui !== "object") {
			return;
		}
		const proto = Object.getPrototypeOf(tui) as Record<string, unknown> | null;
		if (!proto || typeof proto.handleMouseEvent !== "function") {
			// regular 模式的 TUI 没有鼠标派发;hover 由计时器兑底熄灭
			return;
		}
		proto[PATCH_SINK] = onRawMouseEvent;
		if (proto[PATCH_FLAG] === true) {
			mousePatchInstalled = true;
			return;
		}
		const original = proto.handleMouseEvent as (this: unknown, raw: unknown) => unknown;
		proto.handleMouseEvent = function patchedHandleMouseEvent(this: unknown, raw: unknown) {
			const sink = (Object.getPrototypeOf(this) as Record<string, unknown>)[PATCH_SINK];
			if (typeof sink === "function") {
				(sink as () => void)();
			}
			return original.call(this, raw);
		};
		proto[PATCH_FLAG] = true;
		mousePatchInstalled = true;
	} catch {
		// 补丁失败只影响移出清除的即时性,计时器会兑底
	}
}

/**
 * 另一条拿到真实 TUI 实例的通道(兑实 widget 工厂拿不到实例的情况):
 * 把 requestRender 包一层--调用时 this 就是真实实例, 在此再尝试打补丁. 
 * 代价是每次重绘多一次空判断. 
 */
export function armInstanceCapture(ui: Record<string, unknown> | undefined): void {
	try {
		if (!ui || ui.__toolDisplayCapture === true) {
			return;
		}
		ui.__toolDisplayCapture = true;
		ui.requestRender = function patchedRequestRender(this: unknown, ...args: unknown[]) {
			installMousePatch(this);
			const proto = Object.getPrototypeOf(this) as Record<string, unknown> | null;
			const original = proto?.requestRender as ((this: unknown, ...a: unknown[]) => unknown) | undefined;
			if (typeof original === "function") {
				return original.apply(this, args);
			}
			return undefined;
		};
	} catch {
		// 忽略: 只是兑底通道失败
	}
}

export type { TuiMouseEvent };
