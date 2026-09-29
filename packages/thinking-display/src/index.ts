/**
 * Thinking Display
 *
 * Two display behaviours for thinking blocks. Both are on by default and both
 * can be switched at runtime with `/thinking-display-settings`.
 *
 * 1. Streaming collapse. While an assistant message is being generated, the
 *    thinking run that is currently being written stays expanded. As soon as
 *    any visible content starts streaming after it -- the final answer, a later
 *    thinking run, or a tool call -- it collapses again like every other one.
 *    The collapse therefore happens the moment the answer or the tool call
 *    starts, not when the turn ends.
 *
 * How the patch hooks in: the interactive transcript renders thinking blocks in
 * `AssistantMessageComponent.updateContent(message, isStreaming)`, which
 * already receives the streaming flag and supports per-block visibility
 * overrides. This extension patches that class's prototype. Reaching the *live*
 * class is the fiddly part: pi loads extensions through jiti, and jiti evaluates
 * a directly imported bundle chunk in its own VM, producing a throwaway copy
 * whose prototype is never rendered. So the class is taken from the
 * `@earendil-works/pi-coding-agent` export (a jiti virtual module pointing at
 * the running CLI's namespace), with a native `require()` of the bundle chunk as
 * a second target (`require(esm)` shares Node's ESM cache, so it is the same
 * instance the CLI imported at startup). Wrapping `updateContent`:
 *   - while streaming: every thinking run that already has visible content after
 *     it (text, a later run, or a tool call) is forced hidden, the one still
 *     being written is forced visible;
 *   - the overrides are cleared right after the render is built, so nothing
 *     leaks into the finalized message.
 *
 * 2. Collapsible thinking affordance (see opencode's `ReasoningPart` /
 * `ReasoningHeader` for the reference):
 *   - every thinking block renders a fold marker on its first line: `+` when
 *     collapsed, `-` when expanded;
 *   - the marker and the hidden `Thinking...` label sit in a muted amber
 *     (#9c8353) that brightens to #f0c674 while the pointer is over the block.
 *     An expanded body keeps the theme's thinking colour and is only rendered
 *     bold on hover, so nothing ever repaints the block background;
 *   - clicking toggles the block open/closed, and clicking again closes it.
 *
 * The marker/hover layer is implemented by post-processing the children that
 * `updateContent` just built: the renderer already wraps every thinking run in a
 * `MouseRegion`, so each of those regions is replaced by a small decorator that
 * renders the marker, tracks hover and delegates clicks to the original region.
 * Hover-leave is detected by wrapping the TUI instance's `handleMouseEvent`:
 * pi only delivers `move` events to the component under the pointer, so the
 * decorator alone cannot tell when the pointer left. The wrapper clears the
 * hover target on every motion event before the normal dispatch runs, so the
 * block under the pointer (if any) re-claims it during that same dispatch.
 *
 * Ctrl+T stays the mode switch:
 *   - Ctrl+T = thinking blocks hidden  -> "streaming" mode (this extension's
 *     behavior) + click a single block to peek at it;
 *   - Ctrl+T = thinking blocks visible -> everything stays expanded as before.
 *
 * Everything is guarded: if the expected internals are missing (new Pi layout,
 * compiled binary, RPC/JSON/print mode, non-fullscreen TUI), the extension
 * silently does nothing and the stock behavior is preserved.
 *
 * Settings live in `~/.pi/agent/thinking-display.json` and only there: a package
 * directory is replaced wholesale on upgrade, so nothing is read from or written
 * next to the code (an early `config.json` beside the sources is read once and
 * migrated). They are edited with `/thinking-display-settings`, which opens a
 * panel in the style of pi's own `/settings`. That command takes no arguments --
 * anything after it only prints a usage hint and never changes the configuration
 * (re-capturing the live TUI and theme is its own command,
 * `/thinking-display-refresh`). A host without a UI prints the patch status
 * instead of opening anything.
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
 * Keys of the shared markers. They are deliberately the ones this extension used
 * under its former name (thinking-stream): a copy still loaded from
 * `~/.pi/agent/extensions/thinking-stream` then shares them, so the two
 * cooperate instead of patching the same prototype twice. Internal, never
 * user-visible.
 */
const PATCH_MARKER = "__piThinkingStreamPatched";
/** Bump when the hook itself or the decorator changes; the marker records it. */
const PATCH_VERSION = 4;
const STATE_KEY = "__piThinkingStreamState";
/** Own marker set on decorator instances so a re-run of the hook never double-wraps. */
const VIEW_MARKER = "__piThinkingRegionView";
/** Widget key used only to borrow the live TUI instance and theme. */
const RUNTIME_CAPTURE_KEY = "thinking-stream.runtime";
/** Columns reserved for the `+` / `-` fold marker and its trailing space. */
const MARKER_WIDTH = 2;
/** Hover palette: the fold marker and the hidden `Thinking...` label switch between these. */
const AMBER_DIM: readonly [number, number, number] = [0x9c, 0x83, 0x53];
const AMBER_BRIGHT: readonly [number, number, number] = [0xf0, 0xc6, 0x74];
/** How often the borrowed theme may be refreshed while hovering (theme switches mid-session). */
const THEME_REFRESH_MS = 5000;
/** Self-heal window: a hover with no follow-up motion decays after this long if the patch is dead. */
const HOVER_DECAY_MS = 1500;
/** Cap on tracked assistant messages (evicted oldest-first; only used for repainting). */
const MESSAGE_TRACK_LIMIT = 200;
/** Prototype slots for the mouse-dispatch patch (see installMousePatch). */
const MOUSE_PATCH_SINK = "__piThinkingMouseSink";
const MOUSE_PATCH_FLAG = "__piThinkingMousePatched";
const INSTANCE_CAPTURE_FLAG = "__piThinkingInstanceCapture";

interface HoverTarget {
	component: unknown;
	runIndex: number;
}

interface State {
	/** Streaming rule switch (the config's `streaming`; field name kept from the old copy, see PATCH_MARKER). */
	enabled: boolean;
	decorate: boolean;
	/** Assistant messages rendered so far, so a settings change can repaint them (shared across module generations). */
	messages: Set<any>;
	installed: boolean;
	/** Active rule. Kept on globalThis so a reloaded extension can replace it without re-wrapping. */
	compute: (content: readonly any[]) => boolean[];
	/** Diagnostic: how many wrapper layers are installed, and which rule version they serve. */
	wraps: number;
	ruleVersion: number;
	chunk?: string;
	reason?: string;
	/** Live TUI instance, borrowed through a throwaway widget factory. */
	tui?: any;
	/** Live theme, borrowed the same way. Used for hover/marker colors. */
	theme?: Theme;
	/** Session context, kept so the borrowed theme can be refreshed. */
	ctx?: ExtensionContext;
	/** Currently highlighted block, keyed by owning message + thinking-run index. */
	hover: HoverTarget | null;
	themeCapturedAt: number;
	/** Hover-leave bookkeeping: see armDecay for how these decide whether the mouse patch is live. */
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
	// Backfill fields added after an older version created the shared state.
	state.decorate ??= true;
	state.messages ??= new Set();
	state.hover ??= null;
	state.themeCapturedAt ??= 0;
	state.lastPatchedMouseAt ??= 0;
	state.lastHoverAt ??= 0;
	state.mousePatchInstalled ??= false;
	return state;
}

/** Locate `<pi-package>/dist/bundle/chunks`, from the running CLI entry point. */
function findChunksDir(): string | undefined {
	const candidates: string[] = [];

	const entry = process.argv[1];
	if (entry) {
		// <pkg>/dist/bundle/cli.js -> <pkg>/dist/bundle/chunks
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
		// ignore: fall through to the candidates collected above
	}

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** The bundle is split into hashed chunks; find the one defining the transcript component. */
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
 * Which thinking runs should stay hidden while the message streams.
 *
 * A run is expanded only while nothing visible follows it yet: as soon as text,
 * a later thinking run, or a tool call starts streaming after it, it collapses.
 * Consecutive non-empty thinking blocks count as one run, empty ones are skipped
 * the same way the renderer skips them.
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

/** Content that makes an earlier thinking run "done": text, another run, or a tool call. */
function isVisibleBlock(block: any): boolean {
	if (block?.type === "text") return typeof block.text === "string" && !!block.text.trim();
	if (block?.type === "thinking") return typeof block.thinking === "string" && !!block.thinking.trim();
	if (block?.type === "toolCall") return true;
	return false;
}

/* ------------------------------------------------------------------ *
 * Fold marker / hover / click
 * ------------------------------------------------------------------ */

/**
 * A decorator around the renderer's own thinking `MouseRegion`.
 *
 * `render` prefixes the first line with the fold marker and indents the rest, so
 * the block keeps the exact same line count (and therefore the same mouse
 * hit-box) as the stock component. `handleMouse` claims `move` events for the
 * hover highlight and delegates everything else -- notably the left click that
 * toggles `thinkingVisibilityOverrides` -- to the wrapped region.
 *
 * The decorator also impersonates the region it wraps: it forwards `child` and
 * `onMouse` (the two fields an actual `MouseRegion` carries), so code that
 * recognises a thinking block by that shape -- another extension walking the
 * message's children, for instance -- still sees one. Without this it would see
 * an unknown wrapper instead of a thinking block.
 *
 * That recognition is a cross-package contract: `packages/timeline` accepts this
 * wrapper either because of the forwarded fields or by scanning a few levels
 * into it (depth 3), and `packages/thinking-display/test/unit.test.mjs` pins the
 * forwarding. Reshaping this class or renaming `VIEW_MARKER` breaks that fallback,
 * so tell whoever is working on timeline before doing it.
 */
class ThinkingRegionView {
	readonly region: any;
	readonly component: any;
	readonly runIndex: number;
	readonly hidden: boolean;
	/** The wrapped region's own fields, re-exposed so the wrapper is recognisable (see the class doc). */
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
		// Collapsed blocks are just the hidden label, so recolour it with the marker.
		// Expanded bodies keep the theme's thinking colour and only get bolder on hover.
		const bodyAnsi = this.hidden ? markerAnsi : undefined;
		const bodyBold = !this.hidden && hovered;

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
			if (bodyAnsi) body = recolorThinkingText(state, body, bodyAnsi);
			// Bold only the body: the marker keeps its own colour and weight.
			if (bodyBold) body = `\u001b[1m${body}\u001b[22m`;
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

/** Pad or trim a rendered line to exactly `total` columns. */
function fitLine(line: string, total: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth < total) return line + " ".repeat(total - lineWidth);
	if (lineWidth > total) return truncateToWidth(line, total, "", true);
	return line;
}

/** Amber foreground for the marker / hidden label, honouring the theme's colour mode. */
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

/** Swap the theme's `thinkingText` colour for the amber one (collapsed label only). */
function recolorThinkingText(state: State, line: string, amber: string): string {
	const theme = state.theme as { getFgAnsi?: (color: string) => string } | undefined;
	const source = typeof theme?.getFgAnsi === "function" ? theme.getFgAnsi("thinkingText") : undefined;
	if (typeof source !== "string" || source.length === 0) return line;
	return line.split(source).join(amber);
}

/** The renderer's own thinking wrapper: `{ child, onMouse, render, handleMouse }`. */
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
 * Replace every thinking `MouseRegion` in a freshly built message body with a
 * decorated view. Must run while the streaming overrides are still applied so
 * the marker reflects the same visibility the renderer is about to use.
 */
function decorateThinkingRegions(component: any): void {
	const children: any[] | undefined = component?.contentContainer?.children;
	if (!Array.isArray(children)) return;

	let runIndex = 0;
	for (let i = 0; i < children.length; i += 1) {
		const child = children[i];
		const decorated = !!child && child[VIEW_MARKER] === true;
		const region = !decorated && isMouseRegion(child);
		if (!region && !decorated) continue;

		if (region) {
			const hidden = component?.thinkingVisibilityOverrides?.get(runIndex) ?? component?.hideThinkingBlock ?? false;
			children[i] = new ThinkingRegionView(child, component, runIndex, hidden === true);
		}
		runIndex += 1;
	}
}

/* ------------------------------------------------------------------ *
 * Runtime borrowing (TUI instance + live theme) and hover-leave
 * ------------------------------------------------------------------ */

/**
 * Borrow the live `TUI` instance and `Theme` through a zero-height widget
 * factory, and from the TUI arm the hover patch. `setWidget` runs the factory
 * synchronously, so both values are available right away; the widget itself is
 * left in place (it renders no lines, which matches the blank spacer an empty
 * widget container would show anyway).
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
		// Some modes have no widget support; hover styling falls back to ANSI reverse.
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

/** Drop the current hover target and redraw so the highlight goes away. */
function clearHover(state: State, tui?: unknown): void {
	const had = state.hover;
	state.hover = null;
	clearDecay(state);
	if (!had) return;
	const instance = (tui ?? state.tui) as { requestRender?: () => void } | undefined;
	instance?.requestRender?.();
}

/**
 * Self-heal: a hover that gets no follow-up motion would stay lit forever if the
 * mouse patch were not actually delivering events, so decay it after a while.
 * When the patch is live, every hover is preceded within a few milliseconds by
 * the raw event that cleared it, so the timer leaves the highlight alone and a
 * resting pointer stays highlighted.
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

/** The block under the pointer claims the highlight (called from its MouseRegion move event). */
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

/** Raw mouse event sink: forget the highlight; a block may re-claim it right after. */
function onRawMouseEvent(tui?: unknown): void {
	const state = getState();
	state.lastPatchedMouseAt = Date.now();
	clearHover(state, tui);
}

/**
 * Patch the TUI's mouse dispatch so every raw event first drops the hover; the
 * block under the pointer then re-claims it during the same dispatch. Without
 * this the decorator never learns that the pointer left.
 *
 * The patch goes on the class prototype, not the instance: TUI mode switches
 * build fresh instances, and the wrapper reads the sink off the prototype on
 * every call so a reloaded extension module replaces it cleanly.
 */
function installMousePatch(tui: unknown): void {
	const state = getState();
	try {
		if (!tui || typeof tui !== "object") return;
		const proto = Object.getPrototypeOf(tui) as Record<string, unknown> | null;
		// Regular-mode TUIs have no component mouse dispatch; the decay timer covers them.
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
		// A failed patch only costs immediacy; armDecay takes over.
	}
}

/**
 * Second channel to a live TUI instance: its `requestRender` is invoked with
 * `this`, so wrapping it lets a later instance install the patch even when the
 * widget factory could not hand one over.
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
		// ignore: this is only a fallback channel
	}
}

/* ------------------------------------------------------------------ *
 * Installation
 * ------------------------------------------------------------------ */

async function collectComponentCandidates(): Promise<Array<{ source: string; Component: any }>> {
	const candidates: Array<{ source: string; Component: any }> = [];
	const seen = new Set<any>();
	const push = (source: string, Component: any) => {
		if (typeof Component !== "function" || seen.has(Component)) return;
		seen.add(Component);
		candidates.push({ source, Component });
	};

	// The public export is the reliable path under pi's bundled runtime: pi loads
	// extensions through jiti with virtual modules, so this specifier resolves to
	// the live namespace of the running CLI.
	try {
		const pkg = piPackage as any;
		push("package export", pkg?.AssistantMessageComponent ?? pkg?.default?.AssistantMessageComponent);
	} catch {
		// ignore: fall through to the bundle chunk
	}

	// Native require() of the bundle chunk goes through Node's own ESM cache
	// (require(esm)), so it is the same instance the CLI imported at startup.
	const chunksDir = findChunksDir();
	const chunkFile = chunksDir ? findComponentChunk(chunksDir) : undefined;
	if (chunkFile) {
		try {
			push(chunkFile, createRequire(import.meta.url)(chunkFile)?.AssistantMessageComponent);
		} catch {
			// require(esm) can fail (for example on top-level await); fall back to a
			// dynamic import, which only helps when this module itself is native.
			try {
				push(`${chunkFile} (import)`, (await import(pathToFileURL(chunkFile).href))?.AssistantMessageComponent);
			} catch {
				// ignore
			}
		}
	}

	return candidates;
}

/** Wrap `updateContent` on one concrete class. Safe to call more than once. */
function patchComponent(Component: any, _source: string): boolean {
	const state = getState();
	const proto = Component?.prototype;
	if (typeof Component !== "function" || typeof proto?.updateContent !== "function") return false;

	const existingMarker = proto[PATCH_MARKER];
	if (typeof existingMarker === "number" && existingMarker >= PATCH_VERSION) {
		// Already wrapped by this or a newer load. Publish this module's rule through
		// the shared state so the live wrapper picks it up instead of keeping a stale
		// rule (this is what makes rule changes survive /reload without a restart).
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
					// A manual click (peek at one block) outranks the automatic value.
					if (overrides.has(run)) continue;
					overrides.set(run, hiddenPerRun[run]);
					applied.push(run);
				}
			}
		}

		// Wrapper layers from earlier versions of this extension can sit underneath
		// (an older build left one behind on every /reload). They all treat
		// `enabled: false` as "pass through", and the innermost layer would otherwise
		// overwrite our overrides right before the render. Muting them while we call
		// down the chain keeps the newest rule authoritative without a restart.
		const savedEnabled = current.enabled;
		current.enabled = false;
		try {
			const result = originalUpdateContent.call(this, message, isStreaming);
			// Decorate while the automatic overrides are still applied so the fold
			// marker matches the visibility the renderer is about to use.
			if (current.decorate) {
				try {
					decorateThinkingRegions(this);
				} catch {
					// A shape change upstream must not break message rendering.
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
 * Settings (thinking-display.json + /thinking-display-settings)
 * ------------------------------------------------------------------ */

/** Remember a rendered message so a settings change can rebuild it. */
function noteMessage(state: State, component: any): void {
	const messages = (state.messages ??= new Set<any>());
	if (messages.has(component)) return;
	if (messages.size >= MESSAGE_TRACK_LIMIT) {
		const oldest = messages.values().next().value;
		if (oldest !== undefined) messages.delete(oldest);
	}
	messages.add(component);
}

/** Mirror a config file into the live state (the render hook reads the state, not the file). */
function applyConfig(state: State, config: ThinkingDisplayConfig): void {
	state.enabled = config.streaming;
	state.decorate = config.decorate;
}

/** The live state as a config object, for writing back. */
function currentConfig(state: State): ThinkingDisplayConfig {
	return { streaming: state.enabled, decorate: state.decorate };
}

/** 设置项 id: 既是面板里的行 id, 也是配置的字段名.  */
type SettingId = "streaming" | "decorate";

interface SettingDef {
	id: SettingId;
	label: string;
	description: string;
	/** 当前值(显示文案) */
	current: (state: State) => string;
}

/** 开关的显示文案(面板与降级对话框共用) */
const ON = "on";
const OFF = "off";

/**
 * 设置项表: 面板与降级对话框都从这一张表生成, 新增设置只改这里.
 * 文案目前是英文硬编码--本扩展还没做多语言; 要做时按技能 pi-ext-i18n 换成一张 zh/en 对照表,
 * 并把 `label` / `description` 改成从对照表取. 
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

/** 面板标题; 页脚显示配置文件路径(与仓库其它包的设置面板一致) */
const PANEL_TITLE = "Thinking Display Settings";

/** 命令不接受参数: 带了参数只给一句用法提示, 不动配置 */
const USAGE_HINT = "thinking-display-settings takes no arguments. Run /thinking-display-settings to open the panel.";

function boolText(value: boolean): string {
	return value ? "on" : "off";
}

/** 显示文案 → 布尔值(`current()` 的反向; 面板回调拿到的就是显示文案) */
function valueToBool(value: string): boolean {
	return value === ON;
}

/**
 * Repaint the messages that are already on screen.
 *
 * The fold marker is baked into the children of a rendered message, so a
 * settings change only becomes visible once `invalidate()` re-runs
 * `updateContent` (see noteMessage for how the components are collected).
 */
function refreshRenderedMessages(): void {
	const state = getState();
	for (const component of state.messages ?? []) {
		try {
			component?.invalidate?.();
		} catch {
			// an upstream shape change must not break the settings command
		}
	}
	(state.tui as { requestRender?: () => void } | undefined)?.requestRender?.();
}

/** Persist one setting and repaint what is on screen. */
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
 * The glyph in front of the search box is a fixed `⌕` (same as the message list's search box).
 *
 * `SettingsList` builds its search `Input` itself and exposes no prompt option, so we set the field
 * directly; if pi ever renames it we just keep the default prompt.
 */
function useSearchGlyph(list: SettingsList): void {
	try {
		const input = (list as unknown as { searchInput?: { prompt?: string } }).searchInput;
		if (input && typeof input.prompt === "string") input.prompt = "⌕ ";
	} catch {
		/* version difference: keep the default prompt */
	}
}

/**
 * Settings panel: a border, the title, the native SettingsList (with search), a footer
 * showing the config path, and a closing border. Colors come from the theme handed to
 * the `ctx.ui.custom` factory, so the look matches pi's own `/settings`.
 * Values come from the live state and every change is written to disk at once.
 */
async function openSettingsPanel(ctx: ExtensionContext): Promise<void> {
	const state = getState();

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		// Colors are built from the live `theme` handed to this factory (same values
		// as getSettingsListTheme()) so nothing depends on the global theme being
		// initialised inside this jiti-loaded module.
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
		// Title and footer are indented two columns: SettingsList renders its rows and
		// hint line from column 2, so this keeps them aligned with the list.
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
 * 有 UI 但没有自定义组件的宿主(RPC 等): 按同一张表逐项问. 
 * 取消时已经改过的项保留, 不回滚--用户看到的是"改一项存一项". 
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
	// Read the config as early as possible: pi's /reload rebuilds the transcript
	// before it emits session_start, so the hook has to serve the saved values from
	// that very first render on.
	const state = getState();
	applyConfig(state, loadConfig());

	pi.on("session_start", async (_event, ctx) => {
		// Leave behind a file that can be edited by hand (same as the sibling packages).
		// Every mode does this, not just the TUI: a headless host has no panel, so the
		// file is the only way to configure this extension there.
		if (!fs.existsSync(configPath())) saveConfig(loadConfig());

		if (ctx.mode !== "tui") return;

		// Re-read the file here as well: a hand-edited config takes effect on the
		// next session without restarting pi.
		applyConfig(state, loadConfig());
		state.ctx = ctx;
		state.hover = null;
		captureRuntime(state);

		if (await install()) return;

		// Internals changed: stay inert, but say so once per module load (a /reload
		// re-executes this module, so the flag starts out false again).
		if (!warned && state.reason && ctx.hasUI) {
			warned = true;
			ctx.ui.notify(`thinking-display is inactive: ${state.reason}`, "warning");
		}
	});

	pi.registerCommand("thinking-display-settings", {
		description: "Thinking Display Settings(thinking-display.json)",
		handler: async (args, ctx) => {
			// No arguments: the panel in the TUI, a per-item dialog when the host has a UI
			// but no custom components, a status report otherwise.
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

	// Re-capture the live TUI / theme. This is not a setting, so it is its own command
	// rather than an argument of the -settings command (see pi-ext-settings-panel).
	pi.registerCommand("thinking-display-refresh", {
		description: "Re-capture the live TUI and theme (thinking-display)",
		handler: async (_args, ctx) => {
			state.ctx = ctx;
			captureRuntime(state);
			ctx.ui.notify("thinking-display runtime refreshed", "info");
		},
	});
}
