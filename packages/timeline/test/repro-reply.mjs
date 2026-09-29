/**
 * 复现: 这个会话里 reply 跳转到底落在哪. 
 * 顺带验证 pi 的各种组件会不会被 timeline 误分类(ToolExecutionComponent 等). 
 * 跑: node test/repro-reply.mjs <会话文件>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_VIEWPORT_URL, KEY, PI_PACKAGE, drivePicker, loadTimeline, piPackage, tempDir, tui as tuiApi } from "./harness.mjs";

const { Container, Spacer, Text, TuiAltScreen } = tuiApi;
const {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	initTheme,
	parseSkillBlock,
	sessionEntryToContextMessages,
} = piPackage;
const { createChatViewport } = await import(CHAT_VIEWPORT_URL);
initTheme("dark");
const markdownTheme = getMarkdownTheme();

const file = process.argv[2];
if (!file) throw new Error("用法: node test/repro-reply.mjs <会话文件>");

// ---- 1. 真实组件的分类探针: 看看谁会被误认成 user / assistant / bash ----
const probeComponent = (name, component) => {
	const kinds = [];
	if (typeof component.text === "string" && typeof component.rebuild === "function" && typeof component.outputPad === "number") kinds.push("user");
	if (typeof component.updateContent === "function" && "lastMessage" in component) kinds.push("assistant");
	if (typeof component.command === "string" && Array.isArray(component.outputLines) && typeof component.appendOutput === "function") kinds.push("bash");
	console.log(`分类探针 ${name}: ${kinds.length ? kinds.join(",") : "(不分类, 只算高度)"}`);
};
probeComponent("ToolExecutionComponent", new ToolExecutionComponent("bash", "call-1", { command: "ls" }, {}, undefined, undefined, process.cwd()));

// ---- 2. 按 pi 的 addMessageToChat / renderSessionItems 搭 transcript ----
const entries = readFileSync(file, "utf8")
	.split("\n")
	.filter((line) => line.trim())
	.map((line) => {
		try {
			return JSON.parse(line);
		} catch {
			return null;
		}
	})
	.filter((entry) => entry && entry.type === "message" && entry.message);

const chat = new Container();
chat.addChild(new Text("Pi · 会话回放"));
const itemComponents = [];
// toolCallId → 工具输出文本
const toolResults = new Map();
for (const entry of entries) {
	const resultMessage = (sessionEntryToContextMessages(entry) ?? [entry.message])[0] ?? entry.message;
	if (resultMessage.role === "toolResult" && typeof resultMessage.toolCallId === "string") {
		const resultText = typeof resultMessage.content === "string" ? resultMessage.content : (resultMessage.content ?? []).filter((p) => p?.type === "text").map((p) => p.text).join("");
		toolResults.set(resultMessage.toolCallId, resultText);
	}
}
for (const entry of entries) {
	const messages = sessionEntryToContextMessages(entry);
	const message = messages[0] ?? entry.message;
	const role = message.role;
	if (role === "system") continue;
	if (role === "toolResult") continue; // 挂在工具调用下面, 不单独成块
	if (role === "user") {
		const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter((p) => p?.type === "text").map((p) => p.text).join("");
		if (!text) continue;
		// 技能块: pi 只渲染 skill 里的用户气泡(没有气泡就整条不渲染), 列表里也是它
		let body = text;
		const skill = parseSkillBlock(text);
		if (skill) {
			if (!skill.userMessage) continue;
			body = skill.userMessage;
		}
		const component = new UserMessageComponent(body, markdownTheme, 1, []);
		chat.addChild(new Spacer(1));
		chat.addChild(component);
		itemComponents.push({ entry, component, text: body });
		continue;
	}
	if (role === "bashExecution") {
		const component = {
			command: message.command ?? "",
			outputLines: [],
			appendOutput() {},
			render: (width) => [`$ ${message.command}`.slice(0, width), ""],
			children: [],
		};
		chat.addChild(new Spacer(1));
		chat.addChild(component);
		itemComponents.push({ entry, component, text: `!${message.command}` });
		continue;
	}
	if (role === "assistant") {
		const component = new AssistantMessageComponent(message, false, markdownTheme, "Thinking...", 1, []);
		chat.addChild(new Spacer(1));
		chat.addChild(component);
		// pi 会给每个 toolCall 挂一个 ToolExecutionComponent(兄弟节点)
		for (const content of message.content ?? []) {
			if (content.type === "toolCall") {
				const tool = new ToolExecutionComponent(content.name, content.id, content.arguments, {}, undefined, undefined, process.cwd());
				// 把真实的工具结果喂进去(真实输出里满是代码/路径碎片, 排障必须带着)
				const result = toolResults.get(content.id);
				if (result) tool.updateResult({ content: [{ type: "text", text: result }], isError: false });
				chat.addChild(tool);
			}
		}
	}
}

const document = new Container();
document.addChild(chat);
const viewport = createChatViewport({ document, pendingMessages: new Text(""), status: new Text(""), editor: new Text(""), footer: new Text("") });
const terminal = {
	columns: 100,
	rows: 30,
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
const screen = new TuiAltScreen(terminal);
screen.setLayoutRoot(viewport.root);
screen.start();
screen.renderNow();
const lines = viewport.transcript.render(100);

// ---- 3. 参照答案(独立算法): 按 pi 的 ctrl+↓ 语义找"正文块" ----
// 正文块 = 不带工具调用的助手消息(pi 只给这种块打 OSC 133 标记)
const width = viewport.transcript.getContentWidth(100);
let position = 0;
const componentRows = new Map();
for (const child of chat.children) {
	componentRows.set(child, position);
	position += child.render(width).length;
}
// 每条用户消息 → 它后面第一个"正文块"(不带工具调用的助手消息)
const childList = chat.children.filter((child) => itemComponents.some((item) => item.component === child) || (typeof child.updateContent === "function" && "lastMessage" in child));
const norm = (text) =>
	String(text ?? "")
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
		.replace(/\s+/g, "")
		.replace(/[*_`#>~|[\]()]/g, "");
const expectedReply = new Map();
const textStartAt = (candidate, row) => {
	const answerText = Array.isArray(candidate.lastMessage?.content)
		? candidate.lastMessage.content.filter((part) => part?.type === "text").map((part) => part.text).join("")
		: "";
	const key = norm(answerText);
	if (!key) return true; // 只有思考的块: 落在块里就算对
	const lineKey = norm(lines[row] ?? "");
	const probe = lineKey.slice(0, 6);
	const at = key.indexOf(probe);
	return probe.length >= 2 && at >= 0 && at <= 2;
};
for (const item of itemComponents) {
	const start = childList.indexOf(item.component);
	// 和扩展一致: 优先"带文字"的正文块, 没有才用只有思考的块
	for (const requireText of [true, false]) {
		let found;
		for (let k = start + 1; k < childList.length && !found; k++) {
			const candidate = childList[k];
			if (typeof candidate.updateContent !== "function" || candidate.hasToolCalls !== false) continue;
			const answerText = Array.isArray(candidate.lastMessage?.content)
				? candidate.lastMessage.content.filter((part) => part?.type === "text").map((part) => part.text).join("")
				: "";
			if (requireText && !answerText.trim()) continue;
			found = candidate;
		}
		if (found) {
			expectedReply.set(item, {
				blockRow: componentRows.get(found),
				blockHeight: found.render(width).length,
				candidate: found,
			});
			break;
		}
	}
}

// ---- 4. 跑扩展, 逐条看 reply 落点 ----
const work = tempDir("repro-reply");
// USE_REAL_EXT=1: 用真实扩展目录(连同 agent 目录里的配置 / debug.flag), 排障时看真实内部状态用
let load = process.env.USE_REAL_EXT
	? await loadTimeline()
	: await loadTimeline({ copyTo: join(work.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
// FORCE_MARKERS=1: 强制走备用的标记匹配路径, 用来验证退化后会怎么跳
if (process.env.FORCE_MARKERS) {
	const { readFileSync, writeFileSync } = await import("node:fs");
	const patched = readFileSync(join(work.dir, "ext", "src", "index.ts"), "utf8").replace(
		"const collected = collectMessageRecords(tui, view);",
		"const collected = undefined; // FORCE_MARKERS",
	);
	writeFileSync(join(work.dir, "ext", "src", "index.ts"), patched, "utf8");
	const { pathToFileURL } = await import("node:url");
	const loader = await import(pathToFileURL(join(PI_PACKAGE, "dist", "core", "extensions", "loader.js")).href);
	const result = await loader.loadExtensions([join(work.dir, "ext", "src", "index.ts")], process.cwd(), piPackage.createEventBus(), loader.createExtensionRuntime());
	if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
	const byName = new Map([...result.extensions[0].commands.values()].map((command) => [command.name, command]));
	load = { runNamed: (name, args, ctx) => byName.get(name).handler(args, ctx) };
}
console.log(`\n会话: ${file.split(/[\\/]/).pop()}  用户消息 ${itemComponents.length} 条`);
for (const [index, item] of itemComponents.entries()) {
	viewport.transcript.scrollTo(0, { disableFollow: true }); // 从头开始选: 光标预选会跟着视口位置走
	const inputs = [...Array.from({ length: index }, () => KEY.down), KEY.enter];
	await drivePicker({ load, tui: screen, entries, inputs });
	const actual = viewport.transcript.scrollTop;
	const expected = expectedReply.get(item);
	const maxScroll = Math.max(0, viewport.transcript.contentHeight - viewport.transcript.viewportHeight);
	const text = String(item.text).replace(/\s+/g, " ").slice(0, 24);
	// 判定: 落点在正文块内, 而且那一行就是正文文字的开头(只有思考的块: 落在块里即可); 
	// 靠近会话末尾时 ScrollView 会把顶部夹到最大可滚动处, 也算对. 
	let status;
	if (!expected) {
		status = actual !== undefined ? "no-answer" : "?";
	} else {
		const withinBlock = actual >= expected.blockRow && actual < expected.blockRow + expected.blockHeight;
		const visible = actual < expected.blockRow + expected.blockHeight && actual + viewport.transcript.viewportHeight > expected.blockRow;
		const clamped = actual === maxScroll && visible; // 伸到最大可滚动位置之外时, 块还在视口里就算对
		status = (withinBlock && textStartAt(expected.candidate, actual)) || clamped ? "ok" : "FAIL";
	}
	if (status === "FAIL" && index >= 8) {
		for (let row = actual - 4; row <= actual + 3; row++) console.log(`          行 ${row}: ${JSON.stringify(String(lines[row] ?? "").slice(0, 52))}`);
		const candidate = expected?.candidate;
		if (candidate) {
			console.log(`          正文块 ${expected.blockRow}..${expected.blockRow + expected.blockHeight}, 子块: `);
			let offset = 0;
			for (const child of candidate.contentContainer?.children ?? []) {
				const childLines = typeof child?.render === "function" ? child.render(width) : [];
				const isThinking = !!child && typeof child.onMouse === "function" && "child" in child;
				const hasVisible = childLines.some((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim().length > 0);
				console.log(`            +${offset} ${isThinking ? "思考" : "其他"} 高 ${childLines.length} 可见 ${hasVisible} 首行 ${JSON.stringify(String(childLines[0] ?? "").slice(0, 28))}`);
				offset += childLines.length;
			}
		}
	}
	console.log(
		`${status.padEnd(9)} #${index + 1} ${JSON.stringify(text)}` +
			`\n          落点 ${actual}: ${JSON.stringify(String(lines[actual] ?? "").slice(0, 44))}` +
			(expected ? `\n          正文块 ${expected.blockRow}..${expected.blockRow + expected.blockHeight}` : "\n          这一轮之后没有任何正文块(参照答案不存在)"),
	);
}
work.cleanup();
process.exit(0);
