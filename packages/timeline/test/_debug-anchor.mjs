/**
 * 一次性调试: 把计时/定位探针插进扩展副本, 看它内部算出的 record.row / textOffset. 
 * 跑: node test/_debug-anchor.mjs <会话文件> [第几条用户消息, 从 1 开始]
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHAT_VIEWPORT_URL, EXT_ENTRY, KB, KEY, PI_PACKAGE, piPackage, tempDir, tui as tuiApi } from "./harness.mjs";

const { Container, Spacer, Text, TuiAltScreen } = tuiApi;
const { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, getMarkdownTheme, initTheme, sessionEntryToContextMessages } = piPackage;
const { createChatViewport } = await import(CHAT_VIEWPORT_URL);
initTheme("dark");
const markdownTheme = getMarkdownTheme();

// ---- 打探针的副本 ----
let source = readFileSync(EXT_ENTRY, "utf8");
const probes = [
	[
		"const kind = classifyComponent(component);",
		`const kind = classifyComponent(component);
		if (kind) {
			const __h = component.render(width).length;
			console.error("[dbg] record", kind, "row", total, "height", __h, "hasToolCalls", component.hasToolCalls, "textOffset", kind === "assistant" ? assistantTextOffset(component, width) : "-", "text", JSON.stringify(String(kind === "bash" ? component.command : kind === "assistant" ? assistantText(component.lastMessage) : component.text).slice(0, 18)));
		}`,
	],
	[
		"let lines = transcriptLines(tui, view);",
		`let lines = transcriptLines(tui, view);
		console.error("[dbg] walk total", total, "lines", lines.length);`,
	],
	[
		"return anchoredRow(pickAnchorRecord(item, collected.records, jumpTo), collected.lines);",
		`{
				const __rec = pickAnchorRecord(item, collected.records, jumpTo);
				const __row = anchoredRow(__rec, collected.lines);
				console.error("[dbg] anchor record", __rec ? { kind: __rec.kind, row: __rec.row, height: __rec.height, textOffset: __rec.textOffset, landmark: __rec.landmark } : undefined, "-> row", __row);
				return __row;
			}`,
	],
];
for (const [before, after] of probes) {
	if (!source.includes(before)) throw new Error(`锚点没找到: ${before.slice(0, 40)}`);
	source = source.replace(before, after);
}
const copyDir = join(tmpdir(), "timeline-debug-anchor");
rmSync(copyDir, { recursive: true, force: true });
const copySrc = join(copyDir, "src");
mkdirSync(copySrc, { recursive: true });
writeFileSync(join(copySrc, "index.ts"), source, "utf8");
copyFileSync(EXT_ENTRY.replace(/index\.ts$/, "i18n.ts"), join(copySrc, "i18n.ts"));
// 配置只认 agent 目录那份: 这里也要隔离, 否则会读写(甚至搬走)用户真实的 ~/.pi/agent/timeline.json
const agentDir = join(tmpdir(), "timeline-debug-anchor-agent");
rmSync(agentDir, { recursive: true, force: true });
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "timeline.json"), '{"shortcut":"alt+g","jumpTo":"reply"}', "utf8");
const loader = await import(pathToFileURL(join(PI_PACKAGE, "dist", "core", "extensions", "loader.js")).href);
async function loadPatched() {
	const result = await loader.loadExtensions([join(copySrc, "index.ts")], process.cwd(), piPackage.createEventBus(), loader.createExtensionRuntime());
	if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
	const extension = result.extensions[0];
	const byName = new Map([...extension.commands.values()].map((command) => [command.name, command]));
	return {
		runNamed: (name, args, ctx) => byName.get(name).handler(args, ctx),
		runShortcut: (ctx) => {
			const handlers = [...extension.shortcuts.values()];
			const handler = handlers[0]?.handler ?? handlers[0];
			if (typeof handler !== "function") throw new Error("没有注册任何快捷键");
			return handler(ctx);
		},
	};
}

// ---- 会话 → transcript(和 repro-reply 一样) ----
const file = process.argv[2];
const which = Number(process.argv[3] ?? 1);
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
for (const entry of entries) {
	const message = (sessionEntryToContextMessages(entry) ?? [entry.message])[0] ?? entry.message;
	const role = message.role;
	if (role === "system" || role === "toolResult") continue;
	if (role === "user") {
		const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter((p) => p?.type === "text").map((p) => p.text).join("");
		if (!text) continue;
		const component = new UserMessageComponent(text, markdownTheme, 1, []);
		chat.addChild(new Spacer(1));
		chat.addChild(component);
		itemComponents.push({ entry, component, text });
		continue;
	}
	if (role === "assistant") {
		const component = new AssistantMessageComponent(message, false, markdownTheme, "Thinking...", 1, []);
		chat.addChild(new Spacer(1));
		chat.addChild(component);
		for (const content of message.content ?? []) {
			if (content.type === "toolCall") chat.addChild(new ToolExecutionComponent(content.name, content.id, content.arguments, {}, undefined, undefined, process.cwd()));
		}
	}
}
const document = new Container();
document.addChild(chat);
const viewport = createChatViewport({ document, pendingMessages: new Text(""), status: new Text(""), editor: new Text(""), footer: new Text("") });
const terminal = { columns: 100, rows: 30, kittyProtocolActive: false, start() {}, stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {} };
const screen = new TuiAltScreen(terminal);
screen.setLayoutRoot(viewport.root);
screen.start();
screen.renderNow();

const load = await loadPatched();
const work = tempDir("debug-anchor");
void work;
const ctx = {
	mode: "tui",
	sessionManager: { buildContextEntries: () => entries, getBranch: () => entries },
	ui: {
		notify: () => {},
		setEditorText: () => {},
		input: async () => undefined,
		custom: (factory) =>
			new Promise((resolvePromise) => {
				const component = factory(screen, { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t }, KB, resolvePromise);
				viewport.transcript.scrollTo(0, { disableFollow: true }); // 从头开始选: 光标预选会跟着视口位置走
				const inputs = [...Array.from({ length: which - 1 }, () => KEY.down), KEY.enter];
				for (const data of inputs) component.handleInput(data);
				resolvePromise(null);
			}),
	},
};
console.error(`[dbg] ===== 第 ${which} 条用户消息: ${JSON.stringify(String(itemComponents[which - 1]?.text).slice(0, 24))} =====`);
await load.runShortcut(ctx);
console.error(`[dbg] scrollTop = ${viewport.transcript.scrollTop}`);
process.exit(0);
