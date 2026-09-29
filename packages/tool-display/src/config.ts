/**
 * tool-display 的配置文件读写. 
 *
 * 配置只有一个位置: `~/.pi/agent/tool-display.json`(包目录升级时会被整体替换, 所以不放包里). 
 * 包目录里早期那份 `config.json` 只当旧位置读一次, 读到就搬到新位置并删掉旧文件. 
 * 缺文件 / 坏 JSON / 缺字段都退回默认值, 不影响渲染;设置命令修改后写回(2 空格 + patch, 保留手写的其它字段). 
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Tier = "mini" | "low" | "medium" | "default";

/** mini / low 整批显示时每条调用的形态: "medium" = 原版调用行 + 摘要(不显示输出); "default" = 原版折叠态(带输出, 受原版行数上限限制). 点单条在形态与原版全量之间翻. */
export type ExpandStyle = "medium" | "default";

export const EXPAND_STYLES: readonly ExpandStyle[] = ["medium", "default"];

export interface ToolDisplayConfig {
	/** 展示档位 */
	display: Tier;
	/** hover 提亮(仅 fullscreen TUI 有效) */
	hoverHighlight: boolean;
	/** mini / low 整批显示时每条调用的初始形态 */
	expandStyle: ExpandStyle;
	low: {
		/** 折叠行最多列出几个工具名, 其余收成 +N */
		nameLimit: number;
	};
	medium: {
		/** 失败时额外给一行错误摘要 */
		showErrorLine: boolean;
	};
}

export const TIERS: readonly Tier[] = ["mini", "low", "medium", "default"];

const DEFAULTS: ToolDisplayConfig = {
	display: "mini",
	hoverHighlight: true,
	expandStyle: "medium",
	low: { nameLimit: 3 },
	medium: { showErrorLine: true },
};

function isTier(value: unknown): value is Tier {
	return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function isExpandStyle(value: unknown): value is ExpandStyle {
	return typeof value === "string" && (EXPAND_STYLES as readonly string[]).includes(value);
}

function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function intOr(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	const rounded = Math.floor(value);
	if (rounded < min || rounded > max) {
		return fallback;
	}
	return rounded;
}

/** 配置只有这一个位置; 读写都走它 */
export function configPath(): string {
	return join(getAgentDir(), "tool-display.json");
}

/**
 * 面板页脚展示用: 把用户主目录前缀缩成 `~`.
 * 一是好认, 二是 Windows 下配置路径很长, 不缩会折成两行挤掉列表空间.
 * 无 UI 状态提示不用它, 那里给完整路径, 方便直接复制去开文件.
 */
export function shortenHomePath(path: string): string {
	try {
		const home = homedir();
		if (home && path.startsWith(home)) {
			const rest = path.slice(home.length);
			if (rest === "" || rest.startsWith("/") || rest.startsWith("\\")) return `~${rest}`;
		}
	} catch {
		// 取不到主目就原样显示
	}
	return path;
}

/**
 * 早期位置: 包目录里的 `config.json`(本地开发 / 旧版本). 只用来读一次, 读到就搬走. 
 * 源码在 `src/` 下, `import.meta.url` 指到那里, 所以往上一级才是包目录. 
 */
function legacyConfigPath(): string {
	try {
		return join(dirname(fileURLToPath(import.meta.url)), "..", "config.json");
	} catch {
		return "";
	}
}

/** 读文件里的原始对象(写盘时靠它保留未知字段); 文件不存在 / 坏 JSON / 不是对象都当空对象.  */
function readRawConfig(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * 旧位置(扩展目录里的 `config.json`)的配置搬过来, 只搬一次. 
 * 返回实际要读的路径: 搬成功 / 没有旧文件都是 `configPath()`; 旧 JSON 本身坏了就留在原地按读失败处理. 
 */
function resolveConfigPath(): string {
	const path = configPath();
	if (existsSync(path)) return path;
	const legacy = legacyConfigPath();
	if (!legacy || !existsSync(legacy)) return path;
	try {
		const text = readFileSync(legacy, "utf8");
		JSON.parse(text);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
		try {
			unlinkSync(legacy);
		} catch {
			/* 删不掉就留着, 不影响使用 */
		}
		return path;
	} catch {
		return legacy;
	}
}

/** 首次使用时落一份默认配置: 让用户找得到这个文件, 能手改.  */
export function ensureConfigFile(): void {
	if (existsSync(configPath())) return;
	saveConfig(defaultConfig());
}

/** 读配置;任何异常都退回默认值.  */
export function loadConfig(): ToolDisplayConfig {
	const path = resolveConfigPath();
	const obj = path && existsSync(path) ? readRawConfig(path) : {};
	const low = (obj.low !== null && typeof obj.low === "object" ? obj.low : {}) as Record<string, unknown>;
	const medium = (obj.medium !== null && typeof obj.medium === "object" ? obj.medium : {}) as Record<string, unknown>;
	return {
		display: isTier(obj.display) ? obj.display : DEFAULTS.display,
		hoverHighlight: boolOr(obj.hoverHighlight, DEFAULTS.hoverHighlight),
		expandStyle: isExpandStyle(obj.expandStyle) ? obj.expandStyle : DEFAULTS.expandStyle,
		low: {
			nameLimit: intOr(low.nameLimit, DEFAULTS.low.nameLimit, 1, 20),
		},
		medium: {
			showErrorLine: boolOr(medium.showErrorLine, DEFAULTS.medium.showErrorLine),
		},
	};
}

/**
 * 写配置: 2 空格缩进 + 末尾换行, 并且是 patch--只覆盖我们认识的字段, 
 * 文件里手写的其它字段(含 low/medium 里的)原样保留; 写失败静默(配置只影响显示). 
 */
export function saveConfig(config: ToolDisplayConfig): void {
	try {
		const path = configPath();
		mkdirSync(dirname(path), { recursive: true });
		const base = readRawConfig(path);
		const low = (base.low !== null && typeof base.low === "object" ? base.low : {}) as Record<string, unknown>;
		const medium = (base.medium !== null && typeof base.medium === "object" ? base.medium : {}) as Record<string, unknown>;
		const next = {
			...base,
			display: config.display,
			hoverHighlight: config.hoverHighlight,
			expandStyle: config.expandStyle,
			low: { ...low, nameLimit: config.low.nameLimit },
			medium: { ...medium, showErrorLine: config.medium.showErrorLine },
		};
		writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	} catch {
		// ignore
	}
}

export function defaultConfig(): ToolDisplayConfig {
	return JSON.parse(JSON.stringify(DEFAULTS)) as ToolDisplayConfig;
}

/**
 * 调试日志: 始终追加写入 `~/.pi/agent/tool-display.log`(体积自动封顶, 与配置同目录), 
 * 方便排查时直接看文件; 设了 MT_DEBUG=1 时同时打到 stderr. 
 */
export function debugLog(...args: unknown[]): void {
	if (process.env.MT_DEBUG) {
		console.error("[tool-display]", ...args);
	}
	try {
		const file = join(getAgentDir(), "tool-display.log");
		try {
			if (statSync(file).size > 128 * 1024) {
				writeFileSync(file, readFileSync(file, "utf8").slice(-32 * 1024), "utf8");
			}
		} catch {
			// 文件还不存在,直接追加即可
		}
		const parts = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a)));
		appendFileSync(file, `${new Date().toISOString()} ${parts.join(" ")}\n`, "utf8");
	} catch {
		// 日志失败不影响功能
	}
}

const SHARED_KEY = "__toolDisplaySharedConfig";

/**
 * 跨扩展重载共享同一个配置对象. /reload 会重建扩展模块, 若各代模块各持一份
 * 配置, 旧渲染器闭包就看不到新命令的修改(表现为"切档无效"). 这里把配置挂在
 * 进程全局上, 任何一代模块都读写同一份; 刷新时原地改字段, 保持引用不变. 
 */
export function getSharedConfig(): ToolDisplayConfig {
	const global = globalThis as Record<string, unknown>;
	const existing = global[SHARED_KEY] as ToolDisplayConfig | undefined;
	const loaded = loadConfig();
	if (!existing) {
		global[SHARED_KEY] = loaded;
		return loaded;
	}
	existing.display = loaded.display;
	existing.hoverHighlight = loaded.hoverHighlight;
	existing.expandStyle = loaded.expandStyle;
	existing.low.nameLimit = loaded.low.nameLimit;
	existing.medium.showErrorLine = loaded.medium.showErrorLine;
	return existing;
}
