/**
 * token-meter · 配置读写
 *
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LANGUAGES, type Language } from "./i18n.ts";

/**
 * 动画预设:
 * 常亮 = 两个计数常驻, 哪个数字在变哪个箭头亮, 否则灰色
 * 闪烁 = 同上, 但变化中的箭头按帧闪烁
 * 合并 = 两个计数合并为一个槽位, 只显示正在变化的那个
 */
export type AnimationMode = "steady" | "blink" | "merge";

export interface TokenMeterConfig {
	/** 过程中动画显示(false = 只在一轮结束后给出结果) */
	live: boolean;
	/** 动画预设(默认 merge) */
	animation: AnimationMode;
	/** 结算行显示 ↑ 输入 / ↓ 输出计数(两个箭头一个开关) */
	showArrows: boolean;
	/** 结算行显示缓存段(R 缓存读 / W 缓存写, 非零才显示, 一起显隐) */
	showCache: boolean;
	/** 结算行显示预估金额 */
	showCost: boolean;
	/** 结算行显示生成速度(tok/s) */
	showTps: boolean;
	/** 结算行显示本轮耗时 */
	showDuration: boolean;
	/** 动态行显示 ↑ 输入 / ↓ 输出计数(两个箭头一个开关) */
	liveShowArrows: boolean;
	/** 动态行显示缓存段(R 缓存读 / W 缓存写, 非零才显示, 一起显隐) */
	liveShowCache: boolean;
	/** 动态行显示预估金额 */
	liveShowCost: boolean;
	/** 动态行显示生成速度(tok/s) */
	liveShowTps: boolean;
	/** 动态行显示本轮耗时 */
	liveShowDuration: boolean;
	/** 结算行显示模型 */
	showModel: boolean;
	/** 结算行显示思考强度 */
	showThinking: boolean;
	/** 动态行显示模型 */
	liveShowModel: boolean;
	/** 动态行显示思考强度 */
	liveShowThinking: boolean;
	/** 结算行写入对话区(transcript), 留痕 */
	resultInTranscript: boolean;
	/** 动态刷新间隔(毫秒) */
	refreshMs: number;
	/** 界面语言: auto 跟随系统区域 */
	language: Language;
}

export const DEFAULT_CONFIG: TokenMeterConfig = {
	live: true,
	animation: "merge",
	showArrows: true,
	showCache: true,
	showCost: true,
	showTps: true,
	showDuration: true,
	liveShowArrows: true,
	liveShowCache: false,
	liveShowCost: false,
	liveShowTps: true,
	liveShowDuration: true,
	showModel: true,
	showThinking: true,
	liveShowModel: false,
	liveShowThinking: false,
	resultInTranscript: true,
	refreshMs: 120,
	language: "auto",
};

/** 本地开发/测试用的固定配置快照(不读盘).  */
export function defaultConfig(): TokenMeterConfig {
	return { ...DEFAULT_CONFIG };
}

/**
 * 包目录(源码在它的 `src/` 里, 旧位置的 config.json 也放在这一层). 
 * jiti 加载时会注入 `__dirname`, 指向源码目录(`src/`), 所以往上一级; 万一没有就按约定路径推. 
 */
function extensionDir(): string {
	try {
		if (typeof __dirname === "string" && __dirname) return join(__dirname, "..");
	} catch {
		/* 环境里没有 __dirname */
	}
	return join(getAgentDir(), "extensions", "token-meter");
}

/**
 * 配置文件只有一个位置: `~/.pi/agent/token-meter.json`. 
 *
 * 为什么不放包目录里: 包目录升级时会被整体替换, 配置写在里面就有丢的路径; 而且本地开发和实际
 * 使用本来就是同一份配置, 没必要两边兜. 要沙箱就把 `PI_CODING_AGENT_DIR` 指到临时目录. 
 */
export function configPath(): string {
	return join(getAgentDir(), "token-meter.json");
}

/** 早期位置: 扩展目录里的 `config.json`(自用阶段 / 旧版本). 只用来读一次, 读到就搬走.  */
function legacyConfigPath(): string {
	return join(extensionDir(), "config.json");
}

/** 面板页脚的路径: 用 `~` 替掉主目录前缀. Windows 下的完整长路径会折成两行, 挤掉列表空间.  */
export function shortenHomePath(path: string): string {
	try {
		const home = homedir();
		if (home && path.startsWith(home)) {
			const rest = path.slice(home.length);
			if (rest === "" || rest.startsWith("/") || rest.startsWith("\\")) return `~${rest}`;
		}
	} catch {
		/* 取不到主目录就原样显示 */
	}
	return path;
}

export const ANIMATION_MODES: AnimationMode[] = ["steady", "blink", "merge"];

const REFRESH_CHOICES = [80, 120, 200, 320, 500];

/** 把任意值收敛为合法配置 */
export function normalizeConfig(raw: unknown): TokenMeterConfig {
	const cfg: TokenMeterConfig = { ...DEFAULT_CONFIG };
	if (raw && typeof raw === "object") {
		const r = raw as Record<string, unknown>;
		if (typeof r.live === "boolean") cfg.live = r.live;
		if (typeof r.showArrows === "boolean") cfg.showArrows = r.showArrows;
		if (typeof r.showCache === "boolean") cfg.showCache = r.showCache;
		if (typeof r.liveShowArrows === "boolean") cfg.liveShowArrows = r.liveShowArrows;
		if (typeof r.liveShowCache === "boolean") cfg.liveShowCache = r.liveShowCache;
		if (typeof r.showCost === "boolean") cfg.showCost = r.showCost;
		if (typeof r.showTps === "boolean") cfg.showTps = r.showTps;
		// 兼容旧配置: 拆分前的 showCost/showTps 同时作用于两行, 未拆分键时跟随原值
		if (typeof r.liveShowCost === "boolean") cfg.liveShowCost = r.liveShowCost;
		else if (typeof r.showCost === "boolean") cfg.liveShowCost = r.showCost;
		if (typeof r.liveShowTps === "boolean") cfg.liveShowTps = r.liveShowTps;
		else if (typeof r.showTps === "boolean") cfg.liveShowTps = r.showTps;
		if (typeof r.showDuration === "boolean") cfg.showDuration = r.showDuration;
		if (typeof r.liveShowDuration === "boolean") cfg.liveShowDuration = r.liveShowDuration;
		if (typeof r.showModel === "boolean") cfg.showModel = r.showModel;
		if (typeof r.showThinking === "boolean") cfg.showThinking = r.showThinking;
		if (typeof r.liveShowModel === "boolean") cfg.liveShowModel = r.liveShowModel;
		if (typeof r.liveShowThinking === "boolean") cfg.liveShowThinking = r.liveShowThinking;
		if (typeof r.resultInTranscript === "boolean") cfg.resultInTranscript = r.resultInTranscript;
		if (typeof r.animation === "string" && (ANIMATION_MODES as string[]).includes(r.animation)) {
			cfg.animation = r.animation as AnimationMode;
		}
		if (typeof r.refreshMs === "number" && Number.isFinite(r.refreshMs)) {
			cfg.refreshMs = snapRefreshMs(r.refreshMs);
		}
		if (typeof r.language === "string" && (LANGUAGES as string[]).includes(r.language)) {
			cfg.language = r.language as Language;
		}
	}
	return cfg;
}

/** 刷新间隔吸附到常用档位 */
export function snapRefreshMs(ms: number): number {
	let best = REFRESH_CHOICES[0]!;
	let bestDist = Math.abs(ms - best);
	for (const c of REFRESH_CHOICES) {
		const d = Math.abs(ms - c);
		if (d < bestDist) {
			best = c;
			bestDist = d;
		}
	}
	return best;
}

/** 读原始 JSON(保留我们不认识的字段); 文件不存在或坏了就当空对象.  */
function readRawConfig(path: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** 改几项设置并写回配置(只动这几项, 文件里别的字段原样保留).  */
function writeConfigPatch(patch: Record<string, unknown>): void {
	const path = configPath();
	const base = readRawConfig(path);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...base, ...patch }, null, 2)}\n`, "utf-8");
}

/** 首次使用时落一份默认配置: 让用户找得到这个文件, 能手改.  */
export function ensureConfigFile(): void {
	if (existsSync(configPath())) return;
	writeConfigPatch({ ...DEFAULT_CONFIG });
}

/**
 * 读配置. 正式位置还没有、而扩展目录里有旧版 `config.json` 时, 先把那份搬过来(只搬一次), 
 * 再按同一个路径读--之后写盘只会写正式位置. 
 */
export function loadConfig(): TokenMeterConfig {
	const path = configPath();
	if (!existsSync(path)) {
		const legacy = legacyConfigPath();
		if (existsSync(legacy)) {
			try {
				const text = readFileSync(legacy, "utf-8");
				JSON.parse(text); // 坏的就别搬, 原地按"配置损坏"退回默认
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, "utf-8");
				try {
					unlinkSync(legacy);
				} catch {
					/* 删不掉就留着, 不影响使用 */
				}
			} catch {
				/* 搬不动就放弃, 下面照常读正式位置 */
			}
		}
	}
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		// 配置损坏时回退默认值, 不让插件拖垮会话
		return { ...DEFAULT_CONFIG };
	}
}

/** 写配置: 基于文件里已有的内容打补丁, 手写的其它字段不会被抹掉.  */
export function saveConfig(cfg: TokenMeterConfig): void {
	try {
		writeConfigPatch({ ...normalizeConfig(cfg) });
	} catch {
		// 只读目录等场景下静默降级: 内存内配置仍然生效
	}
}

/** 可刷新间隔档位(供设置面板展示) */
export const REFRESH_MS_CHOICES = REFRESH_CHOICES;
