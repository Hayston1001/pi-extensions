/*
 * timeline · 界面文案(zh / en)
 *
 * 所有用户可见字符串集中在这一张表里; 配置的 `language` 字段(`auto` | `zh` | `en`)决定用哪一套, 
 * `auto` 跟随系统区域. 新增文案两套都要写. 
 */

/* 配置文件名: configPath() 和文案里的提示共用这一个名字 */
export const CONFIG_FILE_NAME = "timeline.json";

export type Language = "auto" | "zh" | "en";
/** 解析后的实际语言(auto 已展开) */
export type Lang = "zh" | "en";

export const LANGUAGES: Language[] = ["auto", "zh", "en"];

/** 系统区域判定: 环境变量优先, 否则看 Node 的区域信息(zh-CN / en-US ...).  */
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

/** 设置项的 id: 既是面板里的行 id, 也是配置的字段名 */
export type SettingId = "jumpTo" | "shortcut" | "language";

/** 落脚点: 跳到消息本身, 还是跳到下面的正文(助手的回答) */
export type JumpTo = "user" | "reply";
export const JUMP_TO_VALUES: JumpTo[] = ["user", "reply"];

export interface SettingText {
	label: string;
	description: string;
}

export interface Messages {
	/** 快捷键在命令面板里的 description(`/timeline-settings` 的命令描述是固定英文, 不走这张表) */
	shortcutDescription: string;

	// —— 消息列表 ——
	pickerCount: (count: number) => string;
	pickerMode: (mode: string) => string;
	pickerUnlocatable: (count: number) => string;
	pickerFilter: string;
	pickerNoMatch: string;
	pickerHint: string;
	currentTag: string;
	unlocatableTag: string;
	emptyMessage: string;

	// —— 拿不到视口时的说明面板 ——
	noticeNoViewportTitle: string;
	noticeNoViewportBody: string;
	noticeFullscreenTitle: string;
	noticeFullscreenBody1: string;
	noticeFullscreenBody2: string;
	noticeFullscreenHint: string;
	noticeCloseHint: string;

	// —— 通知 ——
	notifyTuiOnly: string;
	notifyNoMessages: string;
	notifyInserted: string;
	notifyNotLocatable: string;
	notifyBadShortcut: (key: string, problem: string) => string;
	notifyShortcutChanged: (key: string) => string;
	notifySavedWithShortcut: string;
	notifySaved: string;
	/** 没有界面时打印的当前设置 */
	status: (jumpTo: string, shortcut: string, language: string) => string;

	// —— 配置告警 ——
	configParseError: (message: string, path: string) => string;
	configBadJumpTo: (value: string, path: string) => string;
	configBadShortcutType: (path: string) => string;
	configBadShortcut: (entry: string, problem: string, path: string) => string;
	configNoShortcut: (keys: string) => string;

	// —— 快捷键校验 ——
	validateMissingKey: string;
	validateBadModifier: (part: string) => string;
	validatePlainKey: string;
	validateBadKey: (base: string) => string;

	// —— 设置面板 ——
	settingsTitle: string;
	settings: Record<SettingId, SettingText>;
	jumpToLabels: Record<JumpTo, string>;
	languageLabels: Record<Language, string>;
	shortcutOffValue: string;
	customShortcutChoice: string;
	shortcutOffChoice: string;
	customShortcutTitle: string;
	customShortcutPlaceholder: string;

	// —— 降级对话框 ——
	dialogTitle: (label: string) => string;
	pickPrompt: (title: string, current: string) => string;
}

const ZH: Messages = {
	shortcutDescription: "Timeline: 跳到某条用户消息",

	pickerCount: (count) => `· 消息 ${count} 条`,
	pickerMode: (mode) => `· 模式: ${mode}`,
	pickerUnlocatable: (count) => `(${count} 条无法定位)`,
	pickerFilter: "过滤消息内容...",
	pickerNoMatch: "  没有匹配的消息",
	pickerHint: "↑↓ 选择 · Enter 跳转 · Ctrl+Enter 放入输入框 · Esc 关闭",
	currentTag: "当前",
	unlocatableTag: "不可定位",
	emptyMessage: "(空白消息)",

	noticeNoViewportTitle: "找不到 transcript 视口",
	noticeNoViewportBody:
		"全屏模式下也没拿到可滚动的 transcript. 这通常意味着 Pi 的内部结构变了(版本升级), 插件需要跟着改. ",
	noticeFullscreenTitle: "timeline 需要全屏模式",
	noticeFullscreenBody1: "普通模式下的 transcript 由终端自己管理, 插件无法定位到其中某一行. ",
	noticeFullscreenBody2: "开启全屏后 transcript 归 Pi 管, 才能按行滚过去. ",
	noticeFullscreenHint: "/settings → tui-mode → fullscreen 后重试　·　按任意键关闭",
	noticeCloseHint: "按任意键关闭",

	notifyTuiOnly: "timeline: 仅交互模式可用",
	notifyNoMessages: "timeline: 这个会话还没有可跳转的消息",
	notifyInserted: "timeline: 消息内容已放进输入框",
	notifyNotLocatable: "timeline: 这条消息在当前视图里定位不到(可能已被压缩, 或渲染中没有对应内容)",
	notifyBadShortcut: (key, problem) => `timeline: 快捷键「${key}」用不了: ${problem}`,
	notifyShortcutChanged: (key) => `timeline: 快捷键已改成 ${key}, /reload 后生效`,
	notifySavedWithShortcut: "timeline: 设置已保存(jumpTo 立即生效; 快捷键需要 /reload)",
	notifySaved: "timeline: 设置已保存, 立即生效",
	status: (jumpTo, shortcut, language) =>
		`timeline 当前设置:\n落脚点: ${jumpTo}\n快捷键: ${shortcut}\n语言: ${language}`,

	configParseError: (message, path) => `${CONFIG_FILE_NAME} 解析失败: ${message}(${path})`,
	configBadJumpTo: (value, path) =>
		`${CONFIG_FILE_NAME} 里的 "jumpTo" 只认 "user"(跳到消息)或 "reply"(跳到下方正文), 现在写的是 ${value}, 先按 "user" 处理(${path})`,
	configBadShortcutType: (path) => `${CONFIG_FILE_NAME} 里的 "shortcut" 只能是字符串或字符串数组(${path})`,
	configBadShortcut: (entry, problem, path) => `快捷键「${entry}」用不了: ${problem}(${path})`,
	configNoShortcut: (keys) => `没有可用的快捷键, 先退回默认的 ${keys}`,

	validateMissingKey: "缺少按键(例如 ctrl+shift+g)",
	validateBadModifier: (part) => `认不出的修饰键「${part}」`,
	validatePlainKey: "不带修饰键的普通按键会把正常输入也吃掉, 请至少加上 ctrl / alt / shift / super",
	validateBadKey: (base) => `认不出的按键「${base}」`,

	settingsTitle: "Timeline 设置",
	settings: {
		jumpTo: {
			label: "落脚点",
			description:
				"跳过去时落在哪一块: 「消息本身」是那条用户消息; 「下方正文」是这一轮的真正回答. 纯文本回复落块的第一行(和 pi 原生 Ctrl+↑/↓ 一致), 带思考的回复跳过思考落正文. 回车切换. ",
		},
		shortcut: {
			label: "快捷键",
			description:
				"打开消息列表的快捷键; 需要 /reload 才会重新注册. 回车进入候选列表, 选「自定义...」可以直接输一个键. ",
		},
		language: {
			label: "Language",
			description: "界面语言: 自动 = 跟随系统区域. 改完面板会立即以新语言重开; 快捷键的说明文字需 /reload. ",
		},
	},
	jumpToLabels: { user: "消息本身(user)", reply: "下方正文(reply)" },
	languageLabels: { auto: "自动", zh: "中文", en: "English" },
	shortcutOffValue: "关闭",
	customShortcutChoice: "自定义...",
	shortcutOffChoice: "关闭快捷键",
	customShortcutTitle: "快捷键",
	customShortcutPlaceholder: "例如 alt+t / f8(不带修饰键的普通键不行)",

	dialogTitle: (label) => `${label}? `,
	pickPrompt: (title, current) => `${title}(当前: ${current})`,
};

const EN: Messages = {
	shortcutDescription: "Timeline: jump to a user message",

	pickerCount: (count) => `· ${count} messages`,
	pickerMode: (mode) => `· Mode: ${mode}`,
	pickerUnlocatable: (count) => ` (${count} unlocatable)`,
	pickerFilter: "Filter messages...",
	pickerNoMatch: "  No matching messages",
	pickerHint: "↑↓ Navigate · Enter jump · Ctrl+Enter insert into editor · Esc close",
	currentTag: "current",
	unlocatableTag: "unlocatable",
	emptyMessage: "(empty message)",

	noticeNoViewportTitle: "Transcript viewport not found",
	noticeNoViewportBody:
		"No scrollable transcript even in fullscreen mode. Pi's internals probably changed (version upgrade) and this extension needs an update.",
	noticeFullscreenTitle: "timeline needs fullscreen mode",
	noticeFullscreenBody1:
		"In regular mode the transcript is managed by the terminal itself, so the extension cannot jump to a specific line.",
	noticeFullscreenBody2: "Fullscreen mode hands the transcript to Pi, which makes line-precise scrolling possible.",
	noticeFullscreenHint: "/settings → tui-mode → fullscreen, then retry · Press any key to close",
	noticeCloseHint: "Press any key to close",

	notifyTuiOnly: "timeline: only available in the interactive TUI",
	notifyNoMessages: "timeline: no messages to jump to in this session",
	notifyInserted: "timeline: message text inserted into the editor",
	notifyNotLocatable:
		"timeline: cannot locate this message in the current view (it may have been compacted away)",
	notifyBadShortcut: (key, problem) => `timeline: shortcut "${key}" does not work: ${problem}`,
	notifyShortcutChanged: (key) => `timeline: shortcut changed to ${key}; run /reload to apply`,
	notifySavedWithShortcut: "timeline: settings saved (jump target applies immediately; the shortcut needs /reload)",
	notifySaved: "timeline: settings saved and applied immediately",
	status: (jumpTo, shortcut, language) =>
		`timeline settings:\nJump target: ${jumpTo}\nShortcut: ${shortcut}\nLanguage: ${language}`,

	configParseError: (message, path) => `${CONFIG_FILE_NAME} failed to parse: ${message} (${path})`,
	configBadJumpTo: (value, path) =>
		`"jumpTo" in ${CONFIG_FILE_NAME} only accepts "user" (the message) or "reply" (the answer below), got ${value}; using "user" (${path})`,
	configBadShortcutType: (path) => `"shortcut" in ${CONFIG_FILE_NAME} must be a string or an array of strings (${path})`,
	configBadShortcut: (entry, problem, path) => `shortcut "${entry}" does not work: ${problem} (${path})`,
	configNoShortcut: (keys) => `no usable shortcut; falling back to the default ${keys}`,

	validateMissingKey: "missing key (e.g. ctrl+shift+g)",
	validateBadModifier: (part) => `unknown modifier "${part}"`,
	validatePlainKey: "a plain key would swallow normal typing; add at least ctrl / alt / shift / super",
	validateBadKey: (base) => `unknown key "${base}"`,

	settingsTitle: "Timeline Settings",
	settings: {
		jumpTo: {
			label: "Jump target",
			description:
				"Which block the jump lands on: 'the user message' is the message itself, 'the reply below' is this turn's real answer. Plain-text replies land on the block's first line (same as pi's native Ctrl+up/down); replies with thinking skip the thinking and land on the answer text. Enter to switch.",
		},
		shortcut: {
			label: "Shortcut",
			description:
				"Shortcut that opens the message list; it needs /reload to re-register. Enter for the candidate list; pick 'Custom...' to type a key.",
		},
		language: {
			label: "Language",
			description:
				"UI language: Auto = follow the system locale. The panel reopens immediately in the new language; the shortcut's help text needs /reload.",
		},
	},
	jumpToLabels: { user: "the user message (user)", reply: "the reply below (reply)" },
	languageLabels: { auto: "Auto", zh: "中文", en: "English" },
	shortcutOffValue: "off",
	customShortcutChoice: "Custom...",
	shortcutOffChoice: "Disable shortcut",
	customShortcutTitle: "Shortcut",
	customShortcutPlaceholder: "e.g. alt+t / f8 (plain keys without a modifier are rejected)",

	dialogTitle: (label) => `${label}?`,
	pickPrompt: (title, current) => `${title} (current: ${current})`,
};

export const MESSAGES: Record<Lang, Messages> = { zh: ZH, en: EN };

/** 按配置里的 language 取文案(auto 跟随系统).  */
export function messages(language: Language | undefined): Messages {
	return MESSAGES[resolveLang(language)];
}
