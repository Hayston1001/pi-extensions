/**
 * 用自己的真实会话文件验证: reply 落点是不是"这一轮的末块(真正的回答)". 
 * 跑: node test/_verify-real-session.mjs [会话文件]
 * 依赖 ~/.pi/agent/sessions 里有会话; 没有就跳过(它不是回归测试的一部分). 
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAT_VIEWPORT_URL, KEY, driveCommand, loadTimeline, piPackage, tempDir, tui as tuiApi, TUI_LAYOUT_URL } from "./harness.mjs";

const { Container, Spacer, Text, TuiAltScreen } = tuiApi;
const { AssistantMessageComponent, UserMessageComponent, getMarkdownTheme, initTheme, sessionEntryToContextMessages } = piPackage;
const { createChatViewport } = await import(CHAT_VIEWPORT_URL);
initTheme("dark");
const markdownTheme = getMarkdownTheme();

const sessionRoot = join(homedir(), ".pi", "agent", "sessions");
function newestSessionFile() {
	const candidates = [];
	for (const dir of readdirSync(sessionRoot)) {
		const full = join(sessionRoot, dir);
		let stat;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		for (const name of readdirSync(full)) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(full, name);
			candidates.push({ path, mtime: statSync(path).mtimeMs });
		}
	}
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates[0]?.path;
}

const file = process.argv[2] ?? newestSessionFile();
if (!file) {
	console.log("没找到会话文件, 跳过");
	process.exit(0);
}
console.log("会话:", file, "\n");

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
	.filter((entry) => entry && entry.type === "message" && entry.message)
	.map((entry, index) => ({ ...entry, timestamp: entry.timestamp ?? new Date(Date.parse("2026-01-01T10:00:00Z") + index * 1000).toISOString() }))
	// 会话文件里的消息 content 可能是 null/字符串, 按 pi 自己的规则归一化
	.map((entry) => {
		const messages = sessionEntryToContextMessages(entry);
		return { ...entry, message: messages[0] ?? entry.message };
	})
	.filter((entry) => entry.message && typeof entry.message.content !== "string");

function textOf(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text")
		.map((part) => part.text)
		.join("");
}

// 用真组件按 transcript 的顺序搭出来(和 pi 的 addMessageToChat 一样的组件与间距)
const chat = new Container();
chat.addChild(new Text("Pi · 会话回放"));
for (const entry of entries) {
	const role = entry.message.role;
	// 只有 user/assistant 在 transcript 里各占一块; toolResult 是挂在对应工具调用下面的
	if (role !== "user" && role !== "assistant") continue;
	chat.addChild(new Spacer(1));
	chat.addChild(
		role === "user"
			? new UserMessageComponent(textOf(entry.message), markdownTheme, 1, [])
			: new AssistantMessageComponent(entry.message, false, markdownTheme, "Thinking...", 1, []),
	);
}
const document = new Container();
document.addChild(chat);
const viewport = createChatViewport({ document, pendingMessages: new Text(""), status: new Text(""), editor: new Text(""), footer: new Text("") });
const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {} };
const screen = new TuiAltScreen(terminal);
screen.setLayoutRoot(viewport.root);
screen.start();
screen.renderNow();
const box = (function find(box, view) {
	if (!box) return undefined;
	if (box.scrollView === view) return box;
	for (const child of box.children ?? []) {
		const found = find(child, view);
		if (found) return found;
	}
	return undefined;
})(screen.currentLayout.root, viewport.transcript);
const lines = box.scrollContentLines;
const plain = lines.map((line) =>
	line
		.replace(new RegExp("\u001b\\][^\u0007\u001b]*(?:\u0007|\u001b\\\\)", "g"), "")
		.replace(new RegExp("\u001b\\[[0-9;?]*[ -/]*[@-~]", "g"), ""),
);
const isVisible = (row) => plain[row] !== undefined && plain[row].trim().length > 0;

// 会话里的用户消息. 最后一条往往还在进行中(回答正写着), 那种没法比对, 先排除
const allUsers = entries.filter((entry) => entry.message.role === "user" && textOf(entry.message).trim());
const userEntries = allUsers.filter((entry) => {
	const at = entries.indexOf(entry);
	return entries.slice(at + 1).some((next) => next.message.role === "user" && textOf(next.message).trim());
});
console.log(`会话里 ${allUsers.length} 条用户消息(${userEntries.length} 条已完结); 挑最后 3 条验证 reply 落点\n`);

const work = tempDir("verify");
const loadReply = await loadTimeline({ copyTo: join(work.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });

for (const entry of userEntries.slice(-3)) {
	const question = textOf(entry.message).replace(/\s+/g, " ").slice(0, 30);
	// 用它后面到下一个用户消息之间的**第一条不打工具调用的助手块**作为预期(和 pi 的 ctrl+↓ 一致)
	index0: {
		const at = entries.indexOf(entry);
		let expected = "";
		for (let k = at + 1; k < entries.length; k++) {
			const next = entries[k];
			if (next.message.role === "user" && textOf(next.message).trim()) break;
			if (next.message.role !== "assistant") continue;
			const hasToolCall = Array.isArray(next.message.content) && next.message.content.some((part) => part?.type === "toolCall");
			if (!hasToolCall && textOf(next.message).trim()) {
				expected = textOf(next.message);
				break;
			}
		}
		if (!expected) break index0;
		// 面板里选中这条(用问题文本过滤), 回车
		const result = await driveCommand({
			load: loadReply,
			tui: screen,
			entries: entries.filter((item) => item.message.role !== "toolResult"),
			inputs: [...question.slice(0, 12), KEY.enter],
			renderWidth: 100,
		});
		const row = viewport.transcript.scrollTop;
		// 落点行是回答的第一行, 回答可能还要往下好几行, 所以比对"落点行是期望回答的前缀"
		const landed = plain[row] ?? "";
		const collapse = (text) => text.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
		const ok = result.notifications.length === 0 && collapse(expected).startsWith(collapse(landed)) && collapse(landed).length > 0;
		console.log(`${ok ? "ok  " : "FAIL"} 问: ${question}`);
		console.log(`      落点第 ${row} 行: ${JSON.stringify(landed.slice(0, 50))}`);
		console.log(`      期望想看到这轮末块开头: ${JSON.stringify(expected.replace(/\s+/g, " ").slice(0, 50))}`);
		console.log(`      落点行有内容: ${isVisible(row)}  提示数: ${result.notifications.length}\n`);
	}
}
work.cleanup();
process.exit(0);
