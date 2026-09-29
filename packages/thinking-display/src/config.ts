/**
 * thinking-display 的配置文件读写. 
 *
 * 配置只有一个位置: `~/.pi/agent/thinking-display.json`(包目录升级时会被整体替换, 所以不放包里). 
 * 包目录里早期那份 `config.json` 只当旧位置读一次, 读到就搬到新位置并删掉旧文件. 
 * 缺文件 / 坏 JSON / 字段类型不对都退回默认值, 不影响渲染; 设置面板改完写回. 
 * 写回是 patch: 只覆盖认识的字段, 文件里我们自己不认识的字段原样带着. 
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ThinkingDisplayConfig {
	/** 流式生成时只保留"正在写的"那段 thinking 展开(关掉=完全原版行为) */
	streaming: boolean;
	/** thinking 块的折叠标记 +/- 与 hover 高亮(关掉=原样渲染) */
	decorate: boolean;
}

export const DEFAULT_CONFIG: ThinkingDisplayConfig = {
	streaming: true,
	decorate: true,
};

/** 默认配置的副本(测试与渲染断言用固定快照, 不读"活的"配置文件).  */
export function defaultConfig(): ThinkingDisplayConfig {
	return { ...DEFAULT_CONFIG };
}

/** 配置只有这一个位置; 读写都走它 */
export function configPath(): string {
	return join(getAgentDir(), "thinking-display.json");
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

function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * 面板页脚展示用: 把用户主目录前缀缩成 `~`. 
 * 一是好认, 二是 Windows 下配置路径很长, 不缩会折成两行挤掉列表空间. 
 * 诊断输出(statusLines)不用它, 那里要能直接复制去开文件. 
 */
export function shortenHomePath(path: string): string {
	try {
		const home = homedir();
		if (home && path.startsWith(home)) {
			const rest = path.slice(home.length);
			if (rest === "" || rest.startsWith("/") || rest.startsWith("\\")) return `~${rest}`;
		}
	} catch {
		// 取不到主目录就原样显示
	}
	return path;
}

/**
 * 读文件里的原始对象. 我们不认识的字段要原样带着(写回时只用 patch 覆盖认识的字段,
 * 用户手写的别的字段不能被抹掉); 文件不存在 / 坏 JSON / 不是对象都当空对象. 
 */
function readRawConfig(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		// 坏 JSON / 读不动: 当空对象, 不让配置问题影响渲染
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

/** 读配置; 缺字段 / 类型不对 / 任何异常都退回默认值.  */
export function loadConfig(): ThinkingDisplayConfig {
	const obj = readRawConfig(resolveConfigPath());
	return {
		streaming: boolOr(obj.streaming, DEFAULT_CONFIG.streaming),
		decorate: boolOr(obj.decorate, DEFAULT_CONFIG.decorate),
	};
}

/** 写回"当前在用的那份"配置; 目录不存在就建. 保留文件里的其它字段(patch).  */
export function saveConfig(config: ThinkingDisplayConfig): void {
	const path = configPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		const base = readRawConfig(path);
		const next = { ...base, streaming: config.streaming, decorate: config.decorate };
		writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	} catch {
		// 写不动盘不该影响渲染;面板里的通知已经反映内存态
	}
}
