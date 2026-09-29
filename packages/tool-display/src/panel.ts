/**
 * tool-display · 可视化设置面板
 *
 * `/tool-display-settings` 唤起. 样式与 pi 原生 /settings 一致:
 * 上下 DynamicBorder 分隔线 + SettingsList(原生列表主题, 自带搜索与按键提示).
 * 面板顶部是标题(缩进 2), 底部是配置文件路径(同样缩进 2), 中间是原生列表 + 搜索.
 * 命令入口按能力分派(见 index.ts): TUI 开这里的面板; 有 UI 但没自定义组件(RPC)走
 * openSettingsDialog; 完全没有界面(json / print)走 statusText.
 *
 * 文案: 本包已确认不做多语言(保持英文硬编码), 所以面板/对话框/状态提示直接用英文,
 * 不引 i18n 表. 设置项只有一张表(MENU), 面板与降级对话框共用.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component, SelectListTheme, SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import { Container, SelectList, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import {
	configPath,
	EXPAND_STYLES,
	saveConfig,
	shortenHomePath,
	TIERS,
	type ExpandStyle,
	type Tier,
	type ToolDisplayConfig,
} from "./config.ts";

export type SettingId = "display" | "expandStyle" | "low.nameLimit" | "medium.showErrorLine" | "hoverHighlight";

const PANEL_TITLE = "Tool Display Settings";
const SAVED = "Tool Display settings saved.";
export const USAGE_HINT = "This command takes no arguments. Run /tool-display-settings to open the settings panel.";

const ON = "on";
const OFF = "off";

const TIER_LABELS: Record<Tier, string> = {
	mini: "mini (batch count)",
	low: "low (batch names)",
	medium: "medium (row + summary)",
	default: "default (stock)",
};

const EXPAND_LABELS: Record<ExpandStyle, string> = {
	medium: "medium (call row + summary)",
	default: "default (native preview)",
};

/** low 折叠行最多列几个工具名(其余收成 +N) */
const NAME_LIMITS = [1, 2, 3, 4, 5, 6, 8, 10];

interface SettingDef {
	/** = 配置字段名(嵌套字段用点号) */
	id: SettingId;
	label: string;
	description: string;
	/** 候选 = 本行回车直接切换(会循环); 与 choices 二选一 */
	values?: string[];
	/** 候选 = 回车进子菜单从列表里选(不循环); 与 values 二选一 */
	choices?: string[];
	current: (cfg: ToolDisplayConfig) => string;
}

/**
 * 设置项表. 面板与降级对话框共用这一张表, 新增设置只改这里.
 * 顺序: 常用在前.
 */
const MENU: SettingDef[] = [
	{
		id: "display",
		label: "Display density",
		description: "How built-in tool calls are drawn: a mini/low batch summary line, a medium call row with a summary, or pi's stock rendering.",
		// 档位用子菜单选(不循环): 低频且有四种, 列出来让用户看着选
		choices: TIERS.map((tier) => TIER_LABELS[tier]),
		current: (cfg) => TIER_LABELS[cfg.display],
	},
	{
		id: "expandStyle",
		label: "Expanded calls",
		description: "What each call shows while a mini/low batch is expanded: the call row plus its summary (no output), or pi's stock rendering with the output preview. Click a call for the full output.",
		values: EXPAND_STYLES.map((style) => EXPAND_LABELS[style]),
		current: (cfg) => EXPAND_LABELS[cfg.expandStyle],
	},
	{
		id: "low.nameLimit",
		label: "Low name limit",
		description: "How many tool names a low row lists before the rest collapse into +N.",
		values: NAME_LIMITS.map((n) => String(n)),
		current: (cfg) => String(cfg.low.nameLimit),
	},
	{
		id: "medium.showErrorLine",
		label: "Medium error line",
		description: "Add an error summary line under a failed medium call.",
		values: [ON, OFF],
		current: (cfg) => (cfg.medium.showErrorLine ? ON : OFF),
	},
	{
		id: "hoverHighlight",
		label: "Hover highlight",
		description: "Brighten the row under the pointer (fullscreen TUI only).",
		values: [ON, OFF],
		current: (cfg) => (cfg.hoverHighlight ? ON : OFF),
	},
];

function tierOf(label: string): Tier {
	return TIERS.find((tier) => TIER_LABELS[tier] === label) ?? "mini";
}

function expandStyleOf(label: string): ExpandStyle {
	return EXPAND_STYLES.find((style) => EXPAND_LABELS[style] === label) ?? "medium";
}

/** 应用一项设置并落盘. `value` 是面板/对话框里的显示文案.  */
export function applySetting(cfg: ToolDisplayConfig, id: SettingId, value: string): void {
	switch (id) {
		case "display":
			cfg.display = tierOf(value);
			break;
		case "expandStyle":
			cfg.expandStyle = expandStyleOf(value);
			break;
		case "low.nameLimit": {
			const parsed = Number.parseInt(value, 10);
			if (Number.isFinite(parsed)) {
				cfg.low.nameLimit = Math.min(20, Math.max(1, parsed));
			}
			break;
		}
		case "medium.showErrorLine":
			cfg.medium.showErrorLine = value === ON;
			break;
		case "hoverHighlight":
			cfg.hoverHighlight = value === ON;
			break;
	}
	saveConfig(cfg);
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
 * 候选子菜单(档位这种"从几项里选一个"的设置): 光标预选在当前值那项上,
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

function buildItems(cfg: ToolDisplayConfig, theme: Theme, chrome: PanelChrome): SettingItem[] {
	return MENU.map((def): SettingItem => {
		const base = {
			id: def.id,
			label: def.label,
			description: def.description,
			currentValue: def.current(cfg),
		};
		if (def.values) {
			return { ...base, values: def.values };
		}
		const choices = def.choices ?? [];
		return {
			...base,
			submenu: (_current: string, done: (selectedValue?: string) => void) =>
				chooseFrom(choices, def.current(cfg), theme, def.label, chrome, done),
		};
	});
}

/** 打开设置面板(原生 /settings 样式). `onApplied` 每次修改后回调, 便于立即重画对话区.  */
export async function openSettingsPanel(
	ctx: ExtensionCommandContext,
	cfg: ToolDisplayConfig,
	onApplied: () => void,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		// 与原生设置面板相同的三段式: 分隔线 / 标题 + 列表 / 页脚 + 分隔线
		const border = (str: string) => theme.fg("border", str);
		const container = new Container();
		container.addChild(new DynamicBorder(border));
		// 缩进 2: SettingsList 的条目与提示行就是从第 2 列开始渲染的, 这样标题跟正文对齐
		const titleText = new Text(theme.fg("accent", theme.bold(PANEL_TITLE)), 2, 0);
		container.addChild(titleText);
		// 进子菜单时标题换成那一项的行标签, 退出换回面板名
		const chrome: PanelChrome = {
			show: (label?: string) => titleText.setText(theme.fg("accent", theme.bold(label ?? PANEL_TITLE))),
		};

		let list: SettingsList | undefined;
		const items = buildItems(cfg, theme, chrome);
		list = new SettingsList(
			items,
			10,
			makeNativeListTheme(theme),
			(id, newValue) => {
				applySetting(cfg, id as SettingId, newValue);
				// 档位与"展开所有工具输出"(Ctrl+O)相斥: 全局展开开着时任何档位都被压过,
				// 选档位即收回全局展开; 要全量看用 Ctrl+O.
				if (id === "display") ctx.ui.setToolsExpanded?.(false);
				onApplied();
			},
			() => done(),
			{ enableSearch: true },
		);
		useSearchGlyph(list);
		container.addChild(list);
		// 页脚给配置文件路径(用 ~ 缩短), 用户得能找到这个文件
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
export function statusText(cfg: ToolDisplayConfig): string {
	const fields = MENU.map((def) => `${def.id}=${def.current(cfg)}`);
	return `Tool Display: ${fields.join(" · ")} (config: ${configPath()})`;
}

/** 有 UI 但没有自定义组件能力的模式(RPC): 按同一张表逐项选择对话框 */
export async function openSettingsDialog(
	ctx: ExtensionCommandContext,
	cfg: ToolDisplayConfig,
	onApplied: () => void,
): Promise<void> {
	for (const def of MENU) {
		const title = `${def.label}? (current: ${def.current(cfg)})`;
		const picked = await ctx.ui.select(title, def.values ?? def.choices ?? []);
		if (picked === undefined) {
			return; // 用户取消: 已改的项保留, 未问到的跳过
		}
		applySetting(cfg, def.id, picked);
		if (def.id === "display") ctx.ui.setToolsExpanded?.(false);
		onApplied();
	}
	ctx.ui.notify(SAVED, "info");
}
