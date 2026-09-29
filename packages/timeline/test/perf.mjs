/**
 * 分环节计时: 拿最大的真实会话, 量清楚"打开面板/定位/跳转"各花在哪儿. 
 * 跑: node test/perf.mjs [会话文件]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAT_VIEWPORT_URL, KEY, driveCommand, loadTimeline, piPackage, tempDir, tui as tuiApi } from "./harness.mjs";

const { Container, Spacer, Text, TuiAltScreen } = tuiApi;
const { AssistantMessageComponent, UserMessageComponent, getMarkdownTheme, initTheme, sessionEntryToContextMessages } = piPackage;
const { createChatViewport } = await import(CHAT_VIEWPORT_URL);
initTheme("dark");
const markdownTheme = getMarkdownTheme();

function newestSession() {
	const root = join(homedir(), ".pi", "agent", "sessions");
	const candidates = [];
	for (const dir of readdirSync(root)) {
		const dirPath = join(root, dir);
		let stat;
		try {
			stat = statSync(dirPath);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		for (const name of readdirSync(dirPath)) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(dirPath, name);
			candidates.push({ path, size: statSync(path).size });
		}
	}
	candidates.sort((a, b) => b.size - a.size);
	return candidates[0];
}

const chosen = process.argv[2] ? { path: process.argv[2], size: statSync(process.argv[2]).size } : newestSession();
console.log(`会话: ${chosen.path}(${(chosen.size / 1024 / 1024).toFixed(1)}MB)\n`);

const entries = readFileSync(chosen.path, "utf8")
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
	.map((entry) => {
		const messages = sessionEntryToContextMessages(entry);
		return { ...entry, message: messages[0] ?? entry.message };
	})
	.filter((entry) => entry.message && typeof entry.message.content !== "string");

function textOf(message) {
	if (!Array.isArray(message?.content)) return "";
	return message.content.filter((part) => part?.type === "text").map((part) => part.text).join("");
}

const chat = new Container();
for (const entry of entries) {
	const role = entry.message.role;
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
const t0 = performance.now();
screen.renderNow();
const tRenderNow = performance.now() - t0;

const find = (box, view) => {
	if (!box) return undefined;
	if (box.scrollView === view) return box;
	for (const child of box.children ?? []) {
		const found = find(child, view);
		if (found) return found;
	}
	return undefined;
};
const scrollBox = find(screen.currentLayout.root, viewport.transcript);

// 全量重渲染一次(布局帧缓存失效时会走这条路)
const t1 = performance.now();
const fullRender = viewport.transcript.render(100);
const tFullRender = performance.now() - t1;

// 组件遍历(现在算行号靠它)
const t2 = performance.now();
let total = 0;
const walk = (component) => {
	if (!component || typeof component.render !== "function") return;
	const children = component.children;
	const isMessage = typeof component.updateContent === "function" || (typeof component.text === "string" && typeof component.rebuild === "function");
	if (isMessage) {
		total += component.render(100).length;
		return;
	}
	if (Array.isArray(children) && children.length > 0) {
		for (const child of children) walk(child);
		return;
	}
	total += component.render(100).length;
};
walk(scrollBox.children[0].component);
const tWalk = performance.now() - t2;

const work = tempDir("perf");
const load = await loadTimeline({ copyTo: join(work.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
const sessionEntries = entries.filter((entry) => entry.message.role !== "toolResult");
const measure = async (inputs, label) => {
	const started = performance.now();
	await driveCommand({ load, tui: screen, entries: sessionEntries, inputs, renderWidth: 100 });
	const ms = performance.now() - started;
	console.log(`${label}: ${ms.toFixed(0)}ms`);
	return ms;
};

console.log(`transcript 行数: ${scrollBox.scrollContentLines.length}(组件遍历累加 = ${total})`);
console.log(`首次渲染(pi 自己的开销): ${tRenderNow.toFixed(0)}ms`);
console.log(`全量重渲染 transcript.render(100): ${tFullRender.toFixed(0)}ms  ← 布局帧缓存失效时的代价`);
console.log(`组件遍历(算每条消息行号): ${tWalk.toFixed(0)}ms\n`);
await measure([KEY.escape], "打开面板(只定位, 不跳)  ");
await measure([KEY.escape], "打开面板(第二次)        ");
await measure([KEY.enter], "打开面板 + 跳转            ");
await measure([KEY.enter], "打开面板 + 跳转(第二次)  ");
work.cleanup();
process.exit(0);
