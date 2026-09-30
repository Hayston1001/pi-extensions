/**
 * 测试公共部分: 
 *  - 定位 @earendil-works/pi-coding-agent(不打软链, 靠候选路径 + PI_PACKAGE_DIR 覆盖)
 *  - 走 Pi 真实的扩展 loader 加载扩展(jiti + 别名, 和线上完全一致)
 *  - 假的 theme / keybindings / TUI / ctx, 用来驱动选择界面
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TEST_DIR = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = resolve(TEST_DIR, "..");
export const EXT_ENTRY = join(EXT_DIR, "src", "index.ts");

// ---------------------------------------------------------------------------
// 找 pi 包
// ---------------------------------------------------------------------------

function piPackageCandidates() {
	const candidates = [];
	// 直接在 pi 的仓库里跑测试时(本包可解析)
	try {
		candidates.push(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	} catch {
		/* 不出现在 node_modules 里, 正常 */
	}
	if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
	const roots = [
		process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules"),
		join(homedir(), ".npm-global", "lib", "node_modules"),
		join(homedir(), ".local", "lib", "node_modules"),
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
		join(process.cwd(), "node_modules"),
	].filter(Boolean);
	for (const root of roots) candidates.push(join(root, "@earendil-works", "pi-coding-agent"));
	return candidates;
}

function findPiPackage() {
	for (const candidate of piPackageCandidates()) {
		if (candidate && existsSync(join(candidate, "package.json"))) return candidate;
	}
	throw new Error(
		"找不到 @earendil-works/pi-coding-agent. \n" +
			"如果 pi 装在非标准位置, 设环境变量 PI_PACKAGE_DIR 指向那个包目录再跑测试. ",
	);
}

export const PI_PACKAGE = findPiPackage();
const PI_DIST = join(PI_PACKAGE, "dist");
export const PI_ENTRY_URL = pathToFileURL(join(PI_DIST, "index.js")).href;

function findPiTui() {
	const candidates = [
		join(PI_PACKAGE, "node_modules", "@earendil-works", "pi-tui"),
		join(dirname(PI_PACKAGE), "pi-tui"),
	];
	for (const root of piPackageCandidates()) {
		candidates.push(join(dirname(dirname(root)), "pi-tui"));
	}
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
	throw new Error("找不到 @earendil-works/pi-tui");
}

export const PI_TUI = findPiTui();
export const TUI_ENTRY_URL = pathToFileURL(join(PI_TUI, "dist", "index.js")).href;
/** pi-tui 的布局帧实现(没进 index 导出, 按文件名取).  */
export const TUI_LAYOUT_URL = pathToFileURL(join(PI_TUI, "dist", "layout.js")).href;
/** 聊天视口的构造函数, 同样没进 pi-coding-agent 的 exports map.  */
export const CHAT_VIEWPORT_URL = pathToFileURL(join(PI_DIST, "modes", "interactive", "chat-viewport.js")).href;

// ---------------------------------------------------------------------------
// 加载扩展
// ---------------------------------------------------------------------------

const loaderModule = await import(pathToFileURL(join(PI_DIST, "core", "extensions", "loader.js")).href);
export const piPackage = await import(PI_ENTRY_URL);
export const tui = await import(TUI_ENTRY_URL);

// pi 启动时会初始化主题(getSettingsListTheme / getSelectListTheme 都依赖它), 测试里也要
try {
	piPackage.initTheme?.("dark");
} catch {
	/* 没有 initTheme 的版本, 扩展自己会退化成不上色 */
}

/** 单独加载扩展自己的一个模块(i18n.ts 这种不依赖 pi 的), jiti 的解析别名与线上一致.  */
export async function loadSourceModule(file, dir = EXT_DIR) {
	const require = createRequire(join(PI_PACKAGE, "package.json"));
	const { createJiti } = require("jiti");
	const src = join(dir, "src");
	const jiti = createJiti(pathToFileURL(join(src, "index.ts")).href, {
		alias: {
			"@earendil-works/pi-coding-agent": PI_ENTRY_URL,
			"@earendil-works/pi-tui": TUI_ENTRY_URL,
		},
	});
	return jiti.import(pathToFileURL(join(src, file)).href);
}

/**
 * 用 Pi 的 loader 加载扩展, 返回可直接调用的命令 / 快捷键 / 事件处理器. 
 * copyTo 不为空时先把源码(含 src/)复制过去再加载(配置测试用, 避免动到真配置). 
 */
export async function loadTimeline({ copyTo, config, agentConfig, legacyConfig, agentDir } = {}) {
	// 配置只在 agent 目录(~/.pi/agent/timeline.json): 每个用例给一份独立的, 
	// 既不碰用户的真配置, 用例之间也不会互相串
	const agent = agentDir ?? mkdtempSync(join(tmpdir(), "timeline-agent-"));
	mkdirSync(agent, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agent;
	let entry = EXT_ENTRY;
	if (copyTo) {
		// 整个 src/ 一起拷, 不逐个列文件: 新加的模块不会漏(源码只放 src/)
		cpSync(join(EXT_DIR, "src"), join(copyTo, "src"), { recursive: true });
	}
	// 测试一律固定界面语言, 别依赖运行机器的系统区域(写了 language 的除外)
	for (const [where, text] of [[join(agent, "timeline.json"), config], [copyTo ? join(copyTo, "config.json") : undefined, legacyConfig]]) {
		if (where === undefined || text === undefined) continue;
		try {
			const parsed = JSON.parse(text);
			if (parsed.language === undefined) parsed.language = "zh";
			writeFileSync(where, JSON.stringify(parsed), "utf8");
		} catch {
			// 这份配置是故意写坏的(用来测解析失败的告警), `language` 字段塞不进去, 
			// 只能拿区域变量把语言钉住--否则文案跟着运行机器(CI 上是 en)的区域走, 断言时好时坏. 
			// 这是进程级的: 后面要用别的语言, 自己覆盖环境变量.
			writeFileSync(where, text, "utf8");
			process.env.LC_ALL = "zh_CN.UTF-8";
		}
	}
	if (copyTo) entry = join(copyTo, "src", "index.ts");
	const result = await loaderModule.loadExtensions(
		[entry],
		process.cwd(),
		piPackage.createEventBus(),
		loaderModule.createExtensionRuntime(),
	);
	if (result.errors?.length) throw new Error(`加载扩展失败: ${JSON.stringify(result.errors)}`);
	const extension = result.extensions[0];
	if (!extension) throw new Error("扩展没加载出来");
	const commands = [...extension.commands.values()];
	const byName = new Map(commands.map((command) => [command.name, command]));
	// 配置路径是按 PI_CODING_AGENT_DIR 现算的(每次调用重读环境变量), 所以每次进扩展前
	// 都要把这份 load 的 agent 目录挂回去, 免得同一进程里后建的 load 把配置指到别处
	const useAgentDir = () => {
		process.env.PI_CODING_AGENT_DIR = agent;
	};
	const withAgentDir = (fn) => (...args) => {
		useAgentDir();
		return fn(...args);
	};
	const shortcutHandler = () => {
		const handlers = [...extension.shortcuts.values()];
		const handler = handlers[0]?.handler ?? handlers[0];
		if (typeof handler !== "function") throw new Error("没有注册任何快捷键, 无法打开列表");
		return handler;
	};
	return {
		extension,
		entry,
		dir: dirname(entry),
		agentDir: agent,
		configPath: join(agent, "timeline.json"),
		commands: [...extension.commands.keys()],
		shortcuts: [...extension.shortcuts.keys()].sort(),
		startupHandlers: extension.handlers.get("session_start") ?? [],
		useAgentDir,
		// 列表入口现在只有快捷键(/timeline 命令已去掉)
		runShortcut: withAgentDir((ctx) => shortcutHandler()(ctx)),
		run: withAgentDir((ctx) => shortcutHandler()(ctx)),
		runNamed: withAgentDir((name, args, ctx) => {
			const command = byName.get(name);
			if (!command) throw new Error(`没有命令 ${name}, 只有 ${[...byName.keys()].join(", ")}`);
			return command.handler(args, ctx);
		}),
	};
}

/** 一次性搜集启动期告警(扩展在配置有问题时会用到).  */
export async function collectStartupNotices(load) {
	load.useAgentDir?.();
	const notifications = [];
	for (const handler of load.startupHandlers) {
		await handler({ type: "session_start" }, { ui: { notify: (message, kind) => notifications.push({ message, kind }) } });
	}
	return notifications;
}

// ---------------------------------------------------------------------------
// 假的终端环境
// ---------------------------------------------------------------------------

export const THEME = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	dim: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
};

const KEYS = {
	"tui.select.up": "\x1b[A",
	"tui.select.down": "\x1b[B",
	"tui.select.pageUp": "\x1b[5~",
	"tui.select.pageDown": "\x1b[6~",
	"tui.select.confirm": "\r",
	"tui.select.cancel": "\x1b",
};
export const KB = { matches: (data, id) => KEYS[id] === data };
export const KEY = {
	up: KEYS["tui.select.up"],
	down: KEYS["tui.select.down"],
	enter: "\r",
	escape: "\x1b",
	ctrlEnter: "\x1b[13;5u", // ctrl+enter(CSI u 编码): 把消息放进输入框
};

export const MARK = "\x1b]133;A\x07";

/** 造一个满足扩展探测条件的假 TUI(形状对齐 TuiAltScreen). 
 * 传了 document 就会连组件树一起造出来, 用来验证"按组件精确算行号"那条路径.  */
export function makeFakeTui(lines, { mode = "fullscreen", scrollTop = 0, columns = 100, rows = 30, document } = {}) {
	const calls = [];
	const view = {
		primary: true,
		scrollTop,
		scrollTo(row, options) {
			calls.push({ row, options });
			this.scrollTop = Math.max(0, row);
		},
		render: (width) => (document ? document.render(width ?? columns) : lines),
		getContentWidth: (width) => width,
	};
	const scrollBox = {
		scrollView: view,
		scrollContentLines: lines,
		rect: { x: 0, y: 0, width: columns, height: rows },
		children: document ? [{ component: document, rect: { x: 0, y: 0, width: columns, height: lines.length } }] : [],
	};
	const fakeTui = {
		mode,
		terminal: { columns, rows },
		currentLayout: { root: scrollBox, primaryScrollView: view },
		getPrimaryScrollView: () => view,
		renderRequests: 0,
		requestRender() {
			this.renderRequests += 1;
		},
		flashes: [],
		flash(message) {
			this.flashes.push(message);
		},
	};
	return { tui: fakeTui, view, calls };
}

/** 假的消息组件: 只满足扩展用来认人的那几个特征, 并给出确定的高度.  */
export function fakeMessageComponents() {
	const user = (text, height = 2) => ({
		text,
		outputPad: 1,
		rebuild() {},
		render: () => [MARK + ` ${text}`, ...Array.from({ length: height - 1 }, () => "")],
		children: [],
	});
	// 真实组件: 带工具调用的助手块不会打 OSC 133 标记(pi 只标记"正文"), 所以这里也暴露 hasToolCalls
	const assistant = (text, renders = true, hasToolCalls = false) => ({
		lastMessage: { role: "assistant", content: text ? [{ type: "text", text }] : [] },
		hasToolCalls,
		updateContent() {},
		// 真实渲染出来的助手块第一行是上边距空行, 正文在下一行
		render: () => (renders ? [MARK, ` ● ${text}`, ""] : []),
		children: [],
	});
	const bash = (command) => ({
		command,
		outputLines: [],
		appendOutput() {},
		render: () => [`$ ${command}`, ""],
		children: [],
	});
	const textLine = (content) => ({ render: () => [content], children: [] });
	const spacer = () => ({ render: () => [""], children: [] });
	const document = (children) => ({ children, render: (width) => children.flatMap((child) => child.render(width)) });
	return { user, assistant, bash, textLine, spacer, document };
}

/** 选中「预览里包含这段文字」的那条并回车(比数 ↓ 更耐改).  */
export function selectByText(matchText, { enter = KEY.enter } = {}) {
	return [...matchText, enter];
}

/**
 * 驱动一次扩展命令: 投递按键, 收集界面输出与通知. 
 * inputs 可以是 string[](每次弹层都用同一串按键), 也可以是 string[][](每个弹层一份). 
 * mode / hasUI 用来走非 TUI 分支(逐项选择对话框 / 无 UI 的状态提示); 
 * selects 是逐项选择对话框的脚本化答案(undefined 表示用户取消). 
 */
export async function driveCommand({
	load,
	name,
	args = "",
	tui: fakeTui,
	entries,
	branchEntries,
	inputs = [],
	renderWidth = 90,
	answer,
	mode = "tui",
	hasUI = true,
	selects: scriptedSelects = [],
}) {
	const notifications = [];
	const prompts = [];
	const selectCalls = [];
	const renders = [];
	const steps = [];
	const queue = Array.isArray(inputs?.[0]) ? [...inputs] : undefined;
	let editorText;
	const ctx = {
		mode,
		hasUI,
		sessionManager: { buildContextEntries: () => entries, getBranch: () => branchEntries ?? entries },
		ui: {
			notify: (message, kind) => notifications.push({ message, kind }),
			setEditorText: (text) => {
				editorText = text;
			},
			select: async (title, values) => {
				selectCalls.push({ title, values });
				return scriptedSelects.length > 0 ? scriptedSelects.shift() : undefined;
			},
			input: async (title, placeholder) => {
				prompts.push({ title, placeholder });
				return answer;
			},
			custom: (factory) =>
				new Promise((resolvePromise) => {
					let closed = false;
					const done = (result) => {
						if (closed) return;
						closed = true;
						resolvePromise(result);
					};
					const component = factory(fakeTui, THEME, KB, done);
					for (const data of queue ? (queue.shift() ?? []) : inputs) {
						if (closed) break;
						component.handleInput(data);
						steps.push(component.render(renderWidth).join("\n"));
					}
					renders.push(component.render(renderWidth).join("\n"));
					if (!closed) resolvePromise(null);
				}),
		},
	};
	// name 不给就走快捷键(打开列表); 给 name 就走对应命令(如 timeline-settings)
	if (name) await load.runNamed(name, args, ctx);
	else await load.runShortcut(ctx);
	return { notifications, editorText, prompts, selects: selectCalls, renders, steps, rendered: renders.at(-1) ?? "" };
}

/** 驱动一次选择界面(快捷键打开的列表).  */
export async function drivePicker({ load, tui: fakeTui, entries, branchEntries, inputs, renderWidth = 90 }) {
	return driveCommand({ load, tui: fakeTui, entries, branchEntries, inputs, renderWidth });
}

// ---------------------------------------------------------------------------
// 造会话条目 / 渲染行
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-01-01T10:00:00Z");

export function userEntry(id, text, minute = 0) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(T0 + minute * 60_000).toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: T0 + minute * 60_000 },
	};
}
export function assistantEntry(id, text, minute = 0) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(T0 + minute * 60_000).toISOString(),
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: T0 + minute * 60_000 },
	};
}
export function bashEntry(id, command, minute = 0) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(T0 + minute * 60_000).toISOString(),
		message: {
			role: "bashExecution",
			command,
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: T0 + minute * 60_000,
		},
	};
}

/**
 * 合成 Pi 风格的 transcript 行. block 支持: 
 *   { role: "user"|"assistant"|"bash", text, rendered?, renderedLines?, noRender? }
 */
export function renderLines(blocks) {
	const lines = ["  Pi v0.87.1 · 头部噪声", ""];
	for (const block of blocks) {
		if (block.role === "user") {
			const rendered = block.renderedLines ?? [block.rendered ?? block.text];
			lines.push(`${MARK}\x1b[48;5;236m ${rendered[0]}`);
			for (const extra of rendered.slice(1)) lines.push(`\x1b[48;5;236m ${extra}`);
			lines.push("");
		} else if (block.role === "assistant") {
			if (block.noRender) continue;
			lines.push(`${MARK}\x1b[36m● ${block.text}`);
			lines.push("");
		} else if (block.role === "bash") {
			lines.push(`\x1b[33m$ ${block.text}`);
			lines.push("");
		}
	}
	return lines;
}

// ---------------------------------------------------------------------------
// 测试小框架 + 临时目录
// ---------------------------------------------------------------------------

export function createSuite(title) {
	const failures = [];
	console.log(`\n${title}`);
	return {
		async test(name, fn) {
			try {
				await fn();
				console.log(`  ok   ${name}`);
			} catch (error) {
				failures.push(name);
				const detail = (error.stack ?? String(error)).split("\n").slice(0, 4).join("\n       ");
				console.log(`  FAIL ${name}\n       ${detail}`);
			}
		},
		finish() {
			return failures.length;
		},
	};
}

/** 建一个临时目录; 返回目录和清理函数.  */
export function tempDir(name) {
	const dir = join(tmpdir(), `timeline-test-${name}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return {
		dir,
		write(relativePath, content) {
			const target = join(dir, relativePath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content, "utf8");
			return target;
		},
		read: (relativePath) => readFileSync(join(dir, relativePath), "utf8"),
		exists: (relativePath) => existsSync(join(dir, relativePath)),
		list: () => readdirSync(dir),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export function isMain(importMetaUrl) {
	try {
		return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(importMetaUrl));
	} catch {
		return false;
	}
}
