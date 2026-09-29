/**
 * 分段落细账: 把计时探针临时插进扩展的副本里, 量清"打开面板"的每一段开销. 
 * 跑: node test/perf-detail.mjs
 */
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHAT_VIEWPORT_URL, KB, KEY, PI_PACKAGE, EXT_ENTRY, piPackage, tui as tuiApi } from "./harness.mjs";

const { Container, Spacer, Text, TuiAltScreen } = tuiApi;
const { AssistantMessageComponent, UserMessageComponent, getMarkdownTheme, initTheme, sessionEntryToContextMessages } = piPackage;
const { createChatViewport } = await import(CHAT_VIEWPORT_URL);
initTheme("dark");
const markdownTheme = getMarkdownTheme();

// ---- 1. 造一份打了探针的副本 ----
let source = readFileSync(EXT_ENTRY, "utf8");
let probeIndex = 0;
const probe = (before, label) => {
	if (!source.includes(before)) throw new Error(`探针锚点没找到: ${before.slice(0, 40)}`);
	const timer = `__probe${(probeIndex += 1)}`;
	source = source.replace(
		before,
		`const ${timer} = performance.now();\n\t${before}\n\tconsole.error("  [probe] ${label}:", (performance.now() - ${timer}).toFixed(1) + "ms");`,
	);
};
probe("const { items, skipped } = buildPickerData(ctx);", "buildPickerData(扫会话条目建列表)");
probe("const rows = locateRows(items, tui, capturedView, jumpTo);", "locateRows(打开时定位一遍)");
probe("const collected = collectMessageRecords(tui, view);", "  collectMessageRecords 小计");
probe("walk(document);", "    组件遍历");
probe("let lines = transcriptLines(tui, view);", "    取内容行(布局帧缓存)");
probe("const located = locateRowsFromRecords(items, collected.records);", "    条目↔组件配对");
probe("const row = locateRows(items, picked.tui, picked.view, loadShortcutConfig().jumpTo)[index];", "locateRows(跳转时重新定位)");

const copyDir = join(tmpdir(), "timeline-perf-detail");
rmSync(copyDir, { recursive: true, force: true });
const copySrc = join(copyDir, "src");
mkdirSync(copySrc, { recursive: true });
const copyPath = join(copySrc, "index.ts");
writeFileSync(copyPath, source, "utf8");
copyFileSync(EXT_ENTRY.replace(/index\.ts$/, "i18n.ts"), join(copySrc, "i18n.ts"));

// 直接走 pi 的 loader 加载副本(不用 harness 的 copyTo, 它会覆盖探针)
const loader = await import(pathToFileURL(join(PI_PACKAGE, "dist", "core", "extensions", "loader.js")).href);
async function loadPatched() {
	const result = await loader.loadExtensions([copyPath], process.cwd(), piPackage.createEventBus(), loader.createExtensionRuntime());
	if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
	const extension = result.extensions[0];
	const commands = [...extension.commands.values()];
	const byName = new Map(commands.map((command) => [command.name, command]));
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

// ---- 2. 造真实会话的 transcript ----
function biggestSession() {
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
const chosen = biggestSession();
console.log(`会话: ${chosen.path}(${(chosen.size / 1024 / 1024).toFixed(1)}MB)\n`);
const raw = readFileSync(chosen.path, "utf8");
const entries = raw
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
screen.renderNow();

const sessionEntries = entries.filter((entry) => entry.message.role !== "toolResult");
const load = await loadPatched();

async function run(label, inputs) {
	console.log(`--- ${label} ---`);
	const started = performance.now();
	let renderMs = 0;
	const ctx = {
		mode: "tui",
		sessionManager: { buildContextEntries: () => sessionEntries, getBranch: () => sessionEntries },
		ui: {
			notify: () => {},
			setEditorText: () => {},
			input: async () => undefined,
			custom: (factory) =>
				new Promise((resolvePromise) => {
					const component = factory(screen, { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t }, KB, resolvePromise);
					for (const data of inputs) component.handleInput(data);
					const t = performance.now();
					component.render(100);
					renderMs = performance.now() - t;
					resolvePromise(null);
				}),
		},
	};
	await load.runShortcut(ctx);
	console.log(`  [probe] 面板组件 render(列表排版): ${renderMs.toFixed(1)}ms`);
	console.log(`  合计: ${(performance.now() - started).toFixed(1)}ms\n`);
}

await run("打开面板(只定位, 不跳)", [KEY.escape]);
await run("打开面板(第二次)", [KEY.escape]);
await run("打开面板 + 跳转", [KEY.enter]);
process.exit(0);
