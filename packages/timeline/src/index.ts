/*
Timeline -- 在长会话里跳转到某一条用户消息
列出会话里的用户消息, 选中后把 transcript 滚动到那条消息
需要 TUI mode
*/

import {
	DynamicBorder,
	getAgentDir,
	parseSkillBlock,
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	SelectList,
	SettingsList,
	Spacer,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type KeyId,
	type KeybindingsManager,
	type SelectListTheme,
	type SettingItem,
	type SettingsListTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	CONFIG_FILE_NAME,
	JUMP_TO_VALUES,
	LANGUAGES,
	messages,
	type JumpTo,
	type Language,
	type Messages,
	type SettingId,
} from "./i18n.ts";

// ---------------------------------------------------------------------------
// 界面语言: 文案表全在 i18n.ts, 这里只记住配置里的取值, 要用文案就 t()
// ---------------------------------------------------------------------------

/** 当前界面语言(读配置时刷新, 见 loadConfig) */
let currentLanguage: Language = "auto";

function t(): Messages {
	return messages(currentLanguage);
}

// ---------------------------------------------------------------------------
// transcript 内部结构
// ---------------------------------------------------------------------------

/**
 * Pi 给"语义标记块"的首行加的 OSC 133 标记(终端 shell 集成"跳到上一条提示符"用的同一套). 
 * 哪些块算标记块: 用户消息, 以及**不带工具调用**的助手块(也就是真正的回答). 
 * 带工具调用的助手块("我先看看..."那种开场白)不打标记--这正是 pi 原生 ctrl+↑/↓ 在
 * "用户消息 / 正文"之间交替跳的依据; 定位不对的话可以拿这个正则交叉验证. 
 */
const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;

/** 能拿来做跳转的 ScrollView 子集(避开 instanceof, 打包/虚拟模块下类身份未必一致).  */
interface ScrollViewLike {
	scrollTop: number;
	scrollTo(row: number, options?: { disableFollow?: boolean }): void;
	render(width: number): string[];
	children?: unknown[];
	primary?: boolean;
}

function isScrollViewLike(value: unknown): value is ScrollViewLike {
	const candidate = value as Partial<ScrollViewLike> | undefined;
	return (
		!!candidate &&
		typeof candidate.render === "function" &&
		typeof candidate.scrollTo === "function" &&
		typeof candidate.scrollTop === "number"
	);
}

function findPrimaryScrollView(root: unknown, depth = 0): ScrollViewLike | undefined {
	if (!root || depth > 16) return undefined;
	const node = root as { primary?: boolean; children?: unknown[] };
	if (isScrollViewLike(root) && node.primary === true) return root as ScrollViewLike;
	if (!Array.isArray(node.children)) return undefined;
	for (const child of node.children) {
		const found = findPrimaryScrollView(child, depth + 1);
		if (found) return found;
	}
	return undefined;
}

/**
 * 找到 transcript 的 ScrollView. 
 * Pi 内部自己也是通过 TuiAltScreen.getPrimaryScrollView() 拿它来做 ctrl+↑/↓ 跳转的, 
 * 只是这个方法没进公开类型; 这里按"内部方法 → 布局帧 → 布局根"的顺序探测, 失败就返回 undefined. 
 */
function resolveTranscript(tui: unknown): ScrollViewLike | undefined {
	const renderer = tui as {
		mode?: string;
		getPrimaryScrollView?: () => unknown;
		currentLayout?: { primaryScrollView?: unknown };
		layoutRoot?: unknown;
	};
	if (!renderer || renderer.mode !== "fullscreen") return undefined;
	try {
		const direct = renderer.getPrimaryScrollView?.();
		if (isScrollViewLike(direct) && (direct as { primary?: boolean }).primary === true) return direct;
	} catch {
		/* 版本差异, 继续用下面的兜底 */
	}
	try {
		const fromFrame = renderer.currentLayout?.primaryScrollView;
		if (isScrollViewLike(fromFrame)) return fromFrame;
	} catch {
		/* ignore */
	}
	return findPrimaryScrollView(renderer.layoutRoot) ?? findPrimaryScrollView(tui);
}

/** 布局帧里对应 ScrollView 的盒子(结构和 pi-tui 的 getScrollViewBox 一致, 只是不引它的深路径).  */
function findScrollBox(box: any, view: ScrollViewLike): any {
	if (!box) return undefined;
	if (box.scrollView === view) return box;
	for (const child of box.children ?? []) {
		const found = findScrollBox(child, view);
		if (found) return found;
	}
	return undefined;
}

/**
 * transcript 当前渲染出的完整行(含 ANSI / OSC 转义). 
 * 优先用布局帧里缓存的那些行--那正是渲染到屏幕上的内容, 行号才能和 scrollTo 对上. 
 */
function transcriptLines(tui: unknown, view: ScrollViewLike): string[] {
	const renderer = tui as { currentLayout?: { root?: unknown }; terminal?: { columns?: number } };
	try {
		const box = findScrollBox(renderer.currentLayout?.root, view);
		const cached = box?.scrollContentLines;
		if (Array.isArray(cached) && cached.length > 0) return cached as string[];
	} catch {
		/* ignore */
	}
	return view.render(renderer.terminal?.columns ?? 80);
}

// ---------------------------------------------------------------------------
// 文本处理
// ---------------------------------------------------------------------------

function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC(含 OSC 133 标记与超链接)
		.replace(/\x1b_pi:c\x07/g, "") // 光标标记
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
		.replace(/\x1b[()][A-Za-z0-9]/g, "")
		.replace(/\x1b[=>]/g, "");
}

/**
 * 比对用的归一化: 去掉空白和 markdown 装饰字符. 
 * 渲染会重排文本, 丢掉 `**`/`` ` ``/`#` 之类的记号, 两边按同一套规则抹平才能对上. 
 */
function normalize(text: string): string {
	return stripAnsi(text)
		.replace(/\s+/g, "")
		.replace(/[*_`#>~|[\]()]/g, "");
}

/** 折成一行, 用于列表里的预览.  */
function collapse(text: string): string {
	return stripAnsi(text).replace(/\s+/g, " ").trim();
}

function previewOf(text: string, max = 100): string {
	const line = collapse(text);
	return line.length > max ? `${line.slice(0, max - 1)}...` : line;
}

function formatTime(value: unknown): string {
	const date = typeof value === "number" ? new Date(value) : typeof value === "string" ? new Date(value) : undefined;
	if (!date || Number.isNaN(date.getTime())) return "";
	const now = new Date();
	const sameDay =
		date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
	const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

/** 消息文本, 和 Pi 的 getUserMessageText() 一致: 拼接所有 text 片段.  */
function messageText(message: any): string {
	if (!message || message.role !== "user") return "";
	return contentText(message.content);
}

/** 助手消息的正文(多个 text 片段拼起来).  */
function assistantText(message: any): string {
	if (!message || message.role !== "assistant") return "";
	return contentText(message.content);
}

function contentText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("");
}

// ---------------------------------------------------------------------------
// 会话 → 列表项
// ---------------------------------------------------------------------------

interface TimelineItem {
	kind: "user" | "bash";
	entryId: string;
	/** 放进输入框用的完整文本(用户消息的原文, 不含技能块包装) */
	text: string;
	/** 和渲染出来的组件对齐用的原文(`!命令` 只取命令本身) */
	matchText: string;
	preview: string;
	time: string;
	badge?: string;
}

interface PickerData {
	items: TimelineItem[];
}

/**
 * 和 pi 的 projectContextEntry 一致: `context_edit` 条目会把目标消息的内容换成 replacement
 * (null 表示整条删掉). 列表里的文本必须用投影后的, 不然和渲染出来的组件对不上. 
 */
function projectReplacement(messages: any[], replacement: any): any[] {
	if (!replacement) return messages;
	return messages.map((message) => {
		const role = message?.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") return message;
		const content =
			(role === "assistant" || role === "toolResult") && typeof replacement.content === "string"
				? [{ type: "text", text: replacement.content }]
				: replacement.content;
		return { ...message, content };
	});
}

/**
 * 从当前会话收集候选消息. 
 *
 * 只取 buildContextEntries()--也就是 Pi 真正渲染进 transcript 的那批条目: 
 * 压缩之后消失的旧消息不在里面, 跳过去也没有意义. 
 * 取哪些消息, 什么条件下渲染, 都和 pi 的 addMessageToChat 一一对应--
 * 列表项和转录组件是靠**顺序**一一对上的, 两边少一条都会事. 
 */
function buildPickerData(ctx: ExtensionContext): PickerData {
	const manager = ctx.sessionManager as unknown as {
		buildContextEntries?: () => any[];
		getBranch?: () => any[];
	};
	const entries = manager.buildContextEntries?.() ?? manager.getBranch?.() ?? [];

	// `context_edit` 会改写目标消息的内容, 先收集起来
	const edits = new Map<string, any>();
	for (const entry of entries) {
		if (entry?.type === "context_edit" && typeof entry.targetId === "string") edits.set(entry.targetId, entry);
	}

	const items: TimelineItem[] = [];

	for (const entry of entries) {
		let messages: any[];
		try {
			messages = sessionEntryToContextMessages(entry) ?? [];
		} catch {
			messages = entry?.type === "message" && entry.message ? [entry.message] : [];
		}

		const edit = typeof entry?.id === "string" ? edits.get(entry.id) : undefined;
		if (edit) {
			if (edit.replacement === null) continue; // 被删掉的消息不渲染, 也不该出现在列表里
			messages = projectReplacement(messages, edit.replacement);
		}

		for (const message of messages) {
			const role = message?.role;

			if (role === "user") {
				// 和 pi 的 `if (textContent)` 一致: 空文本不渲染; 空白消息照渲染, 所以也要占一项
				const text = messageText(message);
				if (!text) continue;

				let body = text;
				let badge: string | undefined;
				try {
					const skill = parseSkillBlock(text);
					if (skill) {
						if (!skill.userMessage) continue; // 只渲染了技能头部, 没有用户气泡
						body = skill.userMessage;
						badge = `⚡${skill.name}`;
					}
				} catch {
					/* 技能块解析失败就当普通文本处理 */
				}

				items.push({
					kind: "user",
					entryId: entry.id,
					text: body,
					matchText: body,
					preview: previewOf(body) || t().emptyMessage,
					time: formatTime(entry.timestamp),
					badge,
				});
				continue;
			}

			if (role === "assistant") {
				// 助手正文不列进列表(列表只要用户消息); 它的组件会在定位时被读到, 
				// 用来支持 jumpTo: "reply"(跳到这条用户消息下面的正文)
				continue;
			}

			if (role === "bashExecution" && typeof message.command === "string") {
				// `!命令`: 渲染成 BashExecutionComponent, 也能按组件精确定位到
				items.push({
					kind: "bash",
					entryId: entry.id,
					text: `!${message.command}`,
					matchText: message.command,
					preview: previewOf(`!${message.command}`) || "!",
					time: formatTime(message.timestamp),
				});
			}
		}
	}

	return { items };
}

// ---------------------------------------------------------------------------
// 消息 → 行号
// ---------------------------------------------------------------------------

function promptMarkerRows(lines: string[]): number[] {
	const rows: number[] = [];
	for (let row = 0; row < lines.length; row++) {
		if (OSC133_PROMPT_START.test(lines[row] ?? "")) rows.push(row);
	}
	return rows;
}

/**
 * key 在 block 里能匹配多长. 整串命中最好; 渲染会改写 markdown 开头
 * (`# `, `- `, `> `, 代码围栏等), 所以再退回按前缀 / 中间片段匹配. 
 */
function matchScore(block: string, key: string): number {
	if (!block || !key) return 0;
	if (block.includes(key)) return key.length;
	for (const length of [24, 16, 12, 8, 6]) {
		if (length > key.length) continue;
		if (block.includes(key.slice(0, length))) return length;
		for (let start = 1; start + length <= key.length; start++) {
			if (block.includes(key.slice(start, start + length))) return length;
		}
	}
	return 0;
}

function findLineWithText(lines: string[], key: string, from: number): number | undefined {
	for (const length of [24, 16, 8, Math.min(6, key.length)]) {
		if (length <= 0) continue;
		const needle = key.slice(0, length);
		for (let row = Math.max(0, from); row < lines.length; row++) {
			if (normalize(lines[row] ?? "").includes(needle)) return row;
		}
	}
	return undefined;
}

/**
 * 按组件精确定位: 给每条消息算出它第一行在内容里的行号. 
 *
 * 依据: 布局帧里 transcript 那个滚动盒子的孩子就是整份文档, ScrollView 的内容就是这份文档的渲染结果, 
 * 所以文档的第一行就是内容的第 0 行; 而文档/聊天容器都是普通 Container, 
 * `render` 就是把子组件的行首尾拼起来, 于是按顺序累加每个子组件 `render(width).length` 就能算出起始行. 
 *
 * 比数 OSC 133 标记再猜可靠得多: 只有工具调用, 没有文字的助手消息根本不产生标记, 
 * 流式中的消息又多出一个还没落盘的组件, 两头一抵消就会整体错位. 
 * 而组件本身带着原文(用户消息的 text, `!命令`的 command), 可以直接和会话条目对上. 
 */
interface MessageRecord {
	kind: "user" | "assistant" | "bash";
	/** 该组件第一行的内容行号(也就是带 OSC 133 标记的那一行) */
	row: number;
	/** 组件占多少行 */
	height: number;
	/** 组件持有的原文, 用来和会话条目对上 */
	text: string;
	/** 是不是 pi 眼里的"语义标记块"(用户消息 / 不带工具调用的助手回答) */
	landmark: boolean;
	/** 助手块里带不带思考: 带思考就跳过思考落正文, 不带就落块首(= pi 原生) */
	hasThinking?: boolean;
	/** 正文起点在块内的偏移, 含紧邻正文的一行空白(带思考的块才用得上) */
	textOffset?: number;
}

/** 命中的消息在渲染里的位置 */
interface LocatedMessage {
	row: number;
	/** 在 MessageRecord 序列里的下标 */
	index: number;
}

function classifyComponent(component: any): MessageRecord["kind"] | undefined {
	if (!component || typeof component !== "object") return undefined;
	// UserMessageComponent
	if (typeof component.text === "string" && typeof component.rebuild === "function" && typeof component.outputPad === "number") {
		return "user";
	}
	// AssistantMessageComponent
	if (typeof component.updateContent === "function" && "lastMessage" in component) return "assistant";
	// BashExecutionComponent(`!命令`)
	if (typeof component.command === "string" && Array.isArray(component.outputLines) && typeof component.appendOutput === "function") {
		return "bash";
	}
	return undefined;
}

/** 有 children 的容器候选(是不是真"纯拼接"由 walk 里的高度校验定, 不靠类名) */
function isPlainContainer(component: any): boolean {
	return !!component && Array.isArray(component.children) && component.children.length > 0;
}

function collectMessageRecords(tui: any, view: ScrollViewLike): { records: MessageRecord[]; lines: string[] } | undefined {
	const frame = tui?.currentLayout;
	const scrollBox = findScrollBox(frame?.root, view);
	const document = scrollBox?.children?.[0]?.component ?? (view as any).child;
	if (!document || typeof document.render !== "function") return undefined;

	const columns = scrollBox?.rect?.width ?? tui?.terminal?.columns ?? 80;
	const width = typeof view.getContentWidth === "function" ? view.getContentWidth(columns) : columns;

	// 只算每个叶子/消息组件的高度, 容器不重复渲染(长会话动辄几万行, 这一步很贵)
	const records: MessageRecord[] = [];
	let total = 0; // 文档的第一行就是内容的第 0 行
	walk(document);

	// 完整性校验: 累加高度必须正好等于内容行数. 坐标系只信**现在这一遍**渲染出来的行: 
	// 布局帧缓存的行可能是上一帧的(正在流式输出 / 别的扩展改了渲染), 拿它当坐标系就会错位; 
	// 以前对不上就 `view.render(columns)` 再试一次--那返回的是**视口那几十行**, 长会话永远对不上, 
	// 于是悄悄退回模糊的标记匹配("有概率定位错"就是这么来的). 
	let lines: string[];
	try {
		lines = document.render(width);
	} catch {
		return undefined;
	}
	if (total !== lines.length) return undefined;
	return { records, lines };

	function walk(component: any): void {
		if (!component || typeof component.render !== "function") return;
		const kind = classifyComponent(component);
		if (kind) {
			const height = component.render(width).length;
			const thinking = kind === "assistant" ? hasThinkingPart(component?.lastMessage) : false;
			records.push({
				kind,
				row: total,
				height,
				text: String(kind === "bash" ? (component.command ?? "") : kind === "assistant" ? assistantText(component.lastMessage) : (component.text ?? "")),
				// 带工具调用的助手块在 pi 那里不算"正文/提示符"(不打 OSC 133 标记)
				landmark: kind === "assistant" ? component.hasToolCalls !== true : kind === "user",
				hasThinking: thinking,
				textOffset: thinking ? assistantBodyOffset(component, width) : undefined,
			});
			total += height;
			return;
		}
		if (isPlainContainer(component)) {
			// 容器只有在"渲染 == 子组件行拼接"时才往下钻: ToolExecutionComponent 这类
			// Container 子类会自己画额外的行(工具头 / 图片 / 缩进), 往下钻就丢行--累加高度
			// 和真实渲染对不上, 整个精确路径作废(退回模糊的标记匹配, 甚至跳到用户消息). 
			// 对不上的整块按叶子算高度, 行号照样是准的. 
			const rendered = component.render(width);
			let childTotal = 0;
			let plain = true;
			for (const child of component.children) {
				if (!child || typeof child.render !== "function") {
					plain = false;
					break;
				}
				childTotal += child.render(width).length;
			}
			if (plain && childTotal === rendered.length) {
				for (const child of component.children) walk(child);
				return;
			}
			total += rendered.length;
			return;
		}
		total += component.render(width).length;
	}
}

/** 把列表项和渲染出来的组件对上: 先认原文完全一致的, 认不上就按顺序取下一个同类组件. 
 * 同时记住它在组件序列里的下标, 后续要拿它后面的"正文".  */
/**
 * 把列表项和转录里的组件按顺序对上(按 kind 分别对齐). 
 *
 * 两边出自同一批会话条目, 顺序一致: pi 每条有文本的用户消息渲染成一个
 * UserMessageComponent, 每条 `!命令` 一个 BashExecutionComponent, 严格一一对应. 
 * 所以以**位置**为准, 文本只当锚点: 归一化后在两边都恰好只出现一次的文本是确定配对, 
 * 锚点之间的区间按顺序平移. 这样重复发同一句话, 某条文本被改写, 中间少了一条, 
 * 都不会整段串位--纯文本比对会把后一条消息认到前面同文本的组件上, 
 * 表现就是"有时对有时错". 
 */
function locateRowsFromRecords(items: TimelineItem[], records: MessageRecord[]): Array<LocatedMessage | undefined> {
	const located: Array<LocatedMessage | undefined> = items.map(() => undefined);

	for (const kind of ["user", "bash"] as const) {
		const itemIndices: number[] = [];
		for (let index = 0; index < items.length; index++) if (items[index].kind === kind) itemIndices.push(index);
		const recordIndices: number[] = [];
		for (let index = 0; index < records.length; index++) if (records[index].kind === kind) recordIndices.push(index);
		if (itemIndices.length === 0 || recordIndices.length === 0) continue;

		// 锚点: 归一化文本在两边都恰好只出现一次
		const itemByText = new Map<string, number[]>();
		for (let position = 0; position < itemIndices.length; position++) {
			const key = normalize(items[itemIndices[position]].matchText);
			if (!key) continue;
			const list = itemByText.get(key) ?? [];
			list.push(position);
			itemByText.set(key, list);
		}
		const recordByText = new Map<string, number[]>();
		for (let position = 0; position < recordIndices.length; position++) {
			const key = normalize(records[recordIndices[position]].text ?? "");
			if (!key) continue;
			const list = recordByText.get(key) ?? [];
			list.push(position);
			recordByText.set(key, list);
		}
		const anchors: Array<[number, number]> = [];
		for (const [key, itemPositions] of itemByText) {
			if (itemPositions.length !== 1) continue;
			const recordPositions = recordByText.get(key);
			if (!recordPositions || recordPositions.length !== 1) continue;
			anchors.push([itemPositions[0], recordPositions[0]]);
		}
		anchors.sort((left, right) => left[0] - right[0]);
		// 两边顺序对不上的锚点丢掉(以先到者为准), 后面的区间照样重新对齐
		const kept: Array<[number, number]> = [];
		let lastRecordPosition = -1;
		for (const anchor of anchors) {
			if (anchor[1] <= lastRecordPosition) continue;
			kept.push(anchor);
			lastRecordPosition = anchor[1];
		}

		// 区间内按顺序平移; 两侧数量不齐时多出来的那截不配对, 下个锚点重新对上
		let itemPosition = 0;
		let recordPosition = 0;
		const zip = (itemEnd: number, recordEnd: number): void => {
			while (itemPosition < itemEnd && recordPosition < recordEnd) {
				located[itemIndices[itemPosition]] = {
					row: records[recordIndices[recordPosition]].row,
					index: recordIndices[recordPosition],
				};
				itemPosition += 1;
				recordPosition += 1;
			}
			itemPosition = Math.max(itemPosition, itemEnd);
			recordPosition = Math.max(recordPosition, recordEnd);
		};
		for (const [anchorItemPosition, anchorRecordPosition] of kept) {
			zip(anchorItemPosition, anchorRecordPosition);
			located[itemIndices[anchorItemPosition]] = {
				row: records[recordIndices[anchorRecordPosition]].row,
				index: recordIndices[anchorRecordPosition],
			};
			itemPosition = anchorItemPosition + 1;
			recordPosition = anchorRecordPosition + 1;
		}
		zip(itemIndices.length, recordIndices.length);
	}

	return located;
}

/**
 * 落脚的那条记录. 
 *
 * `reply` = 这条消息之后**第一个"正文块"**(不带工具调用的助手块, pi 的 ctrl+↓ 目标, 它首行有
 * OSC 133 标记). 中间那些带工具调用的块("我先看看..."开场白, 几十个只有工具调用的块)会被跳过. 
 * 不限定在"这一轮"里: 用户中途打断时这一轮可能只有工具调用, 没有正文, 那种时候最近的下一段
 * 正文才是有用的落点(连发的几条消息也自然共享同一个正文). 
 */
function pickAnchorRecord(located: LocatedMessage, records: MessageRecord[], jumpTo: JumpTo): MessageRecord | undefined {
	if (jumpTo !== "reply") return records[located.index];

	// 优先找**带文字**的正文块: 思考也算内容, 但用户要的"正文"是文字; 
	// 半截/被打断的回答可能只有思考没有文字, 那种块往后放. 
	for (let k = located.index + 1; k < records.length; k++) {
		if (records[k].kind === "assistant" && records[k].landmark && (records[k].text ?? "").trim()) return records[k];
	}
	for (let k = located.index + 1; k < records.length; k++) {
		if (records[k].kind === "assistant" && records[k].landmark) return records[k];
	}

	// 后面没有任何正文块: 退而求其次--最后一条有文字的助手块 → 最后一条助手块 → 下一个块 → 它自己
	let lastWithText: MessageRecord | undefined;
	let lastAssistant: MessageRecord | undefined;
	for (let k = located.index + 1; k < records.length; k++) {
		if (records[k].kind !== "assistant") continue;
		lastAssistant = records[k];
		if ((records[k].text ?? "").trim()) lastWithText = records[k];
	}
	return lastWithText ?? lastAssistant ?? records[located.index + 1] ?? records[located.index];
}

/**
 * 纯兜底: 数量 / 组件都拿不到时, 用 OSC 133 标记块 + 文本比对找. 
 * 只认"文本落在块开头附近"的块--用户消息的正文就是紧跟在标记后面, 
 * 这样不会跳到助手消息里引用同一句话的地方. 
 */
function locateRowsByMarkers(
	items: TimelineItem[],
	lines: string[],
	markerRows: number[],
	jumpTo: JumpTo,
): { rows: Array<number | undefined>; blockRows: Array<number | undefined> } {
	const rows: Array<number | undefined> = items.map(() => undefined);
	const blockRows: Array<number | undefined> = items.map(() => undefined);
	const blocks: string[] = [];
	const headLines: string[] = []; // 标记行后面前几行, 用来判断"正文是不是就在开头"
	for (let index = 0; index < markerRows.length; index++) {
		const start = markerRows[index];
		const end = markerRows[index + 1] ?? lines.length;
		blocks.push(normalize(lines.slice(start, end).join("\n")));
		headLines.push(normalize(lines.slice(start, Math.min(end, start + 5)).join("\n")));
	}

	let cursor = 0;
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const key = normalize(item.matchText);
		if (!key) continue;
		// 阈值不能太松: 只拿 6 个字符当线索的话, 同开头的消息(好几个"fabric...")会互相认错
		const threshold = Math.min(12, key.length);

		let best = -1;
		let bestScore = threshold - 1;
		for (let markerIndex = cursor; markerIndex < blocks.length; markerIndex++) {
			const score = matchScore(blocks[markerIndex], key);
			if (score < threshold) continue;
			const nearStart = matchScore(headLines[markerIndex], key) >= threshold;
			const weighted = score + (nearStart ? 1000 : 0); // 正文就在块开头 → 优先
			if (weighted > bestScore) {
				bestScore = weighted;
				best = markerIndex;
				if (nearStart) break;
			}
		}
		if (best >= 0) {
			blockRows[index] = markerRows[best];
			// 跳到"下方正文"时, 拿下一个标记块; 没有下一个就还是它自己
			rows[index] = jumpTo === "reply" ? (markerRows[best + 1] ?? markerRows[best]) : markerRows[best];
			cursor = best + 1;
			continue;
		}

		// `!命令`这类没有标记的块: 按整行文本找
		const found = findLineWithText(lines, key, rows[index - 1] ?? 0);
		if (found !== undefined) {
			const next = jumpTo === "reply" ? markerRows.find((row) => row > found) : undefined;
			rows[index] = next ?? found;
			blockRows[index] = found;
		}
	}
	return { rows, blockRows };
}

/** pi 自己包思考块的 MouseRegion: `{ child, onMouse }` */
function isMouseRegion(value: any): boolean {
	return !!value && typeof value === "object" && typeof value.onMouse === "function" && "child" in value;
}

/**
 * 这个子组件是"思考块"吗? 
 *
 * pi 把每段思考包在 `MouseRegion` 里, 但别的扩展会在外面再套一层自己的外壳
 * (thinking-display 的折叠标记就是这样: 外层是它自己的 view, 里面才是 MouseRegion). 
 * 所以除了自己就是 MouseRegion, 还往下找几层; 只往普通对象里找(正文 Markdown 的
 * `cachedLines` 是几千行字符串), 设深度上限防环. 
 */
function isThinkingChild(value: any, depth = 0): boolean {
	if (isMouseRegion(value)) return true;
	if (depth >= 3 || !value || typeof value !== "object" || Array.isArray(value)) return false;
	for (const key of Object.keys(value)) {
		const inner = value[key];
		if (inner && typeof inner === "object" && isThinkingChild(inner, depth + 1)) return true;
	}
	return false;
}

/** 消息里带不带思考段 */
function hasThinkingPart(message: any): boolean {
	const content: any[] = Array.isArray(message?.content) ? message.content : [];
	return content.some((part: any) => part?.type === "thinking" && String(part.thinking ?? "").trim());
}

/** 消息里的正文段(pi 每段 text 渲染成一个 Markdown, 源文本就是这段去掉首尾空白) */
function assistantTextParts(message: any): string[] {
	const content: any[] = Array.isArray(message?.content) ? message.content : [];
	return content
		.filter((part: any) => part?.type === "text" && String(part.text ?? "").trim())
		.map((part: any) => String(part.text).trim());
}

/**
 * 这个子组件在渲染"正文段"吗? 按**内容**认: 它(或它包着的内层)的源文本正好是消息里某一段
 * text. 比按形状认准--形状只认"pi 的思考块长什么样", 别的扩展把思考块换成自己的东西时
 * (见 pitfalls)就会认错, 源文本比对不受影响. 
 */
function hasTextSource(value: any, parts: string[], depth = 0): boolean {
	if (!value || typeof value !== "object" || parts.length === 0) return false;
	if (typeof value.text === "string" && parts.includes(value.text.trim())) return true;
	if (depth >= 2 || Array.isArray(value)) return false;
	for (const key of Object.keys(value)) {
		const inner = value[key];
		if (inner && typeof inner === "object" && hasTextSource(inner, parts, depth + 1)) return true;
	}
	return false;
}

/**
 * 带思考的助手块里正文的起点(块内偏移行数), 保留正文前紧邻的一行空白.
 * 认正文先按内容(源文本 == 消息里的 text 段), 认不出再按形状(第一个不是思考块的可见块). 
 * 只在前一行确实为空时向前一行, 不硬减偏移, 避免把思考末行带回视口.
 */
function assistantBodyOffset(component: any, width: number): number | undefined {
	const children: any[] | undefined = component?.contentContainer?.children;
	if (!Array.isArray(children) || children.length === 0) return undefined;
	const parts = assistantTextParts(component?.lastMessage);
	const entries: Array<{ child: any; offset: number; visible: boolean }> = [];
	let offset = 0;
	let previousLine: string | undefined;
	for (const child of children) {
		const lines: string[] = typeof child?.render === "function" ? child.render(width) : [];
		const anchor = offset > 0 && previousLine !== undefined && stripAnsi(previousLine).trim() === "" ? offset - 1 : offset;
		entries.push({ child, offset: anchor, visible: lines.some((line) => stripAnsi(line).trim().length > 0) });
		offset += lines.length;
		if (lines.length > 0) previousLine = lines[lines.length - 1];
	}
	for (const entry of entries) {
		if (entry.visible && hasTextSource(entry.child, parts)) return entry.offset;
	}
	for (const entry of entries) {
		if (entry.visible && !isThinkingChild(entry.child)) return entry.offset;
	}
	return undefined;
}

/**
 * 落脚行. 
 *
 * - 纯文本回复: **块的第一行**--和 pi 原生 `Ctrl+↑/↓`(`scrollToPrompt`)逐行一致(它认的
 *   就是行首带 OSC 133 块标记的那行, 也就是块首的上边距). 
 * - 回复块里**带思考**: 跳过思考, 保留正文前紧邻的一行空白(没有空行就落正文).
 *   既不让几十行思考把正文推出屏幕, 也不让正文贴在视口最上沿.
 */
function anchoredRow(record: MessageRecord | undefined): number | undefined {
	if (!record) return undefined;
	if (record.kind === "assistant" && record.hasThinking && record.textOffset !== undefined) {
		return record.row + record.textOffset;
	}
	return record.row;
}

/**
 * 滚到目标行. 
 *
 * 先把 ScrollView 的布局状态(内容总行数 / 视口高度)补到这一遍量出来的值, 再滚: 
 * 它可能是上一拍的(内容长了还没重绘), `scrollTo` 会把目标**夹到旧的边界**上, 
 * 落点看着就"有概率错". `updateLayout` 是 pi-tui 布局系统自己调的那个入口, 
 * 这里原样保留它原来的渲染回调(否则后续滚动不再触发重绘). 
 */
function jumpToRow(view: ScrollViewLike, row: number, contentHeight: number | undefined): void {
	try {
		const internal = view as unknown as {
			updateLayout?: (contentHeight: number, viewportHeight: number, requestRender: () => void) => void;
			requestRenderCallback?: () => void;
		};
		if (contentHeight !== undefined && typeof internal.updateLayout === "function") {
			const requestRender = typeof internal.requestRenderCallback === "function" ? internal.requestRenderCallback : () => {};
			internal.updateLayout(contentHeight, (view as unknown as { viewportHeight?: number }).viewportHeight ?? 0, requestRender);
		}
	} catch {
		/* 版本差异: 当作没这回事, 照常滚 */
	}
	view.scrollTo(row, { disableFollow: true });
}

/**
 * 排障用: 扩展目录里放一个 `debug.flag` 文件, 每次定位/跳转就把内部算出的
 * 列表项, 组件记录, 配对和落点写进 `debug-dump.json`(不放旗标就完全不写). 
 */
let lastLocateDebug: Record<string, unknown> | undefined;
function debugDump(payload: Record<string, unknown>): void {
	try {
		const dir = extensionDir();
		if (!existsSync(join(dir, "debug.flag"))) return;
		writeFileSync(join(dir, "debug-dump.json"), JSON.stringify({ at: new Date().toISOString(), ...payload }, undefined, 1), "utf8");
	} catch {
		/* 诊断不影响功能 */
	}
}

/** 定位结果: 跳转目标行 + 每条消息自己的块首行(判断"正在看哪一轮"用) + 内容总行数.  */
interface LocateResult {
	rows: Array<number | undefined>;
	blockRows: Array<number | undefined>;
	contentHeight?: number;
}

/** 优先按组件精确定位; 组件结构识别不了(Pi 改了内部实现)再退回标记匹配.  */
function locateRows(items: TimelineItem[], tui: any, view: ScrollViewLike, jumpTo: JumpTo): LocateResult {
	const collected = collectMessageRecords(tui, view);
	if (collected && collected.records.length > 0) {
		const located = locateRowsFromRecords(items, collected.records);
		if (located.some((item) => item !== undefined)) {
			const rows = located.map((item) => {
				if (!item) return undefined;
				// 纯文本落块首; 带思考时落正文, 保留正文前的一行空白.
				return anchoredRow(pickAnchorRecord(item, collected.records, jumpTo));
			});
			const blockRows = located.map((item) => (item ? collected.records[item.index].row : undefined));
			lastLocateDebug = {
			path: "component",
				jumpTo,
				total: collected.records.reduce((sum, record) => Math.max(sum, record.row + record.height), 0),
				lines: collected.lines.length,
				items: items.map((item, index) => ({ index, kind: item.kind, text: item.matchText.slice(0, 40) })),
				records: collected.records.map((record, index) => ({
					index,
					kind: record.kind,
					row: record.row,
					height: record.height,
					landmark: record.landmark,
					text: record.text.slice(0, 40),
				})),
				pairs: located.map((item, index) => ({ item: index, record: item?.index, row: rows[index] })),
				rows,
				blockRows,
			};
			return { rows, blockRows, contentHeight: collected.lines.length };
		}
	}
	const lines = collected?.lines ?? transcriptLines(tui, view);
	const matched = locateRowsByMarkers(items, lines, promptMarkerRows(lines), jumpTo);
	lastLocateDebug = {
		path: "markers",
		jumpTo,
		lines: lines.length,
		markerRows: promptMarkerRows(lines),
		items: items.map((item, index) => ({ index, kind: item.kind, text: item.matchText.slice(0, 40) })),
		rows: matched.rows,
		blockRows: matched.blockRows,
		contentHeight: lines.length,
	};
	return matched;
}

// ---------------------------------------------------------------------------
// 选择界面
// ---------------------------------------------------------------------------

type PickerResult = { action: "jump" | "insert"; index: number };

/**
 * 给内容套一个完整的圆角框. 
 * pi 自带的 DynamicBorder 只画上下两条横线, 左右是空的, 看着像个没封口的表格. 
 */
function renderFrame(lines: string[], width: number, theme: Theme): string[] {
	const border = (text: string) => theme.fg("accent", text);
	const safeWidth = Math.max(4, width);
	const innerWidth = safeWidth - 4; // "│ " + 内容 + " │"
	const dashes = "─".repeat(Math.max(0, safeWidth - 2));

	const output = [border(`╭${dashes}╮`)];
	for (const line of lines) {
		const text = truncateToWidth(line, innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
		output.push(`${border("│")} ${text}${padding} ${border("│")}`);
	}
	output.push(border(`╰${dashes}╯`));
	return output;
}

/** 把容器包进框里; 容器按内宽渲染, 保证子组件自己换行时也算得对.  */
function framed(container: Container, theme: Theme): Component {
	return {
		invalidate() {
			container.invalidate();
		},
		render(width: number) {
			return renderFrame(container.render(Math.max(8, width - 4)), width, theme);
		},
	};
}

/** 斜体: 正常主题都带 italic; 万一碰到不带的(比如测试桩), 就保持原样而不是炸掉整个面板.  */
function italic(theme: Theme, text: string): string {
	const apply = (theme as unknown as { italic?: (value: string) => string }).italic;
	return typeof apply === "function" ? apply.call(theme, text) : text;
}

function buildPicker(
	items: TimelineItem[],
	rows: Array<number | undefined>,
	currentIndex: number,
	jumpTo: JumpTo,
	theme: Theme,
	tui: TUI,
	kb: KeybindingsManager,
	done: (result: PickerResult | null) => void,
): Component {
	const container = new Container();

	const hidden = items.length - rows.filter((row) => row !== undefined).length;
	const header = [
		// 标题名保持强调色; 模式居中, 数量(含它前面那个 ·)用灰色放最后
		theme.fg("accent", theme.bold("Timeline")),
		// 当前模式一眼可见: 跳转落到消息本身还是下面的正文(和条数同一档灰, 连前面的 ·)
		theme.fg("muted", t().pickerMode(jumpTo === "reply" ? "reply" : "user")),
		theme.fg("muted", t().pickerCount(items.length)),
		hidden > 0 ? theme.fg("warning", t().pickerUnlocatable(hidden)) : "",
	]
		.filter(Boolean)
		.join(" ");
	container.addChild(new Text(header, 1, 0));

	const search = new Input({
		prompt: "⌕ ",
		placeholder: t().pickerFilter,
		placeholderStyle: (text: string) => italic(theme, theme.fg("dim", text)), // 占位提示: 暗灰 + 斜体, 不和输入内容抢眼
	});
	search.focused = true;
	container.addChild(search);

	const maxVisible = Math.max(5, Math.min(15, Math.floor((tui.terminal?.rows ?? 24) * 0.5) - 3));
	const state = { query: "", filtered: [] as number[], selected: 0 };

	const refilter = () => {
		const needle = state.query.trim().toLowerCase();
		state.filtered = items
			.map((_, index) => index)
			.filter((index) => {
				if (!needle) return true;
				const item = items[index];
				return `${item.preview} ${item.text} ${item.badge ?? ""} ${item.time}`.toLowerCase().includes(needle);
			});
		state.selected = 0;
	};
	refilter();
	// 打开时光标就停在"当前这一轮"的消息上(定位不到就停在第一条)
	const startPosition = currentIndex >= 0 ? state.filtered.indexOf(currentIndex) : -1;
	if (startPosition >= 0) state.selected = startPosition;

	const list: Component = {
		invalidate() {},
		render(width: number): string[] {
			if (state.filtered.length === 0) {
				return [theme.fg("muted", t().pickerNoMatch)];
			}

			const start = Math.max(0, Math.min(state.selected - Math.floor(maxVisible / 2), state.filtered.length - maxVisible));
			const end = Math.min(start + maxVisible, state.filtered.length);
			const output: string[] = [];

			for (let position = start; position < end; position++) {
				const index = state.filtered[position];
				const item = items[index];
				const isSelected = position === state.selected;
				const row = rows[index];

				let right = item.time;
				if (index === currentIndex) right = right ? `${right} ·${t().currentTag}` : t().currentTag;
				if (row === undefined) right = right ? `${right} ·${t().unlocatableTag}` : t().unlocatableTag;
				const rightText = theme.fg("dim", right);

				const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
				const roleMark = item.kind === "bash" ? theme.fg("dim", "$ ") : "";
				const label = `#${index + 1} ${roleMark}${item.badge ? `${item.badge} ` : ""}${item.preview}`;
				const text = isSelected ? theme.bold(theme.fg("accent", label)) : label;

				const available = Math.max(10, width - 2 - (right ? visibleWidth(rightText) + 2 : 0));
				const left = truncateToWidth(`${cursor}${text}`, available, "...");
				const pad = " ".repeat(Math.max(0, width - available - (right ? visibleWidth(rightText) + 2 : 0)));
				output.push(right ? `${left}${pad}  ${rightText}` : left);
			}

			if (state.filtered.length > maxVisible) {
				output.push(theme.fg("muted", `  (${state.selected + 1}/${state.filtered.length})`));
			}
			return output;
		},
	};
	container.addChild(list);

	container.addChild(
		new Text(
			theme.fg("dim", t().pickerHint),
			1,
			0,
		),
	);

	const move = (delta: number) => {
		if (state.filtered.length === 0) return;
		const next = state.selected + delta;
		const total = state.filtered.length;
		state.selected = next < 0 ? total - 1 : next >= total ? 0 : next;
	};
	const confirm = (action: "jump" | "insert") => {
		const index = state.filtered[state.selected];
		if (index === undefined) return;
		done({ index, action });
	};

	return {
		...framed(container, theme),
		handleInput(data: string) {
			if (kb.matches(data, "tui.select.up")) move(-1);
			else if (kb.matches(data, "tui.select.down")) move(1);
			else if (kb.matches(data, "tui.select.pageUp")) move(-maxVisible);
			else if (kb.matches(data, "tui.select.pageDown")) move(maxVisible);
			else if (matchesKey(data, "ctrl+enter")) return confirm("insert");
			else if (kb.matches(data, "tui.select.confirm")) return confirm("jump");
			else if (kb.matches(data, "tui.select.cancel")) return done(null);
			else {
				search.handleInput(data);
				state.query = search.getValue();
				refilter();
			}
			tui.requestRender();
		},
	};
}

// ---------------------------------------------------------------------------
// 命令 / 快捷键
// ---------------------------------------------------------------------------

const JUMP_SHORTCUT_DEFAULT = ["alt+h"];
const CONFIG_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const CONFIG_NAMED_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);
const CONFIG_PRINTABLE_KEY = /^[a-z0-9`\-=\[\]\\;',.\/!@#$%^&*()_+|~{}:<>?"]$/;

/** 校验配置里的快捷键; 返回问题说明, 合法则返回 undefined.  */
function validateShortcut(key: string): string | undefined {
	const parts = key.split("+");
	const base = parts.pop() ?? "";
	if (!base) return t().validateMissingKey;
	for (const part of parts) {
		if (!CONFIG_MODIFIERS.has(part)) return t().validateBadModifier(part);
	}
	if (parts.length === 0 && !CONFIG_NAMED_KEYS.has(base)) {
		return t().validatePlainKey;
	}
	if (!CONFIG_NAMED_KEYS.has(base) && !CONFIG_PRINTABLE_KEY.test(base)) return t().validateBadKey(base);
	return undefined;
}

interface TimelineConfig {
	shortcuts: string[];
	jumpTo: JumpTo;
	language: Language;
	/** 读配置时收集到的问题(启动后提示一次) */
	problems: string[];
}

const JUMP_TO_DEFAULT: JumpTo = "user";

function defaultConfig(problems: string[] = [], shortcuts: string[] = JUMP_SHORTCUT_DEFAULT): TimelineConfig {
	return { shortcuts, jumpTo: JUMP_TO_DEFAULT, language: "auto", problems };
}
/** 配置里写得宽松一点: 中英文, 几种常见叫法都认 */
const JUMP_TO_ALIASES: Record<string, JumpTo> = {
	user: "user",
	message: "user",
	prompt: "user",
	question: "user",
	消息: "user",
	提问: "user",
	reply: "reply",
	answer: "reply",
	assistant: "reply",
	below: "reply",
	content: "reply",
	body: "reply",
	正文: "reply",
	回答: "reply",
	下方: "reply",
};

/**
 * 包目录(源码在它的 `src/` 里, 旧位置的 config.json 也放在这一层). 
 * jiti 加载时会注入 `__dirname`, 指向源码目录(`src/`), 所以往上一级; 
 * 万一没有(比如打包进二进制的形态)就按约定路径推. 
 */
function extensionDir(): string {
	try {
		if (typeof __dirname === "string" && __dirname) return join(__dirname, "..");
	} catch {
		/* 环境里没有 __dirname */
	}
	return join(getAgentDir(), "extensions", "timeline");
}

/**
 * 配置文件只有一个位置: `~/.pi/agent/timeline.json`. 
 *
 * 为什么不放包目录里: 包目录升级时会被整体替换, 配置写在里面就有丢的路径; 而且本地开发和实际
 * 使用本来就是同一份配置, 没必要两边兜. 要沙箱就把 `PI_CODING_AGENT_DIR` 指到临时目录. 
 */
function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

/** 早期位置: 扩展目录里的 `config.json`(本地开发 / 旧版本). 只用来读一次, 读到就搬走.  */
function legacyConfigPath(): string {
	return join(extensionDir(), "config.json");
}

/** 面板页脚的路径: 用 `~` 替掉主目录前缀. Windows 下的完整长路径会折成两行, 挤掉列表空间.  */
function shortenHomePath(path: string): string {
	try {
		const home = homedir();
		if (home && path.startsWith(home)) {
			const rest = path.slice(home.length);
			if (rest === "" || rest.startsWith("/") || rest.startsWith("\\")) return `~${rest}`;
		}
	} catch {
		/* 取不到主目录就原样显示 */
	}
	return path;
}

/** 读原始 JSON(保留我们不认识的字段); 文件不存在或坏了就当空对象.  */
function readRawConfig(path: string): Record<string, any> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** 改几项设置并写回配置(只动这几项, 文件里别的字段原样保留). 返回写入的路径.  */
function writeConfigPatch(patch: Record<string, unknown>): string {
	const target = configPath();
	const base = readRawConfig(target);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${JSON.stringify({ ...base, ...patch }, null, 2)}\n`, "utf8");
	return target;
}

/** 首次使用时落一份默认配置: 让用户找得到这个文件, 能手改(和兄弟包一致).  */
function ensureConfigFile(): void {
	if (existsSync(configPath())) return;
	writeConfigPatch({ shortcut: [...JUMP_SHORTCUT_DEFAULT], jumpTo: JUMP_TO_DEFAULT, language: "auto" });
}

/**
 * 读配置: 快捷键 + 落脚点 + 界面语言. 
 *
 * 为什么快捷键不用 keybindings.json: Pi 的扩展快捷键是按字面按键字符串匹配的
 * (内部就是 matchesKey(输入, 注册时那个字符串)), 没有动作 id 可以中转. 
 * 也不用 --flag: 扩展 flag 的值是扩展加载完之后才填进去的, 而注册快捷键发生在加载期. 
 */
function loadConfig(): TimelineConfig {
	const problems: string[] = [];
	let path = configPath();

	// 旧位置(扩展目录里的 config.json)的配置搬过来, 只搬一次; 
	// 那份 JSON 本身是坏的就不搬, 直接在原地按"读配置失败"报错
	if (!existsSync(path)) {
		const legacy = legacyConfigPath();
		if (existsSync(legacy)) {
			try {
				const text = readFileSync(legacy, "utf8");
				JSON.parse(text);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
				try {
					unlinkSync(legacy);
				} catch {
					/* 删不掉就留着, 不影响使用 */
				}
			} catch {
				path = legacy;
			}
		}
	}

	// 还没读到配置之前先按 auto 挑文案(报错信息也要有语言)
	currentLanguage = "auto";
	if (!existsSync(path)) return defaultConfig(problems);

	let raw: any;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return defaultConfig([t().configParseError(error instanceof Error ? error.message : String(error), path)]);
	}

	// 界面语言: "zh" / "en" 写死, 其余一律按 "auto" 跟随系统区域
	const rawLanguage = typeof raw?.language === "string" ? raw.language.trim().toLowerCase() : "";
	const language: Language = rawLanguage === "zh" || rawLanguage === "en" ? rawLanguage : "auto";
	currentLanguage = language;

	// 落脚点: 跳到消息本身还是它下面的正文
	let jumpTo: JumpTo = JUMP_TO_DEFAULT;
	const jumpToValue = raw?.jumpTo ?? raw?.anchor ?? raw?.target;
	if (jumpToValue !== undefined) {
		const alias = typeof jumpToValue === "string" ? JUMP_TO_ALIASES[jumpToValue.trim().toLowerCase()] : undefined;
		if (alias) jumpTo = alias;
		else problems.push(t().configBadJumpTo(JSON.stringify(jumpToValue), path));
	}

	// 快捷键
	const value = raw?.shortcut;
	if (value === undefined) return { ...defaultConfig(problems), jumpTo, language };
	if (value === null || value === false || value === "") return { shortcuts: [], jumpTo, language, problems };

	const entries: unknown[] = Array.isArray(value) ? value : [value];
	if (entries.length === 0) return { shortcuts: [], jumpTo, language, problems }; // [] = 不要快捷键
	if (entries.some((item) => typeof item !== "string")) {
		problems.push(t().configBadShortcutType(path));
		return { ...defaultConfig(problems), jumpTo, language };
	}

	const shortcuts: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries as string[]) {
		const key = entry.trim().toLowerCase();
		if (!key || seen.has(key)) continue;
		const problem = validateShortcut(key);
		if (problem) {
			problems.push(t().configBadShortcut(entry, problem, path));
			continue;
		}
		seen.add(key);
		shortcuts.push(key);
	}

	if (shortcuts.length === 0) {
		problems.push(t().configNoShortcut(JUMP_SHORTCUT_DEFAULT.join(", ")));
		return { shortcuts: JUMP_SHORTCUT_DEFAULT, jumpTo, language, problems };
	}
	return { shortcuts, jumpTo, language, problems };
}

function noticeForMissingView(mode: string): { title: string; body: string[]; hint: string } {
	if (mode === "fullscreen") {
		return {
			title: t().noticeNoViewportTitle,
			body: [t().noticeNoViewportBody],
			hint: t().noticeCloseHint,
		};
	}
	return {
		title: t().noticeFullscreenTitle,
		body: [t().noticeFullscreenBody1, t().noticeFullscreenBody2],
		hint: t().noticeFullscreenHint,
	};
}

/** 拿不到视口时的说明面板(也要有完整的框, 别只是一行字飘在屏幕上).  */
function buildMissingViewPanel(mode: string, theme: Theme, done: (result: null) => void): Component {
	const notice = noticeForMissingView(mode);
	const container = new Container();
	container.addChild(new Text(theme.fg("warning", theme.bold(notice.title)), 1, 0));
	for (const line of notice.body) container.addChild(new Text(theme.fg("text", line), 1, 0));
	container.addChild(new Text(theme.fg("accent", notice.hint), 1, 0));

	return {
		...framed(container, theme),
		handleInput() {
			done(null);
		},
	};
}

/**
 * 设置面板 / 降级对话框. 
 *
 * Pi 的 /settings 是内置的固定列表(字段写死在 SettingsConfig 里, 扩展没有接入点), 所以这里用 pi
 * 自己的 SettingsList 拼一个同样式的面板: 上下 DynamicBorder + 标题(缩进 2) + 列表 + 页脚(配置文件
 * 路径, 同样缩进 2). 面板与"有 UI 但没有自定义组件"的宿主共用一张设置项表(MENU), 改一项就立即
 * 写回配置文件. 
 */
const CUSTOM_SHORTCUT = "__custom__";
const SHORTCUT_OFF = "__off__";
const SHORTCUT_CHOICES = ["alt+t", "alt+h", "ctrl+h"];

interface SettingsResult {
	/** 用户选了「自定义...」, 调用方还要问一次键 */
	customShortcut?: boolean;
	/** 语言真的换了, 调用方要用新语言重开面板 */
	languageChanged?: boolean;
}

/** 设置项表: 面板与降级对话框共用; 行的 id 就是配置字段名. 新增设置只改这里 + i18n.ts */
interface SettingDef {
	id: SettingId;
	/** 有 values = 本行回车直接切换; 没有 = 回车进入候选子菜单(候选只有显示文案, 反查成配置值) */
	values?: (m: Messages) => string[];
	choices?: (m: Messages) => string[];
	/** 当前值(显示文案) */
	current: (config: TimelineConfig, m: Messages) => string;
}

const MENU: SettingDef[] = [
	{
		id: "jumpTo",
		values: (m) => JUMP_TO_VALUES.map((jump) => m.jumpToLabels[jump]),
		current: (config, m) => m.jumpToLabels[config.jumpTo],
	},
	{
		id: "shortcut",
		choices: (m) => [...SHORTCUT_CHOICES, m.customShortcutChoice, m.shortcutOffChoice],
		current: (config, m) => shortcutText(config, m),
	},
	// 语言项放最后: 前两项用得最多, 而且行位置一变, 按 ↓ 次数定位的用例就得跟着改
	{
		id: "language",
		choices: (m) => LANGUAGES.map((lang) => m.languageLabels[lang]),
		current: (config, m) => m.languageLabels[config.language],
	},
];

function shortcutText(config: TimelineConfig, m: Messages): string {
	return config.shortcuts.join(" / ") || m.shortcutOffValue;
}

/** 显示文案 → 配置值: 一律拿当前 Messages 反查, 不写死语言名 */
function labelToJumpTo(value: string, m: Messages): JumpTo {
	return JUMP_TO_VALUES.find((jump) => m.jumpToLabels[jump] === value) ?? JUMP_TO_DEFAULT;
}

function labelToLanguage(value: string, m: Messages): Language {
	return LANGUAGES.find((lang) => m.languageLabels[lang] === value) ?? "auto";
}

/**
 * 显示文案 → 配置值: 面板与降级对话框的回调拿到的都是显示文案, 一律拿同一张 Messages 反查, 
 * 不写死语言名或键名. 
 */
function labelToValue(id: SettingId, label: string, m: Messages): string {
	if (id === "jumpTo") return labelToJumpTo(label, m);
	if (id === "language") return labelToLanguage(label, m);
	if (label === m.shortcutOffChoice) return SHORTCUT_OFF;
	if (label === m.customShortcutChoice) return CUSTOM_SHORTCUT;
	return label; // 预设键: 显示文案就是键本身
}

/** 把配置值写回文件(入参是反查过的配置值, 不是显示文案) */
function applySetting(id: SettingId, value: string): void {
	if (id === "jumpTo") writeConfigPatch({ jumpTo: value });
	else if (id === "language") writeConfigPatch({ language: value });
	else if (id === "shortcut") writeConfigPatch({ shortcut: value === SHORTCUT_OFF ? null : value });
}

/** 原生设置列表主题(与 /settings 一样式). 用传入的 theme 着色: 扩展经 jiti 加载, 全局主题不一定初始化过.  */
function makeListTheme(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => theme.fg("dim", text),
	};
}

/**
 * 二级菜单用的 SelectList 主题, 同样从传入的 theme 派生. 
 * 逐字段照抄 pi 原生的 `getSelectListTheme()`: scrollInfo / noMatch 是 muted(不是 dim). 
 */
function makeSelectTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
	};
}

/**
 * 二级菜单: 从若干显示文案里选一个(反查配置值由 labelToValue 负责). 
 *
 * 顶部空一行: 一级列表那里是"搜索行 + 空行", 子菜单没有搜索行, 不补就会和面板标题贴在一起. 
 * 用 Spacer + 转发输入/鼠标(不要自己拼字符串--那样会把子菜单的鼠标命中行号错开). 
 */
/**
 * 面板的外框状态: 进了子菜单就把标题换成那一项的名字, 出来再换回去. 
 * 标题是渲染时现看的, 所以不能只建一次 Text 就不管了. 
 */
interface PanelChrome {
	/** 子菜单打开: 传那一项的行标签; 关闭: 不传 */
	show(label?: string): void;
}

/**
 * 子菜单的外壳: 顶部空一行(一级列表那里是"搜索行 + 空行"), 底部也空一行(跟页脚隔开). 
 * 用 Spacer + Container 转发输入/鼠标, 不要自己拼字符串--那样会把鼠标命中行号错开. 
 */
function wrapSubmenu(inner: Component): Component {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(inner);
	container.addChild(new Spacer(1));
	return {
		render: (width: number) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => inner.handleInput(data),
		handleMouse: (event: any) => container.handleMouse(event),
	};
}

/** 二级菜单: 从若干显示文案里选一个(反查配置值由 labelToValue 负责). 光标预选在当前值那项上.  */
function chooseFrom(
	labels: string[],
	current: string,
	theme: Theme,
	rowLabel: string,
	chrome: PanelChrome,
	done: (label?: string) => void,
): Component {
	const items = labels.map((label) => ({ value: label, label }));
	const list = new SelectList(items, Math.min(items.length, 10), makeSelectTheme(theme));
	// 光标停在当前值那项上(当前值不在候选里--比如自定义快捷键--就停在第一项)
	const selected = items.findIndex((item) => item.label === current);
	if (selected > 0) list.setSelectedIndex(selected);

	// 进子菜单: 标题换成这一项的名字; 选完 / 取消再换回面板名
	chrome.show(rowLabel);
	const finish = (label?: string) => {
		chrome.show();
		done(label);
	};
	list.onSelect = (item) => finish(item.label);
	list.onCancel = () => finish();

	return wrapSubmenu(list);
}

/** 一级列表的条目: 文案与当前值都从同一张 Messages 里取 */
function buildItems(config: TimelineConfig, m: Messages, theme: Theme, chrome: PanelChrome): SettingItem[] {
	return MENU.map((def): SettingItem => {
		const text = m.settings[def.id];
		const base = {
			id: def.id,
			label: text.label,
			description: text.description,
			currentValue: def.current(config, m),
		};
		if (def.values) return { ...base, values: def.values(m) };
		return {
			...base,
			submenu: (_current, doneChoose) =>
				chooseFrom(def.choices?.(m) ?? [], def.current(config, m), theme, text.label, chrome, doneChoose),
		};
	});
}
/**
 * 搜索框前面的图标统一用 ⌕(与消息列表的搜索框一致). 
 *
 * `SettingsList` 的搜索框是它自己 `new Input()` 出来的, 没有公开的 prompt 选项, 所以这里改它的
 * 内部字段; pi 要是改了这个字段就保持默认提示符, 不影响功能. 
 */
function useSearchGlyph(list: SettingsList): void {
	try {
		const input = (list as unknown as { searchInput?: { prompt?: string } }).searchInput;
		if (input && typeof input.prompt === "string") input.prompt = "⌕ ";
	} catch {
		/* 版本差异: 保持默认提示符 */
	}
}

async function showSettingsPanel(ctx: ExtensionContext | ExtensionCommandContext): Promise<SettingsResult | null> {
	// 原地渲染(和原生 /settings 一样替换掉编辑区), 不传 overlay 选项
	return ctx.ui.custom<SettingsResult | null>((tui, theme, _kb, done) => {
		const config = loadConfig();
		const m = messages(config.language);

		const border = (text: string) => theme.fg("border", text);
		const container = new Container();
		container.addChild(new DynamicBorder(border));
		// 缩进 2: SettingsList 的条目与提示行就是从第 2 列开始渲染的, 这样标题跟正文对齐
		const title = new Text(theme.fg("accent", theme.bold(m.settingsTitle)), 2, 0);
		container.addChild(title);
		// 进了子菜单, 标题换成那一项的名字(出来再换回面板名)
		const chrome: PanelChrome = {
			show: (label) => title.setText(theme.fg("accent", theme.bold(label ?? m.settingsTitle))),
		};

		const list = new SettingsList(
			buildItems(config, m, theme, chrome),
			10,
			makeListTheme(theme),
			(id, label) => {
				const value = labelToValue(id as SettingId, label, m);
				if (value === CUSTOM_SHORTCUT) {
					done({ customShortcut: true });
					return;
				}
				applySetting(id as SettingId, value);
				// 只有语言真的换了才重开面板(选同一个值不该反复开关)
				if (id === "language" && value !== config.language) {
					done({ languageChanged: true });
				}
			},
			() => done({}),
			{ enableSearch: true },
		);
		useSearchGlyph(list);
		container.addChild(list);
		// 页脚给配置文件的路径(用 ~ 缩短), 用户得能找到这个文件
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

/** 没有界面时给出当前设置(命令在无 UI 宿主里被调用) */
function statusText(config: TimelineConfig): string {
	const m = messages(config.language);
	return m.status(m.jumpToLabels[config.jumpTo], shortcutText(config, m), m.languageLabels[config.language]);
}

/** 自定义快捷键: 界面里给不了反馈, 所以这里用 notify 报结果. 返回是否写盘成功.  */
async function askCustomShortcut(ctx: ExtensionContext | ExtensionCommandContext): Promise<boolean> {
	const m = t();
	const answer = await ctx.ui.input(m.customShortcutTitle, m.customShortcutPlaceholder);
	const key = answer?.trim().toLowerCase();
	if (!key) return false;
	const problem = validateShortcut(key);
	if (problem) {
		ctx.ui.notify(m.notifyBadShortcut(key, problem), "warning");
		return false;
	}
	writeConfigPatch({ shortcut: key });
	ctx.ui.notify(m.notifyShortcutChanged(key), "info");
	return true;
}

/** 有 UI 但没有自定义组件的宿主(RPC 等): 按同一张表逐项问, 内容和面板一一对应.  */
async function openSettingsDialog(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
	const m = t();
	let shortcutChanged = false;
	for (const def of MENU) {
		const text = m.settings[def.id];
		// 本行是回车切换的枚举, 还是进子菜单的候选列表
		const values = def.values ? def.values(m) : (def.choices?.(m) ?? []);
		const picked = await ctx.ui.select(m.pickPrompt(m.dialogTitle(text.label), def.current(loadConfig(), m)), values);
		if (picked === undefined) return; // 用户取消: 已经改过的项保留
		const value = labelToValue(def.id, picked, m);
		if (value === CUSTOM_SHORTCUT) {
			if (await askCustomShortcut(ctx)) shortcutChanged = true;
			continue;
		}
		applySetting(def.id, value);
		if (def.id === "shortcut") shortcutChanged = true;
	}
	ctx.ui.notify(shortcutChanged ? m.notifySavedWithShortcut : m.notifySaved, "info");
}

/** 打开设置界面: TUI 开面板; 只有 UI 就逐项问; 都没有就报当前设置.  */
async function openTimelineSettings(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) await openSettingsDialog(ctx);
		else ctx.ui.notify(statusText(loadConfig()), "info");
		return;
	}

	for (;;) {
		const result = await showSettingsPanel(ctx);
		if (!result) return;
		// 语言换了: 用新语言重开面板(循环, 不是递归--递归会把栈越堆越深)
		if (result.languageChanged) continue;
		if (result.customShortcut) await askCustomShortcut(ctx);
		return;
	}
}

async function openTimeline(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(t().notifyTuiOnly, "warning");
		return;
	}

	// 刷新配置(顺便刷新界面语言: 文案可能刚在设置面板里换过)
	loadConfig();
	const { items } = buildPickerData(ctx);
	if (items.length === 0) {
		ctx.ui.notify(t().notifyNoMessages, "info");
		return;
	}

	// jumpTo 每次调用都重读, 所以在设置面板里改完立即生效, 不用 /reload
	const picked = await pickOnce(ctx, items);
	if (!picked) return;

	const { index, action } = picked.result;
	const item = items[index];
	if (!item) return;

	if (action === "insert") {
		ctx.ui.setEditorText(item.text);
		ctx.ui.notify(t().notifyInserted, "info");
		return;
	}

	// 跳转时重新定位一次: 等待选择期间 transcript 可能又长了
	const { rows, contentHeight } = locateRows(items, picked.tui, picked.view, loadConfig().jumpTo);
	const row = rows[index];
	if (row === undefined) {
		ctx.ui.notify(t().notifyNotLocatable, "warning");
		return;
	}

	jumpToRow(picked.view, row, contentHeight);
	debugDump({
		event: "jump",
		selected: { index, text: item.text.slice(0, 60) },
		row,
		viewportTop: (picked.view as { scrollTop?: number }).scrollTop,
		contentHeight: (picked.view as { contentHeight?: number }).contentHeight,
		viewportHeight: (picked.view as { viewportHeight?: number }).viewportHeight,
		...lastLocateDebug,
	});
	(picked.tui as { requestRender?: (force?: boolean) => void }).requestRender?.();
	(picked.tui as { flash?: (message: string, durationMs?: number) => void }).flash?.(`→ #${index + 1} ${item.preview}`);
}

/** 开一次列表界面, 拿到用户的选择(以及用到的 TUI / 视口).  */
async function pickOnce(
	ctx: ExtensionContext | ExtensionCommandContext,
	items: TimelineItem[],
): Promise<{ result: PickerResult; tui: unknown; view: ScrollViewLike } | undefined> {
	// jumpTo 每次调用都重读, 这样在设置面板里改完立即生效, 不用 /reload
	const { jumpTo } = loadConfig();

	let capturedTui: unknown;
	let capturedView: ScrollViewLike | undefined;
	let missingViewMode: string | undefined;
	let currentIndex = -1;

	const result = await ctx.ui.custom<PickerResult | null>(
		(tui, theme, kb, done) => {
			capturedTui = tui;
			capturedView = resolveTranscript(tui);
			if (!capturedView) {
				missingViewMode = (tui as { mode?: string }).mode ?? "";
				return buildMissingViewPanel(missingViewMode, theme, done);
			}

			// 打开时就定位一遍: 既能标出"当前位置", 也能统计有多少条根本定位不到
			const { rows, blockRows } = locateRows(items, tui, capturedView, jumpTo);
			const top = capturedView.scrollTop;
			// "正在看哪一轮"按**整轮**算: 用户消息 + 它后面的工具和回复是一个块, 
			// 视口落在这块里(哪怕在回复中间)就算正在看这条
			for (let index = 0; index < items.length; index++) {
				const row = blockRows[index];
				if (row !== undefined && row <= top) currentIndex = index;
			}

			return buildPicker(items, rows, currentIndex, jumpTo, theme, tui as TUI, kb, done);
		},
		{
			overlay: true,
			// 拿不到视口时只是弹一段说明, 别给它撑成全屏那么大的面板
			overlayOptions: () =>
				missingViewMode === undefined
					? { anchor: "center", width: "76%", minWidth: 52, maxHeight: "70%", margin: 1 }
					: { anchor: "center", width: "72%", minWidth: 46, margin: 1 },
		},
	);

	if (!result) return undefined;
	if (!capturedView) return undefined;
	return { result, tui: capturedTui, view: capturedView };
}

export default function timelineExtension(pi: ExtensionAPI) {
	const { shortcuts, problems } = loadConfig();

	// 参数一律不解析: 命令就是"打开设置界面", 带了参数也不当设置项用(timeline-settings [ignored])
	// 命令描述固定成英文的 "<扩展名> Settings(<配置文件>)", 不参与 i18n(斜杠命令的约定)
	pi.registerCommand("timeline-settings", {
		description: "Timeline Settings(timeline.json)",
		handler: async (_args, ctx) => {
			await openTimelineSettings(ctx);
		},
	});

	for (const shortcut of shortcuts) {
		pi.registerShortcut(shortcut as KeyId, {
			description: t().shortcutDescription,
			handler: async (ctx) => {
				await openTimeline(ctx);
			},
		});
	}

	// 工厂阶段还没有 UI: 首次使用时落一份默认配置(让用户找得到这个文件), 
	// 配置有问题也等会话起来再提示, 免得用户以为快捷键莫名其妙没了
	pi.on("session_start", (_event, ctx) => {
		try {
			ensureConfigFile();
		} catch {
			/* 只读目录等场景静默降级 */
		}
		for (const problem of problems) {
			ctx.ui.notify(`timeline: ${problem}`, "warning");
		}
	});
}
