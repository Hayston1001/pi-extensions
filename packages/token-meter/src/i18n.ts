/**
 * token-meter · 界面文案
 *
 * 所有用户可见字符串集中在这一张对照表里;config 的 `language` 字段
 * (`auto` | `zh` | `en`)决定用哪一套, `auto` 跟随系统区域. 新增文案两套都要写. 
 *
 */
import type { AnimationMode } from "./config.ts";

export type Language = "auto" | "zh" | "en";
/** 解析后的实际语言(auto 已展开) */
export type Lang = "zh" | "en";

export const LANGUAGES: Language[] = ["auto", "zh", "en"];

/** 系统区域判定:环境变量优先, 否则看 Node 的区域信息(zh-CN / en-US ...).  */
export function detectSystemLang(): Lang {
	let tag = "";
	try {
		tag = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE || "";
	} catch {
		// 取不到环境变量不算错误
	}
	if (!tag) {
		try {
			tag = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
		} catch {
			// 没有 ICU 时退回英文
		}
	}
	return /^zh/i.test(tag) ? "zh" : "en";
}

export function resolveLang(language: Language | undefined): Lang {
	if (language === "zh" || language === "en") return language;
	return detectSystemLang();
}

/** 设置项的 id:既是面板里的行 id,也是 config 的字段名 */
export type SettingId =
	| "live"
	| "animation"
	| "liveDisplay"
	| "resultDisplay"
	| "resultInTranscript"
	| "refreshMs"
	| "language"
	| "liveShowArrows"
	| "liveShowCache"
	| "liveShowCost"
	| "liveShowTps"
	| "liveShowDuration"
	| "liveShowModel"
	| "liveShowThinking"
	| "showArrows"
	| "showCache"
	| "showCost"
	| "showTps"
	| "showDuration"
	| "showModel"
	| "showThinking";

export interface SettingText {
	label: string;
	description: string;
}

export interface Messages {
	/** 开关取值 */
	on: string;
	off: string;
	/** 动画预设名 */
	animationLabels: Record<AnimationMode, string>;
	/** 语言自身的显示名(各语言里 中文 / English 都写原文) */
	languageLabels: Record<Language, string>;
	/** "120 毫秒" / "120 ms" */
	refreshMs: (ms: number) => string;
	/** "3/4 开" / "3/4 on" */
	displaySummary: (onCount: number, total: number) => string;
	/** 设置面板标题:英文 "Token Meter Settings" / 中文 "Token Meter 设置" */
	settingsTitle: string;
	/** 对话框里给子菜单项加的分组前缀 */
	groupShort: { live: string; result: string };
	settings: Record<SettingId, SettingText>;
	/** 逐项对话框的标题:"显示预估金额? " */
	dialogTitle: (group: string | undefined, label: string) => string;
	/** 逐项对话框的当前值后缀:"...(当前: 开)" */
	pickPrompt: (title: string, current: string) => string;
	/** 逐项对话框全部走完后的提示 */
	saved: string;
	/** 命令带了参数时的用法提示 */
	usageHint: string;
	/** 没有界面时报告的当前设置(行由面板那张设置表拼好传进来; 路径给完整路径, 这里要能直接去开文件) */
	status: (rows: string[], configPath: string) => string;
	/** 模型未知时的占位 */
	unknownModel: string;
}

const ZH: Messages = {
	on: "开",
	off: "关",
	animationLabels: { steady: "常亮", blink: "闪烁", merge: "合并" },
	languageLabels: { auto: "自动", zh: "中文", en: "English" },
	refreshMs: (ms) => `${ms} 毫秒`,
	displaySummary: (onCount, total) => `${onCount}/${total} 开`,
	settingsTitle: "Token Meter 设置",
	groupShort: { live: "动态行", result: "结算行" },
	settings: {
		live: {
			label: "动态行显示",
			description: "关 = 不显示动态行, 只在轮末给结算行",
		},
		animation: {
			label: "动画",
			description:
				"常亮 = 哪个数字在变哪个箭头亮, 否则灰色; 闪烁 = 变化中的箭头按帧闪烁; 合并 = 只显示正在变化的那一路",
		},
		liveDisplay: {
			label: "动态行显示项",
			description: "动态行的显示内容: 耗时 / 箭头 / 缓存 / 速度 / 模型 / 思考强度 / 金额(与行上从左到右一致), 回车进入",
		},
		resultDisplay: {
			label: "结算行显示项",
			description: "结算行的显示内容: 耗时 / 箭头 / 缓存 / 速度 / 模型 / 思考强度 / 金额(与行上从左到右一致), 回车进入",
		},
		resultInTranscript: {
			label: "结算行显示",
			description: "关 = 轮末不写结算行; 写入的这一行只在对话记录里, 不影响模型上下文",
		},
		refreshMs: {
			label: "刷新频率",
			description: "动态行刷新间隔, 越小越流畅, 开销略高",
		},
		language: {
			label: "Language",
			description: "界面语言: 自动 = 跟随系统区域; 改完立即用新语言重开面板",
		},
		liveShowArrows: { label: "显示箭头", description: "↑ 输入 + ↓ 输出计数(两个箭头一个开关)" },
		liveShowCache: { label: "显示缓存", description: "R 缓存读 / W 缓存写, 非零才显示" },
		liveShowCost: { label: "显示预估金额", description: "$ 金额(按模型价目表估算)" },
		liveShowTps: { label: "显示速度", description: "生成速度(tok/s)" },
		liveShowDuration: { label: "显示耗时", description: "本轮完整耗时(从发出消息到输出结束)" },
		liveShowModel: { label: "显示模型", description: "模型 ID(与 pi 模型列表一致)" },
		liveShowThinking: { label: "显示思考强度", description: "思考强度, 如 (high)" },
		showArrows: { label: "显示箭头", description: "↑ 输入 + ↓ 输出计数(两个箭头一个开关)" },
		showCache: { label: "显示缓存", description: "R 缓存读 / W 缓存写, 非零才显示" },
		showCost: { label: "显示预估金额", description: "$ 金额(按模型价目表估算)" },
		showTps: { label: "显示速度", description: "生成速度(tok/s)" },
		showDuration: { label: "显示耗时", description: "本轮完整耗时(从发出消息到输出结束)" },
		showModel: { label: "显示模型", description: "模型 ID(与 pi 模型列表一致)" },
		showThinking: { label: "显示思考强度", description: "思考强度, 如 (high)" },
	},
	dialogTitle: (group, label) => (group ? `${group}: ${label}? ` : `${label}? `),
	pickPrompt: (title, current) => `${title}(当前: ${current})`,
	saved: "token-meter 设置已保存",
	usageHint: "不接受参数: 直接 /token-meter-settings 打开设置面板",
	status: (rows, configPath) => ["token-meter 当前设置:", ...rows, `配置文件: ${configPath}`].join("\n"),
	unknownModel: "未知模型",
};

const EN: Messages = {
	on: "on",
	off: "off",
	animationLabels: { steady: "Steady", blink: "Blink", merge: "Merge" },
	languageLabels: { auto: "Auto", zh: "中文", en: "English" },
	refreshMs: (ms) => `${ms} ms`,
	displaySummary: (onCount, total) => `${onCount}/${total} on`,
	settingsTitle: "Token Meter Settings",
	groupShort: { live: "Live line", result: "Result line" },
	settings: {
		live: {
			label: "Live line",
			description: "off = no live line; only the result line when the round ends",
		},
		animation: {
			label: "Animation",
			description:
				"Steady = the arrow of the counter that is growing lights up, otherwise grey; Blink = the growing arrow blinks per frame; Merge = a single slot showing only the side that is changing",
		},
		liveDisplay: {
			label: "Live line fields",
			description: "What the live line shows: duration / arrows / cache / speed / model / thinking / cost (the order on the line). Enter to open",
		},
		resultDisplay: {
			label: "Result line fields",
			description: "What the end-of-round line shows: duration / arrows / cache / speed / model / thinking / cost (the order on the line). Enter to open",
		},
		resultInTranscript: {
			label: "Result line",
			description: "off = nothing is written when a round ends; the line stays in the transcript and is never sent to the model",
		},
		refreshMs: {
			label: "Refresh interval",
			description: "How often the live line repaints; smaller is smoother and slightly costlier",
		},
		language: {
			label: "Language",
			description: "UI language. Auto = follow the system locale; changing it reopens the panel in the new language",
		},
		liveShowArrows: { label: "Arrows", description: "↑ input + ↓ output counters (both arrows on one switch)" },
		liveShowCache: { label: "Cache", description: "R cache read / W cache write, each shown only when non-zero" },
		liveShowCost: { label: "Estimated cost", description: "$ amount estimated from the model price list" },
		liveShowTps: { label: "Speed", description: "Generation speed (tok/s)" },
		liveShowDuration: { label: "Duration", description: "Full round duration, from submitting the message to the end of output" },
		liveShowModel: { label: "Model", description: "Model ID (same as pi's model list)" },
		liveShowThinking: { label: "Thinking level", description: "Thinking level, e.g. (high)" },
		showArrows: { label: "Arrows", description: "↑ input + ↓ output counters (both arrows on one switch)" },
		showCache: { label: "Cache", description: "R cache read / W cache write, each shown only when non-zero" },
		showCost: { label: "Estimated cost", description: "$ amount estimated from the model price list" },
		showTps: { label: "Speed", description: "Generation speed (tok/s)" },
		showDuration: { label: "Duration", description: "Full round duration, from submitting the message to the end of output" },
		showModel: { label: "Model", description: "Model ID (same as pi's model list)" },
		showThinking: { label: "Thinking level", description: "Thinking level, e.g. (high)" },
	},
	dialogTitle: (group, label) => (group ? `${group}: ${label}?` : `${label}?`),
	pickPrompt: (title, current) => `${title} (current: ${current})`,
	saved: "token-meter settings saved",
	usageHint: "No arguments: run /token-meter-settings to open the settings panel",
	status: (rows, configPath) => ["token-meter settings:", ...rows, `Config file: ${configPath}`].join("\n"),
	unknownModel: "unknown model",
};

export const MESSAGES: Record<Lang, Messages> = { zh: ZH, en: EN };

/** 按配置里的 language 取文案(auto 跟随系统).  */
export function messages(language: Language | undefined): Messages {
	return MESSAGES[resolveLang(language)];
}
