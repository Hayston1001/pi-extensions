/**
 * token-meter · 可视化设置面板
 *
 * `/token-meter-settings` 唤起. 样式与 pi 原生 /settings 一致
 * 文案全部走 i18n.ts(按 config.language 解析). 面板里的「语言」改完立即用新语言重开面板
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component, SelectListTheme, SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import { Container, SelectList, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import type { AnimationMode, TokenMeterConfig } from "./config.ts";
import { ANIMATION_MODES, REFRESH_MS_CHOICES, configPath, saveConfig, shortenHomePath, snapRefreshMs } from "./config.ts";
import { LANGUAGES, messages, type Language, type Messages, type SettingId } from "./i18n.ts";

/** 动态行 / 结算行两组的显示项 */
type Line = "live" | "result";

const LINE_IDS: Record<Line, SettingId[]> = {
	live: ["liveShowArrows", "liveShowCache", "liveShowCost", "liveShowTps", "liveShowDuration", "liveShowModel", "liveShowThinking"],
	result: ["showArrows", "showCache", "showCost", "showTps", "showDuration", "showModel", "showThinking"],
};

interface SettingDef {
	id: SettingId;
	/** 有 values = 本行回车直接切换; 没有 = 回车进入子菜单 */
	values?: (m: Messages) => string[];
	/** 子菜单的候选显示文案(回车进子菜单, 选中后按同一张 Messages 反查配置值) */
	choices?: (m: Messages) => string[];
	/** 当前值(显示文案) */
	current: (cfg: TokenMeterConfig, m: Messages) => string;
}

/**
 * 一级菜单的设置项. 面板与降级对话框共用这一张表,
 * 新增设置只改这里 + i18n 的 settings 表.
 */
const MENU: SettingDef[] = [
	{
		id: "animation",
		values: (m) => ANIMATION_MODES.map((mode) => m.animationLabels[mode]),
		current: (cfg, m) => m.animationLabels[cfg.animation],
	},
	{ id: "live", values: (m) => [m.on, m.off], current: (cfg, m) => boolLabel(cfg.live, m) },
	{ id: "liveDisplay", current: (cfg, m) => m.displaySummary(countOn(cfg, "live"), LINE_IDS.live.length) },
	{ id: "resultInTranscript", values: (m) => [m.on, m.off], current: (cfg, m) => boolLabel(cfg.resultInTranscript, m) },
	{ id: "resultDisplay", current: (cfg, m) => m.displaySummary(countOn(cfg, "result"), LINE_IDS.result.length) },
	{
		id: "refreshMs",
		values: (m) => REFRESH_MS_CHOICES.map((ms) => m.refreshMs(ms)),
		current: (cfg, m) => m.refreshMs(cfg.refreshMs),
	},
	{ id: "language", choices: (m) => LANGUAGES.map((lang) => m.languageLabels[lang]), current: (cfg, m) => m.languageLabels[cfg.language] },
];

function boolLabel(value: boolean, m: Messages): string {
	return value ? m.on : m.off;
}

function boolOf(cfg: TokenMeterConfig, id: SettingId): boolean {
	return (cfg as unknown as Record<string, unknown>)[id] === true;
}

function countOn(cfg: TokenMeterConfig, line: Line): number {
	return LINE_IDS[line].filter((id) => boolOf(cfg, id)).length;
}

/** 子菜单项属于哪一组(一级菜单里只有这两项是子菜单) */
function groupOf(id: SettingId): Line {
	return id === "liveDisplay" ? "live" : "result";
}

function labelToBool(value: string, m: Messages): boolean {
	return value === m.on;
}

function labelToAnimation(value: string, m: Messages): AnimationMode {
	return ANIMATION_MODES.find((mode) => m.animationLabels[mode] === value) ?? "steady";
}

function labelToLanguage(value: string, m: Messages): Language {
	return LANGUAGES.find((lang) => m.languageLabels[lang] === value) ?? "auto";
}

/**
 * 原生设置列表主题(与 /settings 的 getSettingsListTheme 同样式).
 * 用传入的 theme 实例着色: 扩展经 jiti 加载时全局主题可能未初始化,
 * 不能直接用 pi 的全局主题工厂.
 */
function makeNativeListTheme(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => theme.fg("dim", text),
	};
}

/**
 * 候选子菜单用的 SelectList 主题, 同样从传入的 theme 派生. 
 * 逐字段照抄 pi 原生的 `getSelectListTheme()`: scrollInfo / noMatch 是 muted(不是 dim). 
 */
function makeSelectTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
	};
}

/** 面板顶部的标题行: 进子菜单时换成那一项的行标签, 退出换回面板名 */
interface PanelChrome {
	show(label?: string): void;
}

/**
 * 子菜单的壳: 上下各空一行(一级那里是"搜索行 + 空行", 子菜单没有搜索行). 
 * 输入/鼠标转给内层 -- 自己拼字符串加空行会把鼠标命中行号错开. 
 */
function wrapSubmenu(inner: Component): Component {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(inner);
	container.addChild(new Spacer(1));
	return {
		render: (width: number) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => inner.handleInput(data),
		handleMouse: (event: any) => container.handleMouse(event),
	};
}

/**
 * 候选子菜单(语言这种"从几项里选一个"的设置): 光标预选在当前值那项上, 
 * 标题换成该项的行标签(退出换回). 
 */
function chooseFrom(
	labels: string[],
	current: string,
	theme: Theme,
	rowLabel: string,
	chrome: PanelChrome,
	done: (label?: string) => void,
): Component {
	const items = labels.map((label) => ({ value: label, label }));
	const list = new SelectList(items, Math.min(items.length, 10), makeSelectTheme(theme));
	const selected = items.findIndex((item) => item.label === current);
	if (selected > 0) list.setSelectedIndex(selected);
	chrome.show(rowLabel); // 进来: 标题换成这一项
	const finish = (label?: string) => {
		chrome.show(); // 离开: 换回面板名(选完 / Esc 都走这个出口)
		done(label);
	};
	list.onSelect = (item) => finish(item.label);
	list.onCancel = () => finish();
	return wrapSubmenu(list);
}

/**
 * 应用一项设置并落盘.
 * @param newValue 显示文案(由同一张 Messages 反查成配置值, 因此不受语言切换影响)
 */
export function applySetting(cfg: TokenMeterConfig, id: SettingId, newValue: string, m: Messages): void {
	switch (id) {
		case "live":
			cfg.live = labelToBool(newValue, m);
			break;
		case "animation":
			cfg.animation = labelToAnimation(newValue, m);
			break;
		case "language":
			cfg.language = labelToLanguage(newValue, m);
			break;
		case "resultInTranscript":
			cfg.resultInTranscript = labelToBool(newValue, m);
			break;
		case "refreshMs":
			cfg.refreshMs = snapRefreshMs(parseInt(newValue, 10) || cfg.refreshMs);
			break;
		case "liveShowArrows":
			cfg.liveShowArrows = labelToBool(newValue, m);
			break;
		case "liveShowCache":
			cfg.liveShowCache = labelToBool(newValue, m);
			break;
		case "liveShowCost":
			cfg.liveShowCost = labelToBool(newValue, m);
			break;
		case "liveShowTps":
			cfg.liveShowTps = labelToBool(newValue, m);
			break;
		case "liveShowDuration":
			cfg.liveShowDuration = labelToBool(newValue, m);
			break;
		case "liveShowModel":
			cfg.liveShowModel = labelToBool(newValue, m);
			break;
		case "liveShowThinking":
			cfg.liveShowThinking = labelToBool(newValue, m);
			break;
		case "showArrows":
			cfg.showArrows = labelToBool(newValue, m);
			break;
		case "showCache":
			cfg.showCache = labelToBool(newValue, m);
			break;
		case "showCost":
			cfg.showCost = labelToBool(newValue, m);
			break;
		case "showTps":
			cfg.showTps = labelToBool(newValue, m);
			break;
		case "showDuration":
			cfg.showDuration = labelToBool(newValue, m);
			break;
		case "showModel":
			cfg.showModel = labelToBool(newValue, m);
			break;
		case "showThinking":
			cfg.showThinking = labelToBool(newValue, m);
			break;
	}
	saveConfig(cfg);
}

interface PanelDeps {
	/** 父级列表(子菜单内改动后刷新一级项的摘要值) */
	getList: () => SettingsList | undefined;
	onApplied: () => void;
}

/** 一行显示项的子菜单: 箭头 / 缓存 / 预估金额 / 速度 / 耗时 / 模型 / 思考强度, 七项互相独立 */
function buildLineSubmenu(
	cfg: TokenMeterConfig,
	m: Messages,
	theme: Theme,
	deps: PanelDeps,
	line: Line,
	rowId: SettingId,
	chrome: PanelChrome,
	done: (selectedValue?: string) => void,
): Component {
	const items: SettingItem[] = LINE_IDS[line].map((id) => ({
		id,
		label: m.settings[id].label,
		description: m.settings[id].description,
		currentValue: boolLabel(boolOf(cfg, id), m),
		values: [m.on, m.off],
	}));
	const finish = (selectedValue?: string) => {
		chrome.show(); // 离开: 换回面板名
		done(selectedValue);
	};
	const list = new SettingsList(
		items,
		items.length,
		makeNativeListTheme(theme),
		(id, newValue) => {
			applySetting(cfg, id as SettingId, newValue, m);
			deps.onApplied();
			deps.getList()?.updateValue(rowId, m.displaySummary(countOn(cfg, line), LINE_IDS[line].length));
		},
		() => finish(),
	);
	chrome.show(m.settings[rowId].label); // 进来: 标题换成这一项
	return wrapSubmenu(list);
}

function buildItems(cfg: TokenMeterConfig, m: Messages, theme: Theme, deps: PanelDeps, chrome: PanelChrome): SettingItem[] {
	return MENU.map((def): SettingItem => {
		const text = m.settings[def.id];
		const base = {
			id: def.id,
			label: text.label,
			description: text.description,
			currentValue: def.current(cfg, m),
		};
		if (def.values) return { ...base, values: def.values(m) };
		if (def.choices) {
			const choices = def.choices(m);
			return {
				...base,
				submenu: (_current: string, done: (selectedValue?: string) => void) =>
					chooseFrom(choices, def.current(cfg, m), theme, text.label, chrome, done),
			};
		}
		return {
			...base,
			submenu: (_current: string, done: (selectedValue?: string) => void) =>
				buildLineSubmenu(cfg, m, theme, deps, groupOf(def.id), def.id, chrome, done),
		};
	});
}

/**
 * 搜索框前面的图标统一用 ⌕(与消息列表的搜索框一致). 
 *
 * `SettingsList` 的搜索框是它自己 `new Input()` 出来的, 没有公开的 prompt 选项, 所以这里改它的
 * 内部字段; pi 要是改了这个字段就保持默认提示符, 不影响功能. 
 */
function useSearchGlyph(list: SettingsList): void {
	try {
		const input = (list as unknown as { searchInput?: { prompt?: string } }).searchInput;
		if (input && typeof input.prompt === "string") input.prompt = "⌕ ";
	} catch {
		/* 版本差异: 保持默认提示符 */
	}
}

/** 面板里语言真的换了: 调用方要用新语言重开面板 */
export interface SettingsResult {
	languageChanged?: boolean;
}

/**
 * 打开设置面板(原生 /settings 样式, 动态行/结算行为子菜单). 
 * @param onApplied 每次修改后回调(便于立即应用到运行中的计数器)
 */
export async function openSettingsPanel(
	ctx: ExtensionCommandContext,
	cfg: TokenMeterConfig,
	onApplied: () => void,
): Promise<SettingsResult | undefined> {
	const m = messages(cfg.language);

	return ctx.ui.custom<SettingsResult | undefined>((tui, theme, _keybindings, done) => {
		// 与 SettingsSelectorComponent 相同的三段式: 分隔线 / 标题 + 列表 / 页脚 + 分隔线
		const border = (str: string) => theme.fg("border", str);
		const container = new Container();
		container.addChild(new DynamicBorder(border));
		// 缩进 2: SettingsList 的条目与提示行就是从第 2 列开始渲染的, 这样标题跟正文对齐
		const title = new Text(theme.fg("accent", theme.bold(m.settingsTitle)), 2, 0);
		container.addChild(title);
		// 进子菜单时标题换成那一项的行标签, 退出换回面板名
		const chrome: PanelChrome = {
			show: (label?: string) => title.setText(theme.fg("accent", theme.bold(label ?? m.settingsTitle))),
		};

		// 用来判断语言是不是真的换了(选同一个值不该重开面板)
		const languageBefore = cfg.language;
		let list: SettingsList | undefined;
		const deps: PanelDeps = { getList: () => list, onApplied };
		const items = buildItems(cfg, m, theme, deps, chrome);
		list = new SettingsList(
			items,
			10,
			makeNativeListTheme(theme),
			(id, newValue) => {
				applySetting(cfg, id as SettingId, newValue, m);
				onApplied();
				if (id === "language" && cfg.language !== languageBefore) done({ languageChanged: true });
			},
			() => done({}),
			{ enableSearch: true },
		);
		useSearchGlyph(list);
		container.addChild(list);
		// 页脚给配置文件的路径(用 ~ 缩短), 用户得能找到这个文件
		container.addChild(new Text(theme.fg("dim", shortenHomePath(configPath())), 2, 0));
		container.addChild(new DynamicBorder(border));

		return {
			render(width: number): string[] {
				return container.render(width);
			},
			invalidate(): void {
				container.invalidate();
			},
			handleInput(data: string): void {
				list.handleInput(data);
				tui.requestRender();
			},
			dispose(): void {},
		};
	});
}

/** 没有界面的模式(json / print): 用面板同源的设置表报当前状态(配置给完整路径, 方便直接去开文件) */
export function statusText(cfg: TokenMeterConfig, m: Messages): string {
	return m.status(
		MENU.map((def) => `${m.settings[def.id].label}: ${def.current(cfg, m)}`),
		configPath(),
	);
}

/** 有 UI 但没有自定义组件能力的模式(RPC): 按同一张表逐项选择对话框 */
export async function openSettingsDialog(
	ctx: ExtensionCommandContext,
	cfg: TokenMeterConfig,
	onApplied: () => void,
): Promise<void> {
	const m = messages(cfg.language);
	/** 问一项; 返回 false 表示用户取消(已改的项保留) */
	const ask = async (id: SettingId, group: string | undefined, values: string[], current: string): Promise<boolean> => {
		const title = m.dialogTitle(group, m.settings[id].label);
		const picked = await ctx.ui.select(m.pickPrompt(title, current), values);
		if (picked === undefined) return false;
		applySetting(cfg, id, picked, m);
		onApplied();
		return true;
	};

	for (const def of MENU) {
		if (def.values) {
			if (!(await ask(def.id, undefined, def.values(m), def.current(cfg, m)))) return;
			continue;
		}
		// 候选子菜单的项(语言): 同一批候选
		if (def.choices) {
			if (!(await ask(def.id, undefined, def.choices(m), def.current(cfg, m)))) return;
			continue;
		}
		const line = groupOf(def.id);
		for (const id of LINE_IDS[line]) {
			if (!(await ask(id, m.groupShort[line], [m.on, m.off], boolLabel(boolOf(cfg, id), m)))) return;
		}
	}
	ctx.ui.notify(m.saved, "info");
}
