/**
 * 测试公共部分:
 *  - 定位 @earendil-works/pi-coding-agent / pi-tui(候选路径 + PI_PACKAGE_DIR 覆盖,不打软链)
 *  - 用与 pi 线上一致的 jiti + 别名加载扩展模块
 *  - 提供面板 / 事件接线测试用的假 ExtensionAPI, ui context, 主题与可控时钟
 */
import { cpSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const TEST_DIR = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = dirname(TEST_DIR);

// 必须在任何模块读配置之前设好:没有它, config.ts 的回退路径会落到用户真实的 ~/.pi/agent. 
if (!process.env.PI_CODING_AGENT_DIR) {
	process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "pi-token-meter-test-agent");
}
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

function piPackageCandidates() {
	const candidates = [];
	try {
		candidates.push(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	} catch {
		/* 不在 node_modules 里,正常 */
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
			"如果 pi 装在非标准位置,设环境变量 PI_PACKAGE_DIR 指向那个包目录再跑测试. ",
	);
}

export const PI_PACKAGE = findPiPackage();
export const PI_TUI = join(PI_PACKAGE, "node_modules", "@earendil-works", "pi-tui");
const PI_ENTRY = join(PI_PACKAGE, "dist", "index.js");
const PI_TUI_ENTRY = join(PI_TUI, "dist", "index.js");

/** jiti 走 pi 的解析别名(与线上加载扩展一致).  */
function createLoader(entry) {
	// jiti 随 pi 一起分发
	const require = createRequire(join(PI_PACKAGE, "package.json"));
	const { createJiti } = require("jiti");
	return createJiti(pathToFileURL(entry).href, {
		alias: {
			"@earendil-works/pi-coding-agent": PI_ENTRY,
			"@earendil-works/pi-tui": PI_TUI_ENTRY,
		},
	});
}

/** 加载扩展的全部模块 + pi-tui(同一 jiti 实例,保证类与状态同一份).  */
export async function loadModules(dir = EXT_DIR) {
	const jiti = createLoader(join(TEST_DIR, "harness.mjs"));
	const load = (file) => jiti.import(pathToFileURL(join(dir, "src", file)).href);
	return {
		jiti,
		tui: await jiti.import(PI_TUI_ENTRY),
		piPackage: await jiti.import(PI_ENTRY),
		config: await load("config.ts"),
		i18n: await load("i18n.ts"),
		meter: await load("meter.ts"),
		render: await load("render.ts"),
		panel: await load("panel.ts"),
		index: await load("index.ts"),
	};
}

/** 只加载 pi 自己(生命周期测试让真实 loader 去跑扩展, 这里不预先加载).  */
export async function loadPiPackage() {
	const jiti = createLoader(join(TEST_DIR, "harness.mjs"));
	return { jiti, tui: await jiti.import(PI_TUI_ENTRY), piPackage: await jiti.import(PI_ENTRY) };
}

/** 只加载 config / i18n 模块(测配置路径规则时用另一份拷贝).  */
export async function loadConfigModule(dir) {
	const entry = join(dir, "src", "config.ts");
	const jiti = createLoader(entry);
	return jiti.import(pathToFileURL(entry).href);
}

/** 把扩展复制到隔离目录(配置回退路径绝不能碰用户真实 ~/.pi/agent).  */
export function copyExtensionTo(targetDir, from = EXT_DIR) {
	mkdirSync(targetDir, { recursive: true });
	// 整个 src/ 一起拷(源码只放这里), 不逐个列文件: 新加的模块不会漏; package.json 也带上,
	// 让生命周期用例的 pi 发现链路能读到 pi.extensions(指向 ./src/index.ts).
	cpSync(join(from, "src"), join(targetDir, "src"), { recursive: true });
	copyFileSync(join(from, "package.json"), join(targetDir, "package.json"));
	return targetDir;
}

export function isolatedAgentDir(name) {
	return join(tmpdir(), `pi-token-meter-test-${name}`);
}

export function makeChecker() {
	let failures = 0;
	const check = (label, cond, detail) => {
		if (cond) {
			console.log(`  ok   ${label}`);
		} else {
			failures += 1;
			console.log(`  FAIL ${label}${detail !== undefined ? ` :: ${detail}` : ""}`);
		}
	};
	return { check, failures: () => failures };
}

/**
 * 假 ExtensionAPI:捕获 handler / 命令 / 入口渲染器 / appendEntry.
 * (真实加载链路见 lifecycle.test.mjs)
 */
export function makeApi() {
	const handlers = new Map();
	const commands = new Map();
	const entryRenderers = new Map();
	const entries = [];
	const api = {
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name, definition) => {
			commands.set(name, definition);
		},
		registerEntryRenderer: (type, renderer) => {
			entryRenderers.set(type, renderer);
		},
		appendEntry: (type, data) => {
			entries.push({ type, data });
		},
		getThinkingLevel: () => "medium",
		registerTool: () => {},
		registerFlag: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};
	return { api, handlers, commands, entryRenderers, entries };
}

/** 依次调用某个事件的全部 handler.  */
export async function emit(handlers, event, ...args) {
	for (const handler of handlers.get(event) ?? []) {
		await handler(...args);
	}
}

/**
 * 假 ui context:记下调用;select 按脚本出答案(script 用完返回 undefined = 用户取消).
 */
export function makeUi(selectAnswers = [], overrides = {}) {
	const answers = [...selectAnswers];
	const calls = { notify: [], custom: [], widgets: new Map(), select: [], workingMessages: [], status: [] };
	const ui = {
		theme: makeTheme(),
		select: async (title, options) => {
			calls.select.push({ title, options });
			return answers.shift();
		},
		confirm: async () => false,
		input: async () => undefined,
		notify: (message, type) => {
			calls.notify.push({ message, type });
		},
		onTerminalInput: () => () => {},
		setStatus: (key, text) => {
			calls.status.push({ key, text });
		},
		setWorkingMessage: (message) => {
			calls.workingMessages.push(message);
		},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: (key, factory) => {
			calls.widgets.set(key, factory);
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async (factory) => {
			calls.custom.push(factory);
			return undefined;
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		...overrides,
	};
	return { ui, calls };
}

export function makeContext(ui, extra = {}) {
	return {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		model: { id: "test-model" },
		ui,
		getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
		sessionManager: { getBranch: () => [] },
		isIdle: () => true,
		...extra,
	};
}

/** 假主题:fg 记录颜色名,便于断言取色(不断言颜色时可用 plainTheme).  */
export function makeTheme() {
	return {
		fg: (color, text) => `[${color}]${text}`,
		bg: (color, text) => `{${color}}${text}`,
		bold: (text) => `*${text}*`,
		italic: (text) => `_${text}_`,
		dim: (text) => text,
		// pi 的 working 行/编辑器边框用这个上色(随思考强度变)
		getThinkingBorderColor: (level) => (text) => `[thinking:${level}]${text}`,
		getBashModeBorderColor: () => (text) => `[bashMode]${text}`,
	};
}

/** 只关心文本内容的主题(过滤掉颜色标记).  */
export function plainTheme() {
	return {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
		italic: (text) => text,
		getThinkingBorderColor: () => (text) => text,
		getBashModeBorderColor: () => (text) => text,
	};
}

/** 可控时钟:计量里的耗时 / tok/s 需要确定性. 用完记得 restore().  */
export function useFakeClock(start = 1_000_000) {
	const real = Date.now;
	let now = start;
	Date.now = () => now;
	return {
		now: () => now,
		advance(ms) {
			now += ms;
		},
		restore() {
			Date.now = real;
		},
	};
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 去掉 ANSI 转义码与 OSC(渲染会把字符串拆开,断言前先剥掉).  */
export function stripAnsi(text) {
	return String(text)
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;]*m/g, "");
}
