/**
 * 测试公共部分:
 *  - 定位 @earendil-works/pi-coding-agent / pi-tui(候选路径 + PI_PACKAGE_DIR 覆盖,不打软链)
 *  - 用与 pi 线上一致的 jiti + 别名加载扩展模块
 *  - 提供面板测试用的假 TUI / 上下文 / 主题
 */
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const TEST_DIR = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = dirname(TEST_DIR);
/** 扩展的全部源文件(相对包目录):复制到隔离目录时一个都不能漏.  */
export const EXT_FILES = ["src/index.ts", "src/config.ts"];

// 必须在任何模块读配置之前设好:没有它, config.ts 的回退路径会落到用户真实的 ~/.pi/agent. 
if (!process.env.PI_CODING_AGENT_DIR) {
	process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "pi-thinking-display-test-agent");
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

/** 加载扩展的两个模块 + pi-tui(同一 jiti 实例,保证类与状态同一份).  */
export async function loadModules(dir = EXT_DIR) {
	const jiti = createLoader(join(TEST_DIR, "harness.mjs"));
	const tui = await jiti.import(PI_TUI_ENTRY);
	const config = await jiti.import(pathToFileURL(join(dir, "src", "config.ts")).href);
	const index = await jiti.import(pathToFileURL(join(dir, "src", "index.ts")).href);
	return { jiti, tui, piPackage: await jiti.import(PI_ENTRY), config, index };
}

/** 只加载 pi 自己(生命周期测试让真实 loader 去跑扩展, 这里不预先加载).  */
export async function loadPiPackage() {
	const jiti = createLoader(join(TEST_DIR, "harness.mjs"));
	return { jiti, tui: await jiti.import(PI_TUI_ENTRY), piPackage: await jiti.import(PI_ENTRY) };
}

/** 只加载 config 模块(测配置路径规则时用另一份拷贝).  */
export async function loadConfigModule(dir) {
	const entry = join(dir, "src", "config.ts");
	const jiti = createLoader(entry);
	return jiti.import(pathToFileURL(entry).href);
}

/** 把扩展复制到隔离目录(配置回退路径绝不能碰用户真实 ~/.pi/agent).  */
export function copyExtensionTo(targetDir, from = EXT_DIR) {
	mkdirSync(targetDir, { recursive: true });
	// 源文件按相对路径复制(保留 src/); package.json 也带上, 让生命周期用例的 pi 发现链路
	// 能读到 pi.extensions(指向 ./src/index.ts). 
	for (const file of [...EXT_FILES, "package.json"]) {
		const target = join(targetDir, file);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(from, file), target);
	}
	return targetDir;
}

export function isolatedAgentDir(name) {
	return join(tmpdir(), `pi-thinking-display-test-${name}`);
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
 * 假 ExtensionAPI:捕获 handler 与命令, 其余照单全收.
 * (生命周期时序走真实 AgentSession, 见 lifecycle.test.mjs;这里测行为)
 */
export function makeApi() {
	const handlers = new Map();
	const commands = new Map();
	const api = {
		on: (event, handler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name, definition) => {
			commands.set(name, definition);
		},
		registerTool: () => {},
		registerFlag: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};
	return { api, handlers, commands };
}

/** 假 ui context:记下 notify / custom / widget, 调用方可以从 calls 里取.  */
export function makeUi(selectAnswers = [], overrides = {}) {
	const answers = [...selectAnswers];
	const calls = { notify: [], custom: [], widgets: new Map(), select: [] };
	const ui = {
		theme: makeTheme(),
		select: async (title, options) => {
			calls.select.push({ title, options });
			return answers.shift();   // 脚本用完 = 用户取消
		},
		confirm: async () => false,
		input: async () => undefined,
		notify: (message, type) => {
			calls.notify.push({ message, type });
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
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
	return { mode: "tui", hasUI: true, cwd: process.cwd(), ui, ...extra };
}

/** 面板用的假主题(只需 fg / bold).  */
export function makeTheme() {
	return {
		fg: (color, text) => `<${color}>${text}</>`,
		bold: (text) => `**${text}**`,
	};
}

/** 假 TUI:鼠标补丁需要原型上的 handleMouseEvent / requestRender.  */
export class FakeTui {
	renders = 0;
	mouseEvents = [];

	requestRender() {
		this.renders += 1;
	}

	handleMouseEvent(event) {
		this.mouseEvents.push(event);
	}
}

/** 去掉 ANSI 转义码与 OSC(OSC133 是逐字符拆字符串的常客), 断言前先剥掉.  */
export function stripAnsi(text) {
	return String(text)
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;]*m/g, "");
}
