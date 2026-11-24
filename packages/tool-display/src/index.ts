/**
 * tool-display -- 工具调用展示密度可配置(mini / low / medium / default).
 *
 * 实现方式: 用 pi.registerToolRenderer() 在内建工具真正的渲染器外面包一层,
 * 只改调用行 / 结果行怎么画, 不碰工具定义、参数、执行与活跃集. next() 给出的是
 * "其余解析器(别的扩展)再到内建工具本身最终会用"的渲染器, 所以模型看到的工具描述、
 * 系统提示词与执行行为完全不变; 用户关掉的工具也不会被本扩展重新激活.
 *
 * 解析器必须在扩展工厂阶段注册: pi 的 /reload 是"先重建聊天行, 后发 session_start",
 * 行组件创建当场就会解析并固化渲染器, 晚一步注册就来不及了.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog, ensureConfigFile, getSharedConfig, type ToolDisplayConfig } from "./config.ts";
import { openSettingsDialog, openSettingsPanel, statusText, USAGE_HINT } from "./panel.ts";
import { renderCallSlot, renderResultSlot, type AnyRenderers, type AnyResult, type RenderContextLike } from "./render.ts";
import {
	armInstanceCapture,
	installMousePatch,
	invalidateAll,
	noteAssistantMessage,
	noteToolEnd,
	noteToolStart,
	setOwnedTools,
	setSessionLookup,
} from "./state.ts";

/** 本扩展接管的内建工具; 其余工具原样交给后续解析器与内建渲染.  */
const OWNED_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

export default function (pi: ExtensionAPI) {
	debugLog("factory loaded");
	// 跨模块代际共享(见 config.ts): 所有渲染器读写同一份配置
	const config: ToolDisplayConfig = getSharedConfig();
	// mini 的批次汇总只统计本扩展负责的工具
	setOwnedTools(OWNED_TOOLS);

	// 工厂阶段注册: reload 重建聊天行(早于 session_start)时就要能解析到这些渲染器
	if (typeof pi.registerToolRenderer === "function") {
		pi.registerToolRenderer((toolName, next) => {
			if (!OWNED_TOOLS.has(toolName)) {
				// 不是我们负责的工具: 交回后续解析器 / 内建工具, 不能返回 undefined
				return next();
			}
			const base = next();
			if (!base) {
				return undefined;
			}
			return {
				// 外壳自己画: 空内容时整行零高度(mini 合并其余行的关键)
				renderShell: "self",
				renderCall(args, theme, context) {
					return renderCallSlot(toolName, base as AnyRenderers, args, theme, context as RenderContextLike, config);
				},
				renderResult(result, options, theme, context) {
					return renderResultSlot(
						toolName,
						base as AnyRenderers,
						result as unknown as AnyResult,
						options,
						theme,
						context as RenderContextLike,
						config,
					);
				},
			};
		});
	} else {
		// pi < 1.0.1: 没有渲染器解析接口, 工具行保持原生(设置命令仍可用)
		debugLog("registerToolRenderer unavailable; keeping native tool rows");
	}

	pi.on("session_start", (event, ctx) => {
		debugLog("session_start", JSON.stringify(event), "mode=", ctx.mode);
		getSharedConfig();
		ensureConfigFile();
		// 历史行里的耗时靠会话时间戳补(见 state.ts); reload 会先建行后发 session_start,
		// 因此这里叫醒一次已建出来的行, 让它们拿到刚装好的会话查询
		setSessionLookup(ctx.sessionManager as unknown as { getBranch(): unknown[]; getLeafId(): string });
		invalidateAll();

		if (ctx.mode === "tui") {
			// 零高度 widget:借工厂拿 TUI 引用, 给鼠标派发打"移出清除"补丁;
			// armInstanceCapture 是第二条通道(借 requestRender 的 this 拿真实实例),
			// 两条都幂等, 模式切换后也会重新生效
			ctx.ui.setWidget("tool-display.hover", (tui) => {
				installMousePatch(tui);
				armInstanceCapture(tui as unknown as Record<string, unknown>);
				return {
					render: () => [],
					invalidate() {},
				};
			});
		}
	});

	// 批次与状态记账:实时事件(历史回放走会话扫描,见 state.ts)
	pi.on("message_update", (event) => noteAssistantMessage(event.message));
	pi.on("message_end", (event) => noteAssistantMessage(event.message));
	pi.on("tool_execution_start", (event) => noteToolStart(event.toolCallId, event.toolName, event.args));
	pi.on("tool_execution_end", (event) => noteToolEnd(event.toolCallId, event.isError));

	pi.registerCommand("tool-display-settings", {
		// 命令描述固定成英文的 "<扩展名> Settings(<配置文件>)", 不参与 i18n(斜杠命令的约定)
		description: "Tool Display Settings(tool-display.json)",
		handler: async (args, ctx) => {
			debugLog("command tool-display-settings", JSON.stringify(args));
			// 不接受参数: 同一段文字在不同版本里被当成不同东西是脚本/文档最容易踩的坑
			if (args.trim() !== "") {
				ctx.ui.notify(USAGE_HINT, "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(statusText(config), "info");
				return;
			}
			const onApplied = () => invalidateAll();
			if (ctx.mode !== "tui") {
				await openSettingsDialog(ctx, config, onApplied);
				return;
			}
			await openSettingsPanel(ctx, config, onApplied);
		},
	});
}
