/**
 * 测试公共部分:
 *  - 定位 @earendil-works/pi-coding-agent / pi-tui(候选路径 + PI_PACKAGE_DIR 覆盖,不打软链)
 *  - 用与 pi 线上一致的 jiti + 别名加载扩展模块
 *  - 提供渲染测试用的假 theme / 上下文
 */
import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const TEST_DIR = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = dirname(TEST_DIR);

// 必须在任何模块读配置之前设好: 没有它, config.ts 的路径会落到用户真实的 ~/.pi/agent.
// 用例仍可用 isolatedAgentDir() 换成自己那一份. 
if (!process.env.PI_CODING_AGENT_DIR) {
	process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "pi-tool-display-test-agent");
}

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
function createLoader() {
	// jiti 随 pi 一起分发
	const require = createRequire(join(PI_PACKAGE, "package.json"));
	const { createJiti } = require("jiti");
	return createJiti(pathToFileURL(join(TEST_DIR, "harness.mjs")).href, {
		alias: {
			"@earendil-works/pi-coding-agent": PI_ENTRY,
			"@earendil-works/pi-tui": PI_TUI_ENTRY,
		},
	});
}

/** 扩展自己带的源文件(入口 + 它 import 的模块); 复制到临时目录时要一并带上 */
export const EXT_FILES = ["src/index.ts", "src/config.ts", "src/panel.ts", "src/render.ts", "src/state.ts"];

/** 加载扩展的四个模块 + pi-tui(同一 jiti 实例,保证类与状态同一份). 
 *  `dir` 必须是 `copyExtensionTo()` 出来的临时副本: 从包目录"就地"加载会在真实包目录 / 真配置里留副作用. */
export async function loadModules(dir) {
	const jiti = createLoader();
	const load = (file) => jiti.import(pathToFileURL(join(dir, "src", file)).href);
	return {
		jiti,
		tui: await jiti.import(PI_TUI_ENTRY),
		piPackage: await jiti.import(PI_ENTRY),
		config: await load("config.ts"),
		panel: await load("panel.ts"),
		state: await load("state.ts"),
		render: await load("render.ts"),
		index: await load("index.ts"),
	};
}

/** 只加载 pi 自己(生命周期套件用: 那种套件要让 pi 的 loader 去发现并加载扩展,
 *  不能顺手把扩展模块也从包目录 import 进来).  */
export async function loadPiPackage() {
	const jiti = createLoader();
	return { jiti, tui: await jiti.import(PI_TUI_ENTRY), piPackage: await jiti.import(PI_ENTRY) };
}

/** 把扩展复制到隔离目录(包目录里不留任何运行产物) */
export function copyExtensionTo(targetDir, from = EXT_DIR) {
	mkdirSync(targetDir, { recursive: true });
	// 源文件按相对路径复制(保留 src/); package.json 也带上, 让 reload 用例的 pi 发现链路
	// 能读到 pi.extensions(指向 ./src/index.ts). 
	for (const file of [...EXT_FILES, "package.json"]) {
		const target = join(targetDir, file);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(from, file), target);
	}
	return targetDir;
}

/** 一次性临时目录(存在且为空); 用例结束自己清理 */
export function tempDir(name) {
	const dir = join(tmpdir(), `pi-tool-display-test-${name}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** 每个用例一份干净的 agent 目录, 并把 `PI_CODING_AGENT_DIR` 指过去: 
 *  配置只认 `~/.pi/agent/tool-display.json`, 绝不能碰用户的真配置. */
export function isolatedAgentDir(name) {
	const dir = tempDir(`${name}-agent`);
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

// ---------------------------------------------------------------- 假件

export const theme = {
	fg: (c, t) => `<${c}>${t}</>`,
	bg: (c, t) => `[${c}]${t}[/]`,
	bold: (t) => `**${t}**`,
};

export function makeContext(id, state, extra) {
	return {
		args: {},
		toolCallId: id,
		invalidate: () => {},
		state,
		cwd: "/proj",
		executionStarted: false,
		isPartial: false,
		expanded: false,
		isError: false,
		...extra,
	};
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
