/**
 * Thinking Display: 流式输出时仅展开当前生成的 thinking 段, 并提供标记, 悬停高亮和点击折叠.
 * 设置可通过 `/thinking-display-settings` 随时修改.
 *
 * 流式规则包装 `AssistantMessageComponent.updateContent`: 后面已有可见内容的 thinking 段收起, 当前段展开. 渲染完成后立即清除临时覆盖值.
 *
 * 标记层包装渲染器提供的 `MouseRegion`, 绘制 `+` / `-` 标记并转发点击. TUI 鼠标派发补丁负责清除悬停状态, 使指针移出后高亮消失. `Ctrl+T` 仍由 pi 控制整体 thinking 显示状态.
 *
 * 扩展从运行中的 pi 实例获取组件类; 找不到所需接口时保持原行为. 配置保存在 `~/.pi/agent/thinking-display.json`, 旧位置配置只迁移一次. TUI 中命令打开设置面板, 无 UI 的宿主显示状态信息. 刷新 TUI 和主题使用独立命令 `/thinking-display-refresh`.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as piPackage from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	SettingsList,
	Text,
	truncateToWidth,
	visibleWidth,
	type SettingItem,
	type SettingsListTheme,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";

import { configPath, loadConfig, saveConfig, shortenHomePath, type ThinkingDisplayConfig } from "./config.ts";

/**
 * 沿用旧扩展名的共享标记, 让旧路径加载的副本共用状态, 避免重复包装原型.
 */
const PATCH_MARKER = "__piThinkingStreamPatched";
/** 修改补丁或装饰器时递增. */
const PATCH_VERSION = 7;
const STATE_KEY = "__piThinkingStreamState";
/** 防止重复包装装饰器. */
const VIEW_MARKER = "__piThinkingRegionView";
/** 获取当前 TUI 和主题的 widget 标识. */
const RUNTIME_CAPTURE_KEY = "thinking-stream.runtime";
/** 折叠标记及其后空格占用的列数. */
const MARKER_WIDTH = 2;
/** 折叠标记和隐藏标签使用的悬停色板. */
const AMBER_DIM: readonly [number, number, number] = [0x9c, 0x83, 0x53];
const AMBER_BRIGHT: readonly [number, number, number] = [0xf0, 0xc6, 0x74];
/** 悬停期间刷新主题的间隔. */
const THEME_REFRESH_MS = 5000;
/** 鼠标补丁失效且没有后续事件时, 悬停状态的保留时间. */
const HOVER_DECAY_MS = 1500;
/** 已跟踪消息上限, 超出时先移除最早的消息. */
const MESSAGE_TRACK_LIMIT = 200;
/** 鼠标派发补丁在原型上的状态槽. */
const MOUSE_PATCH_SINK = "__piThinkingMouseSink";
const MOUSE_PATCH_FLAG = "__piThinkingMousePatched";
const INSTANCE_CAPTURE_FLAG = "__piThinkingInstanceCapture";

interface HoverTarget {
	component: unknown;
	runIndex: number;
}

interface State {
	/** 是否启用流式折叠规则. */
	enabled: boolean;
	decorate: boolean;
	/** 已渲染消息, 用于设置变更后的重绘. */
	messages: Set<any>;
	installed: boolean;
	/** 当前规则存于全局状态, 供 reload 后更新. */
	compute: (content: readonly any[]) => boolean[];
	/** 补丁层数和规则版本, 用于诊断. */
	wraps: number;
	ruleVersion: number;
	chunk?: string;
	reason?: string;
	/** 当前 TUI 实例. */
	tui?: any;
	/** 当前主题, 用于标记颜色. */
	theme?: Theme;
	/** 用于刷新 TUI 和主题的会话上下文. */
	ctx?: ExtensionContext;
	/** 当前悬停的消息和 thinking 段. */
	hover: HoverTarget | null;
	themeCapturedAt: number;
	/** 用于判断鼠标派发补丁是否正常工作. */
	lastPatchedMouseAt: number;
	lastHoverAt: number;
	mousePatchInstalled: boolean;
	decayTimer?: ReturnType<typeof setTimeout>;
}

function getState(): State {
	const global = globalThis as Record<string, any>;
	let state = global[STATE_KEY] as State | undefined;
	if (!state) {
		state = {
			enabled: true,
			decorate: true,
			messages: new Set<any>(),
			installed: false,
			compute: computeStreamingVisibility,
			wraps: 0,
			ruleVersion: 0,
			hover: null,
			themeCapturedAt: 0,
			lastPatchedMouseAt: 0,
			lastHoverAt: 0,
			mousePatchInstalled: false,
		} satisfies State;
		global[STATE_KEY] = state;
		return state;
	}
	// 补齐旧版本共享状态中缺少的字段.
	state.decorate ??= true;
	state.messages ??= new Set();
	state.hover ??= null;
	state.themeCapturedAt ??= 0;
	state.lastPatchedMouseAt ??= 0;
	state.lastHoverAt ??= 0;
	state.mousePatchInstalled ??= false;
	return state;
}

/** 从 CLI 入口定位 pi 的 bundle chunks 目录. */
function findChunksDir(): string | undefined {
	const candidates: string[] = [];

	const entry = process.argv[1];
	if (entry) {
		// 从 bundle/cli.js 路径推导 chunks 目录.
		candidates.push(path.join(path.dirname(entry), "chunks"));
		let dir = path.dirname(entry);
		for (let i = 0; i < 6; i += 1) {
			candidates.push(path.join(dir, "dist", "bundle", "chunks"));
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	try {
		const require = createRequire(entry ?? import.meta.url);
		const pkgEntry = require.resolve("@earendil-works/pi-coding-agent");
		candidates.push(path.join(path.dirname(pkgEntry), "bundle", "chunks"));
	} catch {
		// 忽略错误, 继续检查已收集的候选路径.
	}

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** 在 bundle 分块中查找定义 transcript 组件的文件. */
function findComponentChunk(chunksDir: string): string | undefined {
	let names: string[];
	try {
		names = fs.readdirSync(chunksDir);
	} catch {
		return undefined;
	}

	for (const name of names) {
		if (!name.endsWith(".js")) continue;
		const file = path.join(chunksDir, name);
		let source: string;
		try {
			source = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (source.includes("AssistantMessageComponent") && source.includes("updateContent(message")) {
			return file;
		}
	}
	return undefined;
}

/**
 * 计算流式期间各 thinking 段的隐藏状态. 后续出现正文、另一段 thinking 或工具调用时收起. 连续非空块视为一段, 空块忽略.
 */
export function computeStreamingVisibility(content: readonly any[]): boolean[] {
	const hidden: boolean[] = [];
	for (let i = 0; i < content.length; i += 1) {
		if (content[i]?.type !== "thinking") continue;

		let nonEmpty = false;
		for (; i < content.length && content[i]?.type === "thinking"; i += 1) {
			const text = content[i]?.thinking;
			if (typeof text === "string" && text.trim()) nonEmpty = true;
		}
		const after = i;
		i -= 1;
		if (!nonEmpty) continue;

		hidden.push(content.slice(after).some(isVisibleBlock));
	}
	return hidden;
}

/** 判断内容是否意味着前一段 thinking 已结束. */
function isVisibleBlock(block: any): boolean {
	if (block?.type === "text") return typeof block.text === "string" && !!block.text.trim();
	if (block?.type === "thinking") return typeof block.thinking === "string" && !!block.thinking.trim();
	if (block?.type === "toolCall") return true;
	return false;
}

/* ------------------------------------------------------------------ *
 * 折叠标记、悬停和点击
 * ------------------------------------------------------------------ */

/**
 * 包装 thinking `MouseRegion`, 添加标记并处理悬停, 其余事件转发给原区域. 保留 `child` 和 `onMouse` 供其它扩展识别 thinking 块. 这是与 `packages/timeline` 的接口约定; 修改结构或 `VIEW_MARKER` 时需同步检查相关实现和测试.
 */
class ThinkingRegionView {
	readonly region: any;
	readonly component: any;
	readonly runIndex: number;
	readonly hidden: boolean;
	/** 转发原区域字段, 供其它扩展识别. */
	readonly child: any;
	readonly onMouse: any;

	constructor(region: any, component: any, runIndex: number, hidden: boolean) {
		this.region = region;
		this.component = component;
		this.runIndex = runIndex;
		this.hidden = hidden;
		this.child = region?.child;
		this.onMouse = region?.onMouse;
		Object.defineProperty(this, VIEW_MARKER, { value: true, enumerable: false });
	}

	invalidate(): void {
		this.region?.invalidate?.();
	}

	render(width: number): string[] {
		const state = getState();
		const total = Math.max(1, Math.floor(width));
		const hovered = isHovered(state, this.component, this.runIndex);
		const markerAnsi = amberAnsi(state, hovered);
		const styledMarker = `${markerAnsi}${this.hidden ? "+" : "-"}\u001b[39m`;
		// 收起标签使用标记颜色, 展开正文保留主题颜色.
		const bodyAnsi = this.hidden ? markerAnsi : undefined;

		const innerWidth = Math.max(1, total - MARKER_WIDTH);
		let innerLines: string[] = [];
		try {
			const rendered = this.region?.render?.(innerWidth);
			if (Array.isArray(rendered)) innerLines = rendered;
		} catch {
			innerLines = [];
		}

		const out: string[] = [];
		if (innerLines.length === 0) {
			out.push(fitLine(`${styledMarker} `, total));
			return out;
		}

		for (let i = 0; i < innerLines.length; i += 1) {
			let body = typeof innerLines[i] === "string" ? innerLines[i] : "";
			// pi 把展开正文渲染成斜体, 中文等无斜体字形的字体会被终端画成粗体, 这里去掉强调只留灰色.
			body = bodyAnsi ? recolorThinkingText(state, body, bodyAnsi) : stripEmphasis(body);
			const line = i === 0 ? `${styledMarker} ${body}` : `${" ".repeat(MARKER_WIDTH)}${body}`;
			out.push(fitLine(line, total));
		}
		return out;
	}

	handleMouse(event: TuiMouseEvent) {
		if (event?.type === "move") {
			hoverBlock(getState(), this.component, this.runIndex);
			return { handled: true, render: true };
		}
		return this.region?.handleMouse?.(event);
	}
}

function isHovered(state: State, component: any, runIndex: number): boolean {
	const hover = state.hover;
	return !!hover && hover.component === component && hover.runIndex === runIndex;
}

/** 将渲染行补齐或截断到指定列数. */
function fitLine(line: string, total: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth < total) return line + " ".repeat(total - lineWidth);
	if (lineWidth > total) return truncateToWidth(line, total, "", true);
	return line;
}

/** 根据主题颜色模式生成标记和隐藏标签的琥珀色. */
function amberAnsi(state: State, bright: boolean): string {
	const rgb = bright ? AMBER_BRIGHT : AMBER_DIM;
	const theme = state.theme as { getColorMode?: () => string } | undefined;
	const mode = typeof theme?.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	if (mode === "256color") return `\u001b[38;5;${rgbToXterm256(rgb)}m`;
	return `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function rgbToXterm256(rgb: readonly [number, number, number]): number {
	const levels = [0, 95, 135, 175, 215, 255];
	const nearest = (value: number): number => {
		let best = 0;
		let bestDiff = Number.POSITIVE_INFINITY;
		for (let i = 0; i < levels.length; i += 1) {
			const diff = Math.abs(levels[i] - value);
			if (diff < bestDiff) {
				bestDiff = diff;
				best = i;
			}
		}
		return best;
	};
	return 16 + 36 * nearest(rgb[0]) + 6 * nearest(rgb[1]) + nearest(rgb[2]);
}

/** 仅将收起标签的 `thinkingText` 颜色替换为琥珀色. */
function recolorThinkingText(state: State, line: string, amber: string): string {
	const theme = state.theme as { getFgAnsi?: (color: string) => string } | undefined;
	const source = typeof theme?.getFgAnsi === "function" ? theme.getFgAnsi("thinkingText") : undefined;
	if (typeof source !== "string" || source.length === 0) return line;
	return line.split(source).join(amber);
}

const SGR_RE = /\u001b\[([0-9;]*)m/g;

/**
 * 去掉 SGR 中的粗体(1)和斜体(3), 保留颜色等其它属性.
 * `38` / `48` 后面的参数是颜色分量, 不能当样式码删除.
 */
export function stripEmphasis(line: string): string {
	return line.replace(SGR_RE, (_match, params: string) => {
		if (params === "") return _match;
		const codes = params.split(";");
		const kept: string[] = [];
		for (let i = 0; i < codes.length; i += 1) {
			const code = Number(codes[i]);
			if (code === 38 || code === 48) {
				const mode = Number(codes[i + 1]);
				const span = mode === 5 ? 3 : mode === 2 ? 5 : 2;
				kept.push(...codes.slice(i, i + span));
				i += span - 1;
				continue;
			}
			if (code === 1 || code === 3) continue;
			kept.push(codes[i]);
		}
		return kept.length === 0 ? "" : `\u001b[${kept.join(";")}m`;
	});
}

/** 渲染器提供的 thinking 区域结构. */
function isMouseRegion(value: any): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		typeof value.render === "function" &&
		typeof value.handleMouse === "function" &&
		"child" in value &&
		"onMouse" in value
	);
}

/**
 * 将消息中的 thinking `MouseRegion` 替换为装饰视图. 必须在流式覆盖生效时执行, 以保持标记与实际显示状态一致.
 */
export function decorateThinkingRegions(component: any): void {
	const children: any[] | undefined = component?.contentContainer?.children;
	if (!Array.isArray(children)) return;

	let runIndex = 0;
	for (let i = 0; i < children.length; i += 1) {
		const child = children[i];
		// reload 后旧包装层会先包一层它那一代的视图; 这里拆回原始区域重新包装,
		// 让最新一层的渲染逻辑获胜, 而不是一直沿用最早那一代.
		const region = child?.[VIEW_MARKER] === true ? child.region : child;
		if (!isMouseRegion(region)) continue;

		const hidden = component?.thinkingVisibilityOverrides?.get(runIndex) ?? component?.hideThinkingBlock ?? false;
		children[i] = new ThinkingRegionView(region, component, runIndex, hidden === true);
		runIndex += 1;
	}
}

/* ------------------------------------------------------------------ *
 * 获取 TUI、主题并处理悬停移出
 * ------------------------------------------------------------------ */

/**
 * 通过零高度 widget 获取当前 `TUI` 和主题, 并安装鼠标补丁. widget 工厂会同步执行, 返回的组件不渲染内容.
 */
function captureRuntime(state: State): void {
	const ctx = state.ctx;
	if (!ctx) return;

	try {
		ctx.ui.setWidget(RUNTIME_CAPTURE_KEY, (tui, theme) => {
			state.tui = tui;
			state.theme = theme;
			state.themeCapturedAt = Date.now();
			installMousePatch(tui);
			armInstanceCapture(tui);
			return { render: () => [], invalidate() {} };
		});
	} catch {
		// 不支持 widget 的模式下, 悬停样式退回 ANSI 反色.
	}
}

function maybeRefreshRuntime(state: State): void {
	if (!state.ctx) return;
	if (Date.now() - state.themeCapturedAt < THEME_REFRESH_MS) return;
	captureRuntime(state);
}

function clearDecay(state: State): void {
	if (state.decayTimer !== undefined) {
		clearTimeout(state.decayTimer);
		state.decayTimer = undefined;
	}
}

/** 清除悬停目标并重绘. */
function clearHover(state: State, tui?: unknown): void {
	const had = state.hover;
	state.hover = null;
	clearDecay(state);
	if (!had) return;
	const instance = (tui ?? state.tui) as { requestRender?: () => void } | undefined;
	instance?.requestRender?.();
}

/**
 * 鼠标补丁未生效时, 超时清除没有后续事件的悬停状态. 补丁正常时, 每次悬停前都会收到清除事件, 因此指针静止时高亮仍会保留.
 */
function armDecay(state: State): void {
	clearDecay(state);
	const timer = setTimeout(() => {
		state.decayTimer = undefined;
		const patchLive =
			state.mousePatchInstalled && state.lastPatchedMouseAt > 0 && state.lastHoverAt - state.lastPatchedMouseAt < 100;
		if (!patchLive) clearHover(state);
	}, HOVER_DECAY_MS);
	(timer as { unref?: () => void }).unref?.();
	state.decayTimer = timer;
}

/** 鼠标所在区域认领悬停高亮. */
function hoverBlock(state: State, component: unknown, runIndex: number): void {
	state.lastHoverAt = Date.now();
	const previous = state.hover;
	if (previous && previous.component === component && previous.runIndex === runIndex) {
		armDecay(state);
		return;
	}
	state.hover = { component, runIndex };
	maybeRefreshRuntime(state);
	armDecay(state);
}

/** 原始鼠标事件处理: 先清除高亮, 再由目标区域认领. */
function onRawMouseEvent(tui?: unknown): void {
	const state = getState();
	state.lastPatchedMouseAt = Date.now();
	clearHover(state, tui);
}

/**
 * 包装 TUI 原型上的鼠标派发方法, 每次事件先清除悬停状态, 再由鼠标所在区域重新认领. 挂在原型上可覆盖新建的 TUI 实例, 并支持 reload 后更新处理函数.
 */
function installMousePatch(tui: unknown): void {
	const state = getState();
	try {
		if (!tui || typeof tui !== "object") return;
		const proto = Object.getPrototypeOf(tui) as Record<string, unknown> | null;
		// regular mode 没有组件鼠标派发, 由超时逻辑清除悬停状态.
		if (!proto || typeof proto.handleMouseEvent !== "function") return;

		proto[MOUSE_PATCH_SINK] = onRawMouseEvent;
		if (proto[MOUSE_PATCH_FLAG] === true) {
			state.mousePatchInstalled = true;
			return;
		}

		const original = proto.handleMouseEvent as (this: unknown, raw: unknown) => unknown;
		proto.handleMouseEvent = function patchedHandleMouseEvent(this: unknown, raw: unknown) {
			const sink = (Object.getPrototypeOf(this) as Record<string, unknown> | null)?.[MOUSE_PATCH_SINK];
			if (typeof sink === "function") (sink as (tui?: unknown) => void)(this);
			return original.call(this, raw);
		};
		proto[MOUSE_PATCH_FLAG] = true;
		state.mousePatchInstalled = true;
	} catch {
		// 补丁失败只影响及时性, 超时逻辑仍可清除状态.
	}
}

/**
 * 备用方式: 包装实例的 `requestRender`, 在后续调用时为新实例安装鼠标补丁.
 */
function armInstanceCapture(tui: unknown): void {
	try {
		if (!tui || typeof tui !== "object") return;
		const instance = tui as Record<string, unknown>;
		if (instance[INSTANCE_CAPTURE_FLAG] === true) return;
		const proto = Object.getPrototypeOf(tui) as Record<string, unknown> | null;
		const original = proto?.requestRender as ((this: unknown, ...a: unknown[]) => unknown) | undefined;
		if (typeof original !== "function") return;
		instance[INSTANCE_CAPTURE_FLAG] = true;
		instance.requestRender = function patchedRequestRender(this: unknown, ...args: unknown[]) {
			installMousePatch(this);
			return original.apply(this, args);
		};
	} catch {
		// 忽略错误, 此处仅为备用方案.
	}
}

/* ------------------------------------------------------------------ *
 * 安装补丁
 * ------------------------------------------------------------------ */

async function collectComponentCandidates(): Promise<Array<{ source: string; Component: any }>> {
	const candidates: Array<{ source: string; Component: any }> = [];
	const seen = new Set<any>();
	const push = (source: string, Component: any) => {
		if (typeof Component !== "function" || seen.has(Component)) return;
		seen.add(Component);
		candidates.push({ source, Component });
	};

	// 优先使用公开导出. pi 的 jiti 虚拟模块会将其解析到当前 CLI 的运行时命名空间.
	try {
		const pkg = piPackage as any;
		push("package export", pkg?.AssistantMessageComponent ?? pkg?.default?.AssistantMessageComponent);
	} catch {
		// 忽略错误, 继续尝试 bundle 分块.
	}

	// 原生 require() 使用 Node 的 ESM 缓存, 可获取 CLI 启动时加载的同一实例.
	const chunksDir = findChunksDir();
	const chunkFile = chunksDir ? findComponentChunk(chunksDir) : undefined;
	if (chunkFile) {
		try {
			push(chunkFile, createRequire(import.meta.url)(chunkFile)?.AssistantMessageComponent);
		} catch {
			// require(esm) 可能失败, 例如模块使用 top-level await. 再尝试动态导入.
			try {
				push(`${chunkFile} (import)`, (await import(pathToFileURL(chunkFile).href))?.AssistantMessageComponent);
			} catch {
				// 忽略错误.
			}
		}
	}

	return candidates;
}

/** 包装指定类的 `updateContent`; 可重复调用. */
function patchComponent(Component: any, _source: string): boolean {
	const state = getState();
	const proto = Component?.prototype;
	if (typeof Component !== "function" || typeof proto?.updateContent !== "function") return false;

	const existingMarker = proto[PATCH_MARKER];
	if (typeof existingMarker === "number" && existingMarker >= PATCH_VERSION) {
		// 已由当前或更新版本包装. 更新共享规则, 使现有补丁在 reload 后使用新逻辑.
		state.compute = computeStreamingVisibility;
		state.ruleVersion = PATCH_VERSION;
		return true;
	}

	const originalUpdateContent = proto.updateContent;

	proto.updateContent = function updateContent(this: any, message: any, isStreaming = this.isStreaming) {
		const current = getState();
		noteMessage(current, this);
		const overrides = this.thinkingVisibilityOverrides;
		const content = message?.content;
		const active =
			!!current.enabled && !!isStreaming && !!this.hideThinkingBlock && Array.isArray(content) && !!overrides;

		const applied: number[] = [];
		if (active) {
			const hiddenPerRun = current.compute?.(content);
			if (hiddenPerRun) {
				for (let run = 0; run < hiddenPerRun.length; run += 1) {
					// 手动点击的状态优先于自动规则.
					if (overrides.has(run)) continue;
					overrides.set(run, hiddenPerRun[run]);
					applied.push(run);
				}
			}
		}

		// reload 可能留下旧版包装层. 调用原方法期间暂时停用规则, 避免旧层覆盖当前的 visibility.
		const savedEnabled = current.enabled;
		current.enabled = false;
		try {
			const result = originalUpdateContent.call(this, message, isStreaming);
			// 自动覆盖仍生效时添加标记, 确保标记状态与渲染一致.
			if (current.decorate) {
				try {
					decorateThinkingRegions(this);
				} catch {
					// 上游结构变化不得影响消息渲染.
				}
			}
			return result;
		} finally {
			current.enabled = savedEnabled;
			for (const run of applied) overrides.delete(run);
		}
	};

	Object.defineProperty(proto, PATCH_MARKER, { value: PATCH_VERSION, configurable: true, writable: true });
	state.compute = computeStreamingVisibility;
	state.ruleVersion = PATCH_VERSION;
	state.wraps = (state.wraps ?? 0) + 1;
	return true;
}

async function install(): Promise<boolean> {
	const state = getState();

	const candidates = await collectComponentCandidates();
	if (candidates.length === 0) {
		state.reason = "could not reach AssistantMessageComponent (package export and bundle chunk both unavailable)";
		return false;
	}

	let patched = false;
	for (const { source, Component } of candidates) {
		if (patchComponent(Component, source)) patched = true;
	}
	if (!patched) {
		state.reason = "AssistantMessageComponent is not patchable";
		return false;
	}

	state.chunk = candidates.map((candidate) => candidate.source).join(", ");
	state.installed = true;
	state.reason = undefined;
	return true;
}

/* ------------------------------------------------------------------ *
 * 设置面板和配置
 * ------------------------------------------------------------------ */

/** 记录已渲染消息, 供设置变更后重绘. */
function noteMessage(state: State, component: any): void {
	const messages = (state.messages ??= new Set<any>());
	if (messages.has(component)) return;
	if (messages.size >= MESSAGE_TRACK_LIMIT) {
		const oldest = messages.values().next().value;
		if (oldest !== undefined) messages.delete(oldest);
	}
	messages.add(component);
}

/** 将配置同步到运行时状态. */
function applyConfig(state: State, config: ThinkingDisplayConfig): void {
	state.enabled = config.streaming;
	state.decorate = config.decorate;
}

/** 获取用于写回的配置对象. */
function currentConfig(state: State): ThinkingDisplayConfig {
	return { streaming: state.enabled, decorate: state.decorate };
}

/** 设置项 id: 既是面板里的行 id, 也是配置的字段名.  */
type SettingId = "streaming" | "decorate";

interface SettingDef {
	id: SettingId;
	label: string;
	description: string;
	/** 当前显示值. */
	current: (state: State) => string;
}

/** 面板和对话框共用的开关文案. */
const ON = "on";
const OFF = "off";

/**
 * 面板和对话框共用此设置表. 新增设置时在此添加; 多语言文案按 pi-ext-i18n 技能维护.
 */
const MENU: SettingDef[] = [
	{
		id: "streaming",
		label: "Streaming collapse",
		description:
			"Keep only the thinking run that is still being written expanded; collapse it as soon as text or a tool call follows.",
		current: (state) => boolText(state.enabled),
	},
	{
		id: "decorate",
		label: "Fold marker & hover",
		description:
			"Show a +/- fold marker on every thinking block, brighten it under the pointer, and toggle the block on click.",
		current: (state) => boolText(state.decorate),
	},
];

/** 设置面板标题. */
const PANEL_TITLE = "Thinking Display Settings";

/** 命令不接受参数, 有参数时仅显示用法提示. */
const USAGE_HINT = "thinking-display-settings takes no arguments. Run /thinking-display-settings to open the panel.";

function boolText(value: boolean): string {
	return value ? "on" : "off";
}

/** 将显示文案转换为布尔值. */
function valueToBool(value: string): boolean {
	return value === ON;
}

/**
 * 重绘当前消息. 标记保存在消息子组件中, 设置变更后需调用 `invalidate()` 重新执行 `updateContent`.
 */
function refreshRenderedMessages(): void {
	const state = getState();
	for (const component of state.messages ?? []) {
		try {
			component?.invalidate?.();
		} catch {
			// 上游结构变化不得影响设置命令.
		}
	}
	(state.tui as { requestRender?: () => void } | undefined)?.requestRender?.();
}

/** 保存设置并重绘当前消息. */
function applySetting(id: SettingId, value: string): void {
	const state = getState();
	const on = valueToBool(value);
	if (id === "streaming") state.enabled = on;
	else state.decorate = on;
	saveConfig(currentConfig(state));
	if (id === "decorate" && !on) state.hover = null;
	refreshRenderedMessages();
}

function statusLines(state: State): string[] {
	return [
		`streaming collapse: ${boolText(state.enabled)}`,
		`fold marker / hover: ${boolText(state.decorate)}`,
		`patched: ${state.installed} (rule v${state.ruleVersion}, patch targets: ${state.wraps})`,
		`source: ${state.chunk ?? "not found"}`,
		`runtime: ${state.tui ? "captured" : "not captured"}, theme: ${state.theme ? "captured" : "not captured"}`,
		`config: ${configPath()}`,
		state.reason ? `note: ${state.reason}` : undefined,
		"",
		"The streaming rule is active only while thinking blocks are hidden (Ctrl+T).",
		"The fold marker, hover highlight and click-to-toggle work whenever blocks are collapsible.",
	].filter((line): line is string => line !== undefined);
}

/**
 * 将搜索框提示符设为 `⌕`, 与消息列表保持一致. `SettingsList` 未提供提示符选项, 若字段变更则保留默认值.
 */
function useSearchGlyph(list: SettingsList): void {
	try {
		const input = (list as unknown as { searchInput?: { prompt?: string } }).searchInput;
		if (input && typeof input.prompt === "string") input.prompt = "⌕ ";
	} catch {
		/* 版本差异时保留默认提示符. */
	}
}

/**
 * 设置面板使用原生 `SettingsList`, 显示配置路径并采用 pi `/settings` 的主题. 每次修改都会立即写入配置.
 */
async function openSettingsPanel(ctx: ExtensionContext): Promise<void> {
	const state = getState();

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		// 使用工厂传入的实时主题, 不依赖 jiti 模块中的全局主题.
		const listTheme: SettingsListTheme = {
			label: (text, selected) => (selected ? theme.fg("accent", text) : text),
			value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
			description: (text) => theme.fg("dim", text),
			cursor: theme.fg("accent", "→ "),
			hint: (text) => theme.fg("dim", text),
		};

		const border = (str: string) => theme.fg("border", str);
		const container = new Container();
		container.addChild(new DynamicBorder(border));
		// 标题和页脚缩进两列, 与设置列表内容对齐.
		container.addChild(new Text(theme.fg("accent", theme.bold(PANEL_TITLE)), 2, 0));

		const items: SettingItem[] = MENU.map((def) => ({
			id: def.id,
			label: def.label,
			description: def.description,
			currentValue: def.current(state),
			values: [ON, OFF],
		}));
		const list = new SettingsList(
			items,
			10,
			listTheme,
			(id, value) => applySetting(id as SettingId, value),
			() => done(undefined),
			{ enableSearch: true },
		);
		useSearchGlyph(list);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", shortenHomePath(configPath())), 2, 0));
		container.addChild(new DynamicBorder(border));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
			dispose: () => {},
		};
	});
}

/**
 * 有 UI 但不支持自定义组件的宿主(RPC 等)逐项询问设置. 取消时保留已保存的修改.
 */
async function openSettingsDialog(ctx: ExtensionContext): Promise<void> {
	const state = getState();
	for (const def of MENU) {
		const picked = await ctx.ui.select(`${def.label} (currently ${def.current(state)})`, [ON, OFF]);
		if (picked === undefined) return;
		applySetting(def.id, picked);
	}
	ctx.ui.notify("thinking-display settings saved", "info");
}

let warned = false;

export default function (pi: ExtensionAPI) {
	// 尽早读取配置. reload 会在 session_start 前重建 transcript, 首次渲染就需要使用已保存的值.
	const state = getState();
	applyConfig(state, loadConfig());

	pi.on("session_start", async (_event, ctx) => {
		// 所有模式都创建配置文件. 无界面宿主只能通过手动编辑文件配置.
		if (!fs.existsSync(configPath())) saveConfig(loadConfig());

		if (ctx.mode !== "tui") return;

		// 会话启动时重新读取配置, 使手动修改无需重启 pi 即可生效.
		applyConfig(state, loadConfig());
		state.ctx = ctx;
		state.hover = null;
		captureRuntime(state);

		if (await install()) return;

		// 内部接口不可用时保持停用, 并在本次模块加载期间提示一次.
		if (!warned && state.reason && ctx.hasUI) {
			warned = true;
			ctx.ui.notify(`thinking-display is inactive: ${state.reason}`, "warning");
		}
	});

	pi.registerCommand("thinking-display-settings", {
		description: "Thinking Display Settings(thinking-display.json)",
		handler: async (args, ctx) => {
			// 无参数时按宿主能力打开面板、逐项对话框或状态报告.
			if (args.trim() !== "") {
				ctx.ui.notify(USAGE_HINT, "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(statusLines(state).join("\n"), "info");
				return;
			}
			if (ctx.mode !== "tui") {
				await openSettingsDialog(ctx);
				return;
			}
			await openSettingsPanel(ctx);
		},
	});

	// 单独提供命令重新获取 TUI 和主题, 不将其作为设置项.
	pi.registerCommand("thinking-display-refresh", {
		description: "Re-capture the live TUI and theme (thinking-display)",
		handler: async (_args, ctx) => {
			state.ctx = ctx;
			captureRuntime(state);
			ctx.ui.notify("thinking-display runtime refreshed", "info");
		},
	});
}
