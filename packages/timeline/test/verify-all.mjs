/**
 * 全量校验: 把真实会话里每条用户消息都跳一遍, 检查落点就是它自己那一块. 
 * 重点盯重复文本(连发同一句话, 同一条 !命令 跑多次)--"概率性跳错"的高发区. 
 * 跑: node test/verify-all.mjs [会话文件 ...](不传就检查最大的几个会话)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAT_VIEWPORT_URL, KEY, drivePicker, loadTimeline, piPackage, tempDir, tui as tuiApi } from "./harness.mjs";

const { Container, Spacer, Text, TuiAltScreen } = tuiApi;
const { AssistantMessageComponent, UserMessageComponent, getMarkdownTheme, initTheme, parseSkillBlock, sessionEntryToContextMessages } = piPackage;
const { createChatViewport } = await import(CHAT_VIEWPORT_URL);
initTheme("dark");
const markdownTheme = getMarkdownTheme();

function sessionFiles() {
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
	return candidates.map((candidate) => candidate.path);
}

function textOf(message) {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.filter((part) => part?.type === "text").map((part) => part.text).join("");
}

function norm(text) {
	return String(text ?? "")
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
		.replace(/\s+/g, "")
		.replace(/[*_`#>~|[\]()]/g, "");
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

const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : sessionFiles().slice(0, Number(process.env.VERIFY_ALL_N ?? 3));
const work = tempDir("verify-all");
const load = await loadTimeline({ copyTo: join(work.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"user"}' });

let totalChecked = 0;
let totalFailed = 0;
let totalWarned = 0;
let totalDuplicateItems = 0;

for (const file of files) {
	const raw = readFileSync(file, "utf8");
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

	// transcript: 每条 user/assistant 消息各一个真组件(toolResult 不单独成块, 和 pi 一致)
	const chat = new Container();
	chat.addChild(new Text("Pi · 会话回放"));
	const itemComponents = []; // 列表项(用户消息 / !命令)对应的组件, 顺序即列表顺序
	for (const entry of entries) {
		const role = entry.message.role;
		if (role === "user") {
			const text = textOf(entry.message);
			if (!text) continue; // pi 不渲染空文本用户消息
			// 技能块: pi 渲染的是 skill 里的用户气泡, 列表里也是它
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
		chat.addChild(new Spacer(1));
		if (role === "bashExecution") {
			const component = {
				command: entry.message.command ?? "",
				outputLines: [],
				appendOutput() {},
				render: (width) => [`$ ${entry.message.command}`.slice(0, width), ""],
				children: [],
			};
			chat.addChild(component);
			itemComponents.push({ entry, component, text: `!${entry.message.command}` });
		} else if (role === "assistant") {
			chat.addChild(new AssistantMessageComponent(entry.message, false, markdownTheme, "Thinking...", 1, []));
		}
	}
	const document = new Container();
	document.addChild(chat);
	const viewport = createChatViewport({ document, pendingMessages: new Text(""), status: new Text(""), editor: new Text(""), footer: new Text("") });
	const screen = new TuiAltScreen(makeTerminal(100, 30));
	screen.setLayoutRoot(viewport.root);
	screen.start();
	screen.renderNow();

	// 参照答案: 按创建顺序累加每个组件的渲染高度 = 每个组件第一行的行号
	const width = viewport.transcript.getContentWidth(100);
	const expectedRows = [];
	let position = 0;
	for (const child of chat.children) {
		const height = child.render(width).length;
		if (itemComponents.some((item) => item.component === child)) expectedRows.push({ row: position, component: child });
		position += height;
	}
	const expectedByComponent = new Map(expectedRows.map((item) => [item.component, item.row]));

	// 重复文本统计: 同文本的列表项是"概率性跳错"的高发区
	const counts = new Map();
	for (const item of itemComponents) {
		const key = norm(item.text);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const duplicateItems = itemComponents.filter((item) => (counts.get(norm(item.text)) ?? 0) > 1);
	totalDuplicateItems += duplicateItems.length;

	// 抽查: 全部重复文本的项 + 均匀抽样的其余项(每个会话最多 80 条)
	const sampled = [];
	const seen = new Set();
	const push = (item) => {
		if (seen.has(item)) return;
		seen.add(item);
		sampled.push(item);
	};
	for (const item of duplicateItems) push(item);
	const others = itemComponents.filter((item) => !duplicateItems.includes(item));
	const step = Math.max(1, Math.ceil(others.length / Math.max(1, 80 - duplicateItems.length)));
	for (let index = 0; index < others.length; index += step) push(others[index]);

	const maxScroll = Math.max(0, viewport.transcript.contentHeight - viewport.transcript.viewportHeight);
	const lines = viewport.transcript.render(100);
	let failed = 0;
	for (const item of sampled) {
		const index = itemComponents.indexOf(item);
		viewport.transcript.scrollTo(0, { disableFollow: true }); // 从头开始选: 光标预选会跟着视口位置走
		const inputs = [...Array.from({ length: index }, () => KEY.down), KEY.enter];
		const { notifications } = await drivePicker({ load, tui: screen, entries, inputs });
		totalChecked += 1;
		const expected = Math.min(expectedByComponent.get(item.component), maxScroll);
		const actual = viewport.transcript.scrollTop;
		const landed = norm(lines.slice(actual, actual + 4).join("\n")); // 块首是标记行, 正文在紧接着的几行里
		const want = norm(item.text).slice(0, 12);
		const okRow = actual === expected;
		const okText = want.length === 0 || landed.includes(want);
		if (!okRow || notifications.length > 0) {
			failed += 1;
			totalFailed += 1;
			console.log(`  FAIL #${index + 1} ${JSON.stringify(String(item.text).slice(0, 24))}`);
			console.log(`       落点第 ${actual} 行(期望 ${expected}): ${JSON.stringify(String(lines[actual] ?? "").slice(0, 40))}`);
			if (notifications.length > 0) console.log(`       提示: ${notifications.map((item2) => item2.message).join(" / ")}`);
		} else if (!okText) {
			// 行对了, 但落点附近的文本和条目原文不一样(渲染改写: emoji 占位符, markdown 等)
			totalWarned += 1;
			console.log(`  warn #${index + 1} 行号正确(第 ${actual} 行), 但文本被渲染改写: ${JSON.stringify(String(item.text).slice(0, 20))}`);
		}
	}
	console.log(`${failed === 0 ? "ok  " : "FAIL"} ${file.split(/[\\/]/).pop()}  共 ${itemComponents.length} 条消息, 其中重复文本 ${duplicateItems.length} 条; 抽查 ${sampled.length} 条`);
}

work.cleanup();
console.log(`\n合计检查 ${totalChecked} 条(重复文本 ${totalDuplicateItems} 条), 失败 ${totalFailed} 条, 文本被渲染改写 ${totalWarned} 条`);
process.exit(totalFailed === 0 ? 0 : 1);
