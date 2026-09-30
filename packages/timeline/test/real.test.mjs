/**
 * 真实对象集成测试: 用 Pi 自己的 UserMessageComponent / AssistantMessageComponent
 * 渲染 transcript, 用真实 ChatViewport + renderLayoutFrame 建布局帧, 
 * 配真实 TuiAltScreen, 验证扩展在真实结构上定位和滚动是否正确. 
 * 跑: node test/real.test.mjs
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	CHAT_VIEWPORT_URL,
	KEY,
	assistantEntry,
	createSuite,
	drivePicker,
	isMain,
	loadTimeline,
	piPackage,
	selectByText,
	tempDir,
	tui as tuiApi,
	userEntry,
	TUI_LAYOUT_URL,
} from "./harness.mjs";

const { Container, Spacer, Text, TuiAltScreen } = tuiApi;
const { renderLayoutFrame } = await import(TUI_LAYOUT_URL);
const { createChatViewport } = await import(CHAT_VIEWPORT_URL);
const { AssistantMessageComponent, UserMessageComponent, getMarkdownTheme, initTheme } = piPackage;

initTheme("dark");
const markdownTheme = getMarkdownTheme();
const MARK = "\x1b]133;A\x07";
const T0 = Date.parse("2026-01-01T10:00:00Z");
const FILLER = "这一行写得长一点, 好让渲染出来占满好几行, 制造出足够长的 transcript, 这样滚动才真的有意义. ";

const SCRIPT = [
	["user", "第一个问题: 把 read 工具改一下"],
	["assistant", `好的, 我先看一下 read 工具的实现. ${FILLER}`],
	["user", "继续"],
	["assistant", `继续之前先确认一下这里的行为. ${FILLER}`],
	["user", "**重要**: 现在把测试跑一遍"],
	["assistant", `测试通过了, 一共 14 个用例. ${FILLER}`],
	...Array.from({ length: 10 }, (_, index) => [
		["user", `补充问题 ${index + 4}: 把第 ${index + 4} 处也顺手改掉`],
		["assistant", `第 ${index + 4} 处已经改完. ${FILLER}`],
	]).flat(),
];

function userComponent(text) {
	return new UserMessageComponent(text, markdownTheme, 1, []);
}
function assistantComponent(text) {
	return new AssistantMessageComponent(
		{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: T0 },
		false,
		markdownTheme,
		"Thinking...",
		1,
		[],
	);
}

/** 只有工具调用的助手消息: 没有任何文字 → 组件一行都不渲染.  */
function toolOnlyAssistantComponent(index) {
	return new AssistantMessageComponent(
		{
			role: "assistant",
			content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: "x" } }],
			stopReason: "toolUse",
			timestamp: T0,
		},
		false,
		markdownTheme,
		"Thinking...",
		1,
		[],
	);
}

/** 开场白: 有文字, 但带工具调用(pi 不给它打 OSC 133 标记, 也不算"正文").  */
function preambleAssistantComponent(text) {
	return new AssistantMessageComponent(
		{
			role: "assistant",
			content: [
				{ type: "text", text },
				{ type: "toolCall", id: "call-preamble", name: "read", arguments: { path: "x" } },
			],
			stopReason: "toolUse",
			timestamp: T0,
		},
		false,
		markdownTheme,
		"Thinking...",
		1,
		[],
	);
}

/** 按"累加每个组件的渲染高度"独立算一遍每条用户消息的行号(测试自己的基准, 不复用扩展的逻辑).  */
function oracleUserRows(chat, width) {
	const rows = [];
	let row = 0;
	for (const component of chat.children) {
		if (component instanceof UserMessageComponent) rows.push(row);
		row += component.render(width).length;
	}
	return rows;
}

/**
 * 校验落点: 目标行不可能被滚到视口顶部时就该被夹到最底部, 这是 ScrollView 的正常行为. 
 * 不论哪种情况, 目标那行必须在视口里, 而且(未被夹时)正好是视口第一行. 
 */
function assertLanding(view, targetRow, index) {
	const maxScrollTop = Math.max(0, view.contentHeight - view.viewportHeight);
	const expectedTop = Math.min(targetRow, maxScrollTop);
	assert.equal(view.scrollTop, expectedTop, `第 ${index + 1} 条落点应为第 ${expectedTop} 行(目标 ${targetRow})`);
	assert.ok(
		targetRow >= view.scrollTop && targetRow < view.scrollTop + view.viewportHeight,
		`第 ${index + 1} 条(第 ${targetRow} 行)没落在视口内(视口 ${view.scrollTop}..${view.scrollTop + view.viewportHeight})`,
	);
}

/**
 * 每条用户消息后面第一条助手正文的行号(跳到"下方正文"时的基准). 
 * 助手块的第一行是组件上边距(空行), 正文在第一个非空行. 
 */
function oracleReplyRows(chat, width, lines) {
	const records = [];
	let row = 0;
	for (const component of chat.children) {
		const kind =
			component instanceof UserMessageComponent ? "user" : component instanceof AssistantMessageComponent ? "assistant" : undefined;
		if (kind) records.push({ kind, row });
		row += component.render(width).length;
	}
	const rows = [];
	records.forEach((record, index) => {
		if (record.kind !== "user") return;
		const reply = records.slice(index + 1).find((next) => next.kind === "assistant") ?? records[index + 1];
		if (!reply) rows.push(record.row);
		else rows.push(reply.row); // 落脚行 = 块的第一行(和 pi 原生 Ctrl+↓ 一致)
	});
	return rows;
}

/** 一个只记录写入的假终端(TuiAltScreen 需要它才能算布局帧).  */
/** 思考 + 正文的回答: 思考块是可见的(和真实会话一样), 正文在思考下面.  */
function thinkingAssistantComponent(text, thinking) {
	return new AssistantMessageComponent(
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking },
				{ type: "text", text },
			],
			stopReason: "stop",
			timestamp: T0,
		},
		false, // 思考可见
		markdownTheme,
		"Thinking...",
		1,
		[],
	);
}

/**
 * 模拟"另一个扩展给思考块套了一层自己的外壳": thinking-display 的折叠标记就是这样. 
 *
 * 两种形状都要测: `transparent: true` 是它现在的做法(转发内层 MouseRegion 的 `child` / `onMouse`, 
 * 外壳自己就能被认成 MouseRegion); 不透则是旧版 / 不转发字段的其它扩展(只有 `region`). 
 */
function decorateThinkingChildren(component, { transparent = false } = {}) {
	const children = component.contentContainer.children;
	for (let index = 0; index < children.length; index += 1) {
		const child = children[index];
		if (!child || typeof child.onMouse !== "function" || !("child" in child)) continue;
		children[index] = {
			region: child,
			...(transparent ? { child: child.child, onMouse: child.onMouse } : {}),
			render: (width) => child.render(width),
			handleMouse: (event) => child.handleMouse?.(event),
			invalidate: () => child.invalidate?.(),
		};
	}
	return component;
}

/**
 * 像 pi 的 `ToolExecutionComponent` 那样的组件: 是个容器(有 children), 但 `render` 自己还画
 * 工具头 / 收尾行--不等于"子组件行拼起来". 遍历认错这种组件就会丢行. 
 */
function toolLikeComponent(text) {
	const output = new Text(`  ${text}`, 2, 0);
	const body = new Container();
	body.addChild(output);
	return {
		children: [output],
		render: (width) => [`  ⚙ read  some/file.ts`, ...body.render(width), `  ── 12ms ──`],
		invalidate: () => body.invalidate(),
	};
}

/**
 * 模拟"另一个扩展把思考块整个换成自己的组件": 里面不再是 MouseRegion, 形状认不出来, 
 * 只有源文本比对还认得出(它持有的是思考的源文本, 不是正文段). 
 */
function unwrapThinkingRegions(component) {
	const children = component.contentContainer.children;
	for (let index = 0; index < children.length; index += 1) {
		const child = children[index];
		if (child && typeof child.onMouse === "function" && "child" in child) children[index] = child.child;
	}
	return component;
}

/** 落脚行 = 回复块的第一行(行首带 OSC 133 标记的那行, pi 原生 Ctrl+↓ 认的也是这行) */
function blockStartRow(lines, bodyRow) {
	for (let row = bodyRow; row >= 0; row -= 1) {
		if (String(lines[row] ?? "").startsWith(MARK)) return row;
	}
	return bodyRow;
}

function makeTerminal(columns, rows) {
	return {
		columns,
		rows,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
	};
}

/** 用真组件 + 真布局帧搭一套 TUI.  */
function buildTui(columns = 100, rows = 30, options = {}) {
	const script = options.script ?? SCRIPT;
	const document = new Container();
	const chat = new Container();
	document.addChild(chat);
	chat.addChild(new Text("Pi v0.87.1 · 头部噪声"));
	script.forEach(([role, text], index) => {
		chat.addChild(new Spacer(1));
		if (role === "user") chat.addChild(userComponent(text));
		else if (text === "" && options.toolOnly) chat.addChild(toolOnlyAssistantComponent(index));
		else chat.addChild(assistantComponent(text));
	});
	const viewport = createChatViewport({
		document,
		pendingMessages: new Text(""),
		status: new Text(""),
		editor: new Text(""),
		footer: new Text(""),
	});
	const terminal = makeTerminal(columns, rows);
	const screen = new TuiAltScreen(terminal);
	screen.setLayoutRoot(viewport.root);
	screen.start();
	screen.renderNow();
	return { tui: screen, viewport, document, chat, terminal };
}

function findBox(box, view) {
	if (!box) return undefined;
	if (box.scrollView === view) return box;
	for (const child of box.children ?? []) {
		const found = findBox(child, view);
		if (found) return found;
	}
	return undefined;
}

function transcriptState(screen, view) {
	const box = findBox(screen.currentLayout.root, view);
	const lines = box.scrollContentLines;
	const markers = lines.map((line, row) => (line.startsWith(MARK) ? row : -1)).filter((row) => row >= 0);
	return { lines, markers, box };
}

function makeEntries(script = SCRIPT, { toolOnlyAssistants = [] } = {}) {
	void toolOnlyAssistants;
	return script.map(([role, text], index) => ({
		type: "message",
		id: `${role}-${index}`,
		parentId: null,
		timestamp: new Date(T0 + index * 60_000).toISOString(),
		message:
			role === "user"
				? { role: "user", content: [{ type: "text", text }], timestamp: T0 + index * 60_000 }
				: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: T0 + index * 60_000 },
	}));
}

/** 带工具调用的助手消息: content 只有 toolCall, 没有任何文字 → 渲染时一行都不产生.  */
function toolOnlyAssistantEntries(script) {
	return script.map(([role, text], index) => ({
		type: "message",
		id: `${role}-${index}`,
		parentId: null,
		timestamp: new Date(T0 + index * 60_000).toISOString(),
		message:
			role === "user"
				? { role: "user", content: [{ type: "text", text }], timestamp: T0 + index * 60_000 }
				: text === ""
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: "x" } }],
							stopReason: "toolUse",
							timestamp: T0 + index * 60_000,
						}
					: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: T0 + index * 60_000 },
	}));
}

export async function run() {
	const suite = createSuite("real · Pi 真实组件与真实 TUI");
	// 用隔离的副本 + 隔离的 agent 目录, 不然会受用户真实配置(快捷键 / jumpTo)影响
	const work = tempDir("real");
	const load = await loadTimeline({ copyTo: join(work.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"user"}' });
	const entries = makeEntries();

	await suite.test("真实渲染: 每条消息首行带 OSC 133 标记, 正文在同一块里", async () => {
		const { viewport } = buildTui();
		const frame = renderLayoutFrame(viewport.root, 100, 30, () => {});
		assert.equal(frame.primaryScrollView, viewport.transcript, "布局帧的 primary scroll view 应当是 transcript");
		const box = findBox(frame.root, viewport.transcript);
		assert.ok(box, "布局帧里能找到 transcript 的盒子");
		const lines = box.scrollContentLines;
		assert.ok(Array.isArray(lines) && lines.length > 0, "scrollContentLines 应当非空");
		const markers = lines.map((line, row) => (line.startsWith(MARK) ? row : -1)).filter((row) => row >= 0);
		assert.equal(markers.length, SCRIPT.length, `标记数应等于消息数, 实际 ${markers.length}`);
		// 标记打在用户消息盒子的上边距那一行, 正文在同一块里
		assert.match(lines.slice(markers[0], markers[1]).join("\n"), /第一个问题/);
		assert.match(lines.slice(markers[4], markers[5]).join("\n"), /重要/);
	});

	await suite.test("真实 TuiAltScreen: getPrimaryScrollView() 拿到 transcript", async () => {
		const { tui: screen, viewport } = buildTui();
		assert.equal(screen.getPrimaryScrollView(), viewport.transcript);
		assert.equal(screen.mode, "fullscreen");
		assert.ok(viewport.transcript.contentHeight > viewport.transcript.viewportHeight, "内容要长过视口, 否则没什么可滚");
	});

	await suite.test("端到端: 过滤选中第 3 条用户消息后滚到它那一行", async () => {
		const { tui: screen, viewport } = buildTui();
		const { lines, markers } = transcriptState(screen, viewport.transcript);

		const { notifications } = await drivePicker({ load, tui: screen, entries, inputs: selectByText("现在把测试跑一遍") });

		assert.deepEqual(notifications, [], "不应有提示");
		assertLanding(viewport.transcript, markers[4], 2);
		assert.match(lines[markers[4]], /133;A/);
		assert.equal(screen.isFollowingOutput, false, "跳转后不应再跟随输出");
		assert.equal(viewport.transcript.scrollTop, screen.viewportTop);
	});

	await suite.test("端到端: 输入关键字过滤后回车, 跳到唯一匹配的那条", async () => {
		const { tui: screen, viewport } = buildTui();
		const { lines, markers } = transcriptState(screen, viewport.transcript);

		const { notifications, rendered } = await drivePicker({
			load,
			tui: screen,
			entries,
			inputs: [..."把 read 工具改一下", KEY.enter],
			renderWidth: 90,
		});
		assert.deepEqual(notifications, []);
		assert.match(rendered, /第一个问题/, "过滤结果里应当只剩第一条");
		assert.doesNotMatch(rendered, /补充问题/, "其它消息应当被过滤掉");
		assert.equal(viewport.transcript.scrollTop, markers[0]);
		assert.match(lines[viewport.transcript.scrollTop], /133;A/);
	});

	await suite.test("端到端: Ctrl+Enter 把原文放进输入框(含渲染时被吃掉的 **)", async () => {
		const { tui: screen } = buildTui();
		const { editorText, notifications } = await drivePicker({
			load,
			tui: screen,
			entries,
			inputs: [..."重要", KEY.ctrlEnter],
		});
		assert.equal(editorText, "**重要**: 现在把测试跑一遍");
		assert.equal(notifications.length, 1);
		assert.match(notifications[0].message, /输入框/);
	});

	await suite.test("端到端: 视口顶部那条被标成\"当前\"", async () => {
		const { tui: screen, viewport } = buildTui();
		const { markers } = transcriptState(screen, viewport.transcript);
		viewport.transcript.scrollTo(markers[2]);

		const { rendered } = await drivePicker({ load, tui: screen, entries, inputs: [KEY.escape] });
		const currentLine = rendered.split("\n").find((line) => line.includes("继续") && line.includes("当前"));
		assert.ok(currentLine, `没找到标着"当前"的那行:\n${rendered}`);
	});

	await suite.test("端到端: 界面每行都封口, 可见宽度等于渲染宽度", async () => {
		const { tui: screen } = buildTui();
		const width = 90;
		let captured = [];
		const ctx = {
			mode: "tui",
			sessionManager: { buildContextEntries: () => entries, getBranch: () => entries },
			ui: {
				notify() {},
				setEditorText() {},
				custom: (factory) =>
					new Promise((resolvePromise) => {
						const component = factory(screen, { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t }, { matches: () => false }, resolvePromise);
						captured = component.render(width);
						resolvePromise(null);
					}),
			},
		};
		await load.run(ctx);
		assert.ok(captured.length > 3, "应当渲染出多行");
		for (const line of captured) {
			assert.equal(tuiApi.visibleWidth(line), width, `行可见宽度应为 ${width}: ${JSON.stringify(line)}`);
		}
		assert.match(captured[0], /^╭─+╮$/);
		assert.match(captured[captured.length - 1], /^╰─+╯$/);
		for (const line of captured.slice(1, -1)) assert.match(line, /^│.*│$/);
	});

	await suite.test("端到端: 每条用户消息都精确落在自己那行的标记上", async () => {
		const { tui: screen, viewport, chat } = buildTui();
		const width = viewport.transcript.getContentWidth(screen.currentLayout.root?.rect?.width ?? 100);
		const oracle = oracleUserRows(chat, width);
		assert.equal(oracle.length, SCRIPT.filter(([role]) => role === "user").length);

		const userTexts = SCRIPT.filter(([role]) => role === "user").map(([, text]) => text);
		for (let index = 0; index < oracle.length; index++) {
			const built = buildTui();
			// 先把视口滚到中间, 验证行号计算不受当前滚动位置影响
			built.viewport.transcript.scrollTo(40);
			built.tui.renderNow();
			const { notifications } = await drivePicker({ load, tui: built.tui, entries, inputs: selectByText(userTexts[index]) });
			assert.deepEqual(notifications, [], `第 ${index + 1} 条不该有提示`);
			assertLanding(built.viewport.transcript, oracle[index], index);
		}
	});

	await suite.test("端到端: 会话里夹着\"只有工具调用\"的助手消息也不错位", async () => {
		// 每轮都是: 用户说完 → 助手只调工具(不产生标记)→ 再回答
		const script = [];
		for (let index = 0; index < 8; index += 1) {
			script.push(["user", `第 ${index + 1} 轮: 改一下第 ${index + 1} 处`]);
			script.push(["assistant", ""]); // 只有工具调用
			script.push(["assistant", `第 ${index + 1} 处改完了. ${FILLER}`]);
		}
		const { tui: screen, viewport, chat } = buildTui(100, 30, { script, toolOnly: true });
		const width = viewport.transcript.getContentWidth(screen.currentLayout.root?.rect?.width ?? 100);
		const oracle = oracleUserRows(chat, width);
		const entries = toolOnlyAssistantEntries(script);

		// 标记数比消息数少(工具调用的助手消息没有标记)-- 靠数标记一定会错位
		const { lines } = transcriptState(screen, viewport.transcript);
		const markerCount = lines.filter((line) => line.startsWith(MARK)).length;
		assert.ok(markerCount < script.length, `预期标记数少于消息数, 实际 ${markerCount} / ${script.length}`);

		for (const index of [0, 3, 7]) {
			const { notifications } = await drivePicker({ load, tui: screen, entries, inputs: selectByText(`第 ${index + 1} 轮`) });
			assert.deepEqual(notifications, [], `第 ${index + 1} 条不该有提示`);
			assertLanding(viewport.transcript, oracle[index], index);
			// 标记行是消息盒子的上边距(空白带底色), 正文在紧接着的几行里
			assert.match(lines.slice(oracle[index], oracle[index] + 3).join("\n"), /轮: 改一下/);
		}
	});

	await suite.test("端到端: jumpTo=reply 时落到每条消息下面的正文", async () => {
		const loadReply = await loadTimeline({ copyTo: join(work.dir, "reply"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const { tui: screen, viewport, chat } = buildTui();
		const width = viewport.transcript.getContentWidth(screen.currentLayout.root?.rect?.width ?? 100);
		const { lines } = transcriptState(screen, viewport.transcript);
		const oracle = oracleReplyRows(chat, width, lines);
		assert.equal(oracle.length, SCRIPT.filter(([role]) => role === "user").length);

		const userTexts = SCRIPT.filter(([role]) => role === "user").map(([, text]) => text);
		for (const index of [0, 1, 5]) {
			const built = buildTui();
			const { notifications } = await drivePicker({
				load: loadReply,
				tui: built.tui,
				entries,
				inputs: selectByText(userTexts[index]),
			});
			assert.deepEqual(notifications, [], `第 ${index + 1} 条不该有提示`);
			assertLanding(built.viewport.transcript, oracle[index], index);
		}
	});

	await suite.test("端到端: reply 落在 pi 的 ctrl+↓ 目标块上(跳过带工具调用的开场白)", async () => {
		// 一轮: 用户 → 开场白(带工具调用, pi 不打标记)→ 几十个只有工具调用的块 → 正文(不打工具调用)
		const chat = new Container();
		chat.addChild(new Text("Pi · 头部"));
		chat.addChild(new Spacer(1));
		chat.addChild(userComponent("问题"));
		chat.addChild(new Spacer(1));
		chat.addChild(preambleAssistantComponent("我先看看实现: "));
		for (let index = 0; index < 5; index += 1) {
			chat.addChild(new Spacer(1));
			chat.addChild(toolOnlyAssistantComponent(index));
		}
		chat.addChild(new Spacer(1));
		chat.addChild(assistantComponent("这才是回答. "));
		chat.addChild(new Spacer(1));
		chat.addChild(userComponent("下一个问题"));
		// 后面再堆几轮, 让文档长过视口(内容不够高时 scrollTo 会被夹到最底部)
		for (let index = 0; index < 6; index += 1) {
			chat.addChild(new Spacer(1));
			chat.addChild(userComponent(`后续问题 ${index + 1}`));
			chat.addChild(new Spacer(1));
			chat.addChild(assistantComponent(`后续回答 ${index + 1}. ${FILLER}`));
		}

		const document = new Container();
		document.addChild(chat);
		const viewport = createChatViewport({ document, pendingMessages: new Text(""), status: new Text(""), editor: new Text(""), footer: new Text("") });
		const screen = new TuiAltScreen(makeTerminal(100, 30));
		screen.setLayoutRoot(viewport.root);
		screen.start();
		screen.renderNow();
		const { lines, markers } = transcriptState(screen, viewport.transcript);

		// pi 的 ctrl+↓: 从用户消息的标记行往下, 下一个带 OSC 133 标记的行就是正文
		const userRow = markers[0];
		assert.match(lines[userRow + 1] ?? "", /问题/, "第一个标记块应当是用户消息");
		const piTarget = markers[1];
		assert.match(lines[piTarget + 1] ?? "", /这才是回答/, "pi 标记的这一块应当就是正文(中间的开场白没有标记)");
		const preambleRow = lines.findIndex((line) => line.includes("我先看看"));
		assert.ok(preambleRow > userRow && preambleRow < piTarget, "开场白应当在用户消息和正文之间");
		assert.equal(lines[preambleRow].startsWith(MARK), false, "带工具调用的开场白不该有标记(所以 ctrl+↓ 会跳过它)");

		const work2 = tempDir("real-reply");
		const loadReply = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const replyEntries = [
			userEntry("u1", "问题", 0),
			assistantEntry("a1", "我先看看实现: ", 1),
			assistantEntry("a2", "这才是回答. ", 2),
			userEntry("u2", "下一个问题", 3),
		];
		viewport.transcript.scrollTo(0, { disableFollow: true }); // 从头开始选: 光标预选会跟着视口位置走
		const { notifications } = await drivePicker({ load: loadReply, tui: screen, entries: replyEntries, inputs: [KEY.enter] });
		assert.deepEqual(notifications, []);
		// 落点和 pi 原生 Ctrl+↓ 完全一致: 就是它认的那行(块首, 行首带 OSC 133 标记)
		assert.equal(viewport.transcript.scrollTop, piTarget, `应当和 pi 原生落在同一行, 实际第 ${viewport.transcript.scrollTop} 行`);
		assert.match(lines[viewport.transcript.scrollTop + 1], /这才是回答/);
		work2.cleanup();
	});

	await suite.test("端到端: 真实组件上没有消息 id, 重复文本也各跳各的", async () => {
		// pi 的组件只拿到文本, 拿不到消息 id, 所以同文本的消息只能靠顺序对齐; 
		// 这里用三条一模一样的用户消息 + 真组件验证不会串位
		const script = [
			["user", "继续"],
			["assistant", "第 1 个回答. "],
			["user", "继续"],
			["assistant", "第 2 个回答. "],
			["user", "继续"],
			["assistant", "第 3 个回答. "],
			// 后面再堆几轮, 让文档长过视口(内容不够高时 scrollTo 会被夹到最底部)
			...Array.from({ length: 6 }, (_, index) => [["user", `后续问题 ${index + 1}`], ["assistant", `后续回答 ${index + 1}. ${FILLER}`]]).flat(),
		];
		const { tui: screen, viewport } = buildTui(100, 30, { script });
		const { lines, markers } = transcriptState(screen, viewport.transcript);
		const duplicateEntries = makeEntries(script);
		// 每条用户消息都是一个带标记的块; 三条重复消息是第 0/2/4 个标记块
		const expectedRows = [markers[0], markers[2], markers[4]];
		const heads = expectedRows.map((row) => lines[row + 1]);
		for (const head of heads) assert.match(head, /继续/);
		assert.equal(new Set(heads).size, 1, `三个块的正文确实一模一样(这才是难点): ${JSON.stringify(heads)}`);
		for (const [index, expectedRow] of expectedRows.entries()) {
			viewport.transcript.scrollTo(0, { disableFollow: true }); // 从头开始选: 光标预选会跟着视口位置走
			const inputs = [...Array.from({ length: index }, () => KEY.down), KEY.enter];
			const { notifications } = await drivePicker({ load, tui: screen, entries: duplicateEntries, inputs });
			assert.deepEqual(notifications, [], `第 ${index + 1} 条不该有提示`);
			assert.equal(viewport.transcript.scrollTop, expectedRow, `第 ${index + 1} 条应当落在第 ${expectedRow} 行, 实际 ${viewport.transcript.scrollTop}`);
		}
	});

	await suite.test("端到端: 带思考的回复跳过思考, 保留正文前一行空白", async () => {
		// 真实会话里助手先想一大段再说答案; 跳到"正文"要落在文字上, 不能落在思考上
		const chat = new Container();
		chat.addChild(new Text("Pi · 头部"));
		chat.addChild(new Spacer(1));
		chat.addChild(userComponent("问题"));
		chat.addChild(new Spacer(1));
		chat.addChild(thinkingAssistantComponent("这才是回答正文. ", `第一段思考, 里面不出现"最终答案"这几个字. \n\n第二段思考, 继续推导. ${FILLER}\n\n第三段思考, 收尾. `));
		for (let index = 0; index < 6; index += 1) {
			chat.addChild(new Spacer(1));
			chat.addChild(userComponent(`后续问题 ${index + 1}`));
			chat.addChild(new Spacer(1));
			chat.addChild(assistantComponent(`后续回答 ${index + 1}. ${FILLER}`));
		}
		const document = new Container();
		document.addChild(chat);
		const viewport = createChatViewport({ document, pendingMessages: new Text(""), status: new Text(""), editor: new Text(""), footer: new Text("") });
		const screen = new TuiAltScreen(makeTerminal(100, 30));
		screen.setLayoutRoot(viewport.root);
		screen.start();
		screen.renderNow();
		const { lines } = transcriptState(screen, viewport.transcript);

		const textRow = lines.findIndex((line) => line.includes("这才是回答正文"));
		const thinkingRow = lines.findIndex((line) => line.includes("第一段思考"));
		assert.ok(thinkingRow >= 0, "思考块应当可见(这是本用例的前提)");
		assert.ok(textRow > thinkingRow + 1, `正文应当在思考之后好几行(思考 ${thinkingRow}, 正文 ${textRow})`);

		const work2 = tempDir("real-thinking");
		const loadReply = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const replyEntries = [
			userEntry("u1", "问题", 0),
			assistantEntry("a1", "这才是回答正文. ", 1),
			...Array.from({ length: 6 }, (_, index) => [
				userEntry(`u${index + 2}`, `后续问题 ${index + 1}`, index + 2),
				assistantEntry(`a${index + 2}`, `后续回答 ${index + 1}. `, index + 3),
			]).flat(),
		];
		viewport.transcript.scrollTo(0, { disableFollow: true }); // 从头开始选: 光标预选会跟着视口位置走
		const { notifications } = await drivePicker({ load: loadReply, tui: screen, entries: replyEntries, inputs: [KEY.enter] });
		assert.deepEqual(notifications, []);
		assert.equal(viewport.transcript.scrollTop, textRow - 1, `带思考的回复应保留正文前一行空白, 实际第 ${viewport.transcript.scrollTop} 行`);
		assert.equal(stripVTControlCharacters(lines[viewport.transcript.scrollTop]).trim(), "");
		assert.match(lines[viewport.transcript.scrollTop + 1], /这才是回答正文/);
		work2.cleanup();
	});

	await suite.test("端到端: 思考块被别的扩展包了一层时, reply 仍落在正文上", async () => {
		// 踩过的 bug: 开了 thinking-display 的折叠标记后, 思考块外层不再是 MouseRegion, 
		// 认正文时会把那一层外壳认错(落点跑进思考里). 
		for (const [transparent, hideThinking] of [[false, false], [false, true], [true, false], [true, true]]) {
			const chat = new Container();
			chat.addChild(new Text("Pi · 头部"));
			chat.addChild(new Spacer(1));
			chat.addChild(userComponent("问题"));
			chat.addChild(new Spacer(1));
			const reply = decorateThinkingChildren(thinkingAssistantComponent("这才是回答正文. ", `第一段思考, 里面不出现"最终答案"这几个字. \n\n第二段思考. ${FILLER}\n\n第三段思考, 收尾. `), { transparent });
			// 被包的思考块要能真的展开 / 折叠: 换成折叠态重建一次子组件
			if (hideThinking) {
				reply.setHideThinkingBlock(true);
				reply.updateContent(reply.lastMessage);
				decorateThinkingChildren(reply, { transparent });
			}
			chat.addChild(reply);
			for (let index = 0; index < 6; index += 1) {
				chat.addChild(new Spacer(1));
				chat.addChild(userComponent(`后续问题 ${index + 1}`));
				chat.addChild(new Spacer(1));
				chat.addChild(assistantComponent(`后续回答 ${index + 1}. ${FILLER}`));
			}
			const document = new Container();
			document.addChild(chat);
			const viewport = createChatViewport({ document, pendingMessages: new Text(""), status: new Text(""), editor: new Text(""), footer: new Text("") });
			const screen = new TuiAltScreen(makeTerminal(100, 30));
			screen.setLayoutRoot(viewport.root);
			screen.start();
			screen.renderNow();
			const { lines } = transcriptState(screen, viewport.transcript);

			const label = `${transparent ? "透明外壳" : "不透明外壳"}/${hideThinking ? "折叠" : "展开"}`;
			const textRow = lines.findIndex((line) => line.includes("这才是回答正文"));
			assert.ok(textRow >= 0, `${label}: 正文应当在渲染结果里`);

			const work3 = tempDir(`real-thinking-decorated-${transparent ? "t" : "o"}-${hideThinking ? "h" : "s"}`);
			const loadReply = await loadTimeline({ copyTo: join(work3.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
			const replyEntries = [
				userEntry("u1", "问题", 0),
				assistantEntry("a1", "这才是回答正文. ", 1),
				...Array.from({ length: 6 }, (_, index) => [
					userEntry(`u${index + 2}`, `后续问题 ${index + 1}`, index + 2),
					assistantEntry(`a${index + 2}`, `后续回答 ${index + 1}. `, index + 3),
				]).flat(),
			];
			viewport.transcript.scrollTo(0, { disableFollow: true });
			const { notifications } = await drivePicker({ load: loadReply, tui: screen, entries: replyEntries, inputs: [KEY.enter] });
			assert.deepEqual(notifications, [], `${label}: 不该有提示`);
			assert.equal(
				viewport.transcript.scrollTop,
				textRow - 1,
				`${label}: reply 应保留正文前一行空白, 实际第 ${viewport.transcript.scrollTop} 行`,
			);
			assert.equal(stripVTControlCharacters(lines[viewport.transcript.scrollTop]).trim(), "", label);
			work3.cleanup();
		}
	});

	await suite.test("端到端: 思考块被整个换成自定义组件时, reply 仍落在正文上", async () => {
		// 另一种形状: 有的扩展会把思考块整个换成自己的组件(里面不再是 MouseRegion). 认正文靠源文本比对, 不受影响. 
		for (const hideThinking of [false, true]) {
			const chat = new Container();
			chat.addChild(new Text("Pi · 头部"));
			chat.addChild(new Spacer(1));
			chat.addChild(userComponent("问题"));
			chat.addChild(new Spacer(1));
			const reply = unwrapThinkingRegions(thinkingAssistantComponent("这才是回答正文. ", `第一段思考, 里面不出现"最终答案"这几个字. \n\n第二段思考. ${FILLER}\n\n第三段思考, 收尾. `));
			if (hideThinking) {
				reply.setHideThinkingBlock(true);
				reply.updateContent(reply.lastMessage);
				unwrapThinkingRegions(reply);
			}
			chat.addChild(reply);
			for (let index = 0; index < 6; index += 1) {
				chat.addChild(new Spacer(1));
				chat.addChild(userComponent(`后续问题 ${index + 1}`));
				chat.addChild(new Spacer(1));
				chat.addChild(assistantComponent(`后续回答 ${index + 1}. ${FILLER}`));
			}
			const document = new Container();
			document.addChild(chat);
			const viewport = createChatViewport({ document, pendingMessages: new Text(""), status: new Text(""), editor: new Text(""), footer: new Text("") });
			const screen = new TuiAltScreen(makeTerminal(100, 30));
			screen.setLayoutRoot(viewport.root);
			screen.start();
			screen.renderNow();
			const { lines } = transcriptState(screen, viewport.transcript);
			const label = hideThinking ? "折叠" : "展开";
			const textRow = lines.findIndex((line) => line.includes("这才是回答正文"));
			const thinkingRow = lines.findIndex((line) => line.includes("第一段思考"));
			assert.ok(textRow > thinkingRow, `${label}: 正文在思考之后(思考 ${thinkingRow}, 正文 ${textRow})`);

			const work4 = tempDir(`real-thinking-unwrapped-${label}`);
			const loadReply = await loadTimeline({ copyTo: join(work4.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
			const replyEntries = [
				userEntry("u1", "问题", 0),
				assistantEntry("a1", "这才是回答正文. ", 1),
				...Array.from({ length: 6 }, (_, index) => [
					userEntry(`u${index + 2}`, `后续问题 ${index + 1}`, index + 2),
					assistantEntry(`a${index + 2}`, `后续回答 ${index + 1}. `, index + 3),
				]).flat(),
			];
			viewport.transcript.scrollTo(0, { disableFollow: true });
			const { notifications } = await drivePicker({ load: loadReply, tui: screen, entries: replyEntries, inputs: [KEY.enter] });
			assert.deepEqual(notifications, [], `${label}: 不该有提示`);
			assert.equal(
				viewport.transcript.scrollTop,
				textRow - 1,
				`${label}: reply 应保留正文前一行空白, 实际第 ${viewport.transcript.scrollTop} 行`,
			);
			assert.equal(stripVTControlCharacters(lines[viewport.transcript.scrollTop]).trim(), "", label);
			work4.cleanup();
		}
	});

	await suite.test("端到端: 布局帧比内容旧一拍时, 落点仍按当前内容精确定位", async () => {
		// 流式输出 / 别的扩展改渲染时, ScrollView 的 contentHeight 会停在上一拍; 
		// 以前不补新就滚, 目标行会被夹到旧的 maxScrollTop 上--落点看着就"有概率错". 
		const chat = new Container();
		chat.addChild(new Text("Pi · 头部"));
		chat.addChild(new Spacer(1));
		chat.addChild(userComponent("问题"));
		chat.addChild(new Spacer(1));
		// 思考很长, 正文行号落在旧内容的滚动上限之外(旧边界夹不住新目标)
		chat.addChild(thinkingAssistantComponent("这才是回答正文. ", `第一段思考, 里面不出现"最终答案"这几个字. ${FILLER.repeat(4)}`));
		const document = new Container();
		document.addChild(chat);
		const viewport = createChatViewport({ document, pendingMessages: new Text(""), status: new Text(""), editor: new Text(""), footer: new Text("") });
		const screen = new TuiAltScreen(makeTerminal(100, 30));
		screen.setLayoutRoot(viewport.root);
		screen.start();
		screen.renderNow();
		const staleHeight = document.render(viewport.transcript.getContentWidth(100)).length;

		// 渲染之后内容又长了一大截, 而且不给重绘--布局状态停在上一拍
		const realRenderNow = screen.renderNow.bind(screen);
		screen.renderNow = () => {};
		for (let index = 0; index < 6; index += 1) {
			chat.addChild(new Spacer(1));
			chat.addChild(userComponent(`后续问题 ${index + 1}`));
			chat.addChild(new Spacer(1));
			chat.addChild(assistantComponent(`后续回答 ${index + 1}. ${FILLER}`));
		}
		const width = viewport.transcript.getContentWidth(100);
		const freshLines = document.render(width);
		const textRow = freshLines.findIndex((line) => line.includes("这才是回答正文"));
		assert.ok(textRow >= 0, "正文应当在渲染结果里");
		const viewportHeight = viewport.transcript.viewportHeight ?? 27;
		assert.ok(
			textRow > Math.max(0, staleHeight - viewportHeight),
			`正文行(${textRow})要真的超出旧的滚动上限(${staleHeight - viewportHeight}), 这个用例才有意义`,
		);

		const work5 = tempDir("real-stale-frame");
		const loadReply = await loadTimeline({ copyTo: join(work5.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const entries = [
			userEntry("u1", "问题", 0),
			assistantEntry("a1", "这才是回答正文. ", 1),
			...Array.from({ length: 6 }, (_, index) => [
				userEntry(`u${index + 2}`, `后续问题 ${index + 1}`, index + 2),
				assistantEntry(`a${index + 2}`, `后续回答 ${index + 1}. `, index + 3),
			]).flat(),
		];
		viewport.transcript.scrollTo(0, { disableFollow: true });
		const { notifications } = await drivePicker({ load: loadReply, tui: screen, entries, inputs: [KEY.enter] });
		screen.renderNow = realRenderNow;
		assert.deepEqual(notifications, []);
		assert.equal(
			viewport.transcript.scrollTop,
			textRow - 1,
			`布局状态旧一拍时 reply 仍应保留正文前一行空白, 实际第 ${viewport.transcript.scrollTop} 行`,
		);
		work5.cleanup();
	});

	await suite.test("端到端: 转录里有自绘行的工具组件时, 落点仍然精确", async () => {
		// 真实会话里有一串工具执行行; 以前遍历把它们的自绘行丢了, 累加高度和真实渲染对不上, 
		// 整个精确路径作废(退回模糊匹配--甚至会跳到用户消息). 
		const chat = new Container();
		chat.addChild(new Text("Pi · 头部"));
		for (let index = 0; index < 3; index += 1) {
			chat.addChild(new Spacer(1));
			chat.addChild(userComponent(`第 ${index + 1} 个问题`));
			chat.addChild(new Spacer(1));
			chat.addChild(toolLikeComponent(`工具输出 ${index + 1}`));
			chat.addChild(new Spacer(1));
			chat.addChild(assistantComponent(`第 ${index + 1} 个回答. ${FILLER}`));
		}
		// 尾巴要足够长: 目标行滚不到视口顶部时会被 ScrollView 夹住(见下一条用例)
		for (let index = 0; index < 10; index += 1) {
			chat.addChild(new Spacer(1));
			chat.addChild(userComponent(`后续问题 ${index + 1}`));
			chat.addChild(new Spacer(1));
			chat.addChild(toolLikeComponent(`后续工具输出 ${index + 1}`));
			chat.addChild(new Spacer(1));
			chat.addChild(assistantComponent(`后续回答 ${index + 1}. ${FILLER}`));
		}
		const document = new Container();
		document.addChild(chat);
		const viewport = createChatViewport({ document, pendingMessages: new Text(""), status: new Text(""), editor: new Text(""), footer: new Text("") });
		const screen = new TuiAltScreen(makeTerminal(100, 30));
		screen.setLayoutRoot(viewport.root);
		screen.start();
		screen.renderNow();
		const { lines } = transcriptState(screen, viewport.transcript);

		const work6 = tempDir("real-tool-like");
		const loadReply = await loadTimeline({ copyTo: join(work6.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const replyEntries = Array.from({ length: 7 }, (_, index) => [
			userEntry(`u${index}`, index < 3 ? `第 ${index + 1} 个问题` : `后续问题 ${index - 2}`, index * 2),
			assistantEntry(`a${index}`, index < 3 ? `第 ${index + 1} 个回答. ` : `后续回答 ${index - 2}. `, index * 2 + 1),
		]).flat();

		for (let index = 0; index < 7; index += 1) {
			const textRow = lines.findIndex((line) => line.includes(index < 3 ? `第 ${index + 1} 个回答` : `后续回答 ${index - 2}`));
			assert.ok(textRow >= 0, `第 ${index + 1} 条的正文应当在渲染结果里`);
			viewport.transcript.scrollTo(0, { disableFollow: true });
			const { notifications } = await drivePicker({
				load: loadReply,
				tui: screen,
				entries: replyEntries,
				inputs: [...Array.from({ length: index }, () => KEY.down), KEY.enter],
			});
			assert.deepEqual(notifications, [], `第 ${index + 1} 条不该有提示`);
			const targetRow = blockStartRow(lines, textRow);
			assert.equal(
				viewport.transcript.scrollTop,
				targetRow,
				`第 ${index + 1} 条的 reply 应落在回复块第一行(第 ${targetRow} 行), 实际第 ${viewport.transcript.scrollTop} 行`,
			);
		}
		work6.cleanup();
	});

	await suite.test("端到端: 目标在会话末尾滚不到顶时, 夹到边界但正文必须在视口里", async () => {
		// ScrollView 的原生行为: scrollTop 最大只能到 内容行数 - 视口高度. 目标比这更靠后时, 
		// 视口顶部是它上面的内容(可能正好是一条用户消息 / 思考的末尾), 正文在视口里但不在顶上. 
		// 这不是定位错--用这条把"夹紧"和"定位错"分开. 
		const chat = new Container();
		chat.addChild(new Text("Pi · 头部"));
		for (let index = 0; index < 6; index += 1) {
			chat.addChild(new Spacer(1));
			chat.addChild(userComponent(`问题 ${index + 1}`));
			chat.addChild(new Spacer(1));
			chat.addChild(assistantComponent(`回答 ${index + 1}. ${FILLER}`));
		}
		chat.addChild(new Spacer(1));
		chat.addChild(userComponent("最后一个问题"));
		chat.addChild(new Spacer(1));
		// 最后一条就是回复, 后面再没内容--正文必然滚不到视口最上面
		chat.addChild(thinkingAssistantComponent("这才是回答正文. ", `思考一大段. ${FILLER.repeat(3)}`));
		const document = new Container();
		document.addChild(chat);
		const viewport = createChatViewport({ document, pendingMessages: new Text(""), status: new Text(""), editor: new Text(""), footer: new Text("") });
		const screen = new TuiAltScreen(makeTerminal(100, 30));
		screen.setLayoutRoot(viewport.root);
		screen.start();
		screen.renderNow();
		const { lines } = transcriptState(screen, viewport.transcript);
		const textRow = lines.findIndex((line) => line.includes("这才是回答正文"));
		const maxScrollTop = Math.max(0, viewport.transcript.contentHeight - viewport.transcript.viewportHeight);
		assert.ok(textRow > maxScrollTop, `用例前提: 目标行(${textRow})要真的滚不到顶(${maxScrollTop})`);

		const work7 = tempDir("real-clamp");
		const loadReply = await loadTimeline({ copyTo: join(work7.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const replyEntries = [
			...Array.from({ length: 6 }, (_, index) => [
				userEntry(`u${index}`, `问题 ${index + 1}`, index * 2),
				assistantEntry(`a${index}`, `回答 ${index + 1}. `, index * 2 + 1),
			]).flat(),
			userEntry("u6", "最后一个问题", 12),
			assistantEntry("a6", "这才是回答正文. ", 13),
		];
		viewport.transcript.scrollTo(0, { disableFollow: true });
		const { notifications } = await drivePicker({
			load: loadReply,
			tui: screen,
			entries: replyEntries,
			inputs: [...Array.from({ length: 6 }, () => KEY.down), KEY.enter],
		});
		assert.deepEqual(notifications, []);
		assert.equal(viewport.transcript.scrollTop, maxScrollTop, `末尾目标应当夹到边界(${maxScrollTop}), 实际 ${viewport.transcript.scrollTop}`);
		assert.ok(
			textRow >= viewport.transcript.scrollTop && textRow < viewport.transcript.scrollTop + viewport.transcript.viewportHeight,
			`正文(第 ${textRow} 行)要落在视口里(视口 ${viewport.transcript.scrollTop}..${viewport.transcript.scrollTop + viewport.transcript.viewportHeight})`,
		);
		work7.cleanup();
	});

	// 用完再清理: 中途删了目录, 后面还在用的扩展会读不到自己的那份配置
	work.cleanup();
	return suite.finish();
}

if (isMain(import.meta.url)) {
	process.exit((await run()) === 0 ? 0 : 1);
}
