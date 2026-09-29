/**
 * tool-display -- 工具调用展示密度可配置(mini / low / medium / default). 
 *
 * 实现方式:用 create*ToolDefinition() 取到完整内建定义后展开,只覆盖渲染槽位,
 * execute 委托回内建实现并原样透传 ctx. 因此 description / parameters /
 * promptSnippet / promptGuidelines / constrainedSampling / prepareArguments /
 * renderShell(这里统一改成 "self",外壳自己画)/ 执行行为全部可控且与内建一致,
 * 模型看到的工具描述与系统提示词不变. 
 *
 * 注意:只在 session_start 时给"当前真正启用的内建工具"注册覆盖,因此尊重
 * settings.json 的 defaultTools 以及 --tools / --exclude-tools / --no-builtin-tools. 
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	debugLog,
	ensureConfigFile,
	getSharedConfig,
	type ToolDisplayConfig,
} from "./config.ts";
import { openSettingsDialog, openSettingsPanel, statusText, USAGE_HINT } from "./panel.ts";
import { renderCallSlot, renderResultSlot, type AnyDef, type AnyResult, type RenderContextLike } from "./render.ts";
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

type ToolFactory = (cwd: string, options?: any) => AnyDef;

/** 排查用:写入扩展目录的 debug.log(MT_DEBUG=1 时同时打到 stderr).  */
const dbg = debugLog;

const FACTORIES: Record<string, ToolFactory> = {
	read: createReadToolDefinition,
	bash: createBashToolDefinition,
	powershell: createPowerShellToolDefinition,
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};

/** 与 agent-session 构造内建工具时相同的选项.  */
type BuiltInToolOptions = {
	read?: { autoResizeImages: boolean };
	bash?: { commandPrefix: string | undefined; shellPath: string | undefined };
};

function resolveToolOptions(cwd: string, projectTrusted: boolean): BuiltInToolOptions {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
		return {
			read: { autoResizeImages: settings.getImageAutoResize() },
			bash: { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() },
		};
	} catch {
		return {};
	}
}

export default function (pi: ExtensionAPI) {
	dbg("factory loaded");
	const cache = new Map<string, AnyDef>();
	const registeredNames = new Set<string>();
	/**
	 * 注册去重按"运行时"而不是按模块状态: /reload 会腹排旧的工具注册并重建
	 * 运行时, 但扩展模块(含模块级变量)被缓存复用--若按模块记忆"已注册", 
	 * 重载后会全部跳过注册, 工具行就退回原版渲染, 档位设置失效. 
	 */
	const registeredRuntimes = new WeakSet<object>();
	let toolOptions: BuiltInToolOptions = {};
	// 跨模块代际共享(见 config.ts): 所有渲染器读写同一份配置
	const config: ToolDisplayConfig = getSharedConfig();
	/** 工厂阶段只能全量注册(读不到活跃集), 到 session_start 再校正活跃集.  */
	let needActiveReconcile = false;

	function definitionFor(name: string, cwd: string): AnyDef {
		const key = `${name}\0${cwd}`;
		let definition = cache.get(key);
		if (!definition) {
			const options = name === "read" ? toolOptions.read : name === "bash" ? toolOptions.bash : undefined;
			definition = FACTORIES[name](cwd, options);
			cache.set(key, definition);
		}
		return definition;
	}

	function buildDefinition(name: string): AnyDef {
		// 注册用定义按启动 cwd 建一份;渲染时路径取自 context.cwd,执行时再按 ctx.cwd 取对应实例. 
		const base = definitionFor(name, process.cwd());

		const definition: AnyDef = {
			...base,
			// 外壳自己画:空内容时整行零高度(mini 合并其余行的关键)
			renderShell: "self",

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				// ctx 必须透传:powershell/bash 靠它注入 PI_* 环境变量,read 靠它获取当前模型信息
				return definitionFor(name, ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
			},

			renderCall(args, theme, context) {
				return renderCallSlot(name, base, args, theme, context as RenderContextLike, config);
			},

			renderResult(result, options, theme, context) {
				return renderResultSlot(
					name,
					base,
					result as unknown as AnyResult,
					options,
					theme,
					context as RenderContextLike,
					config,
				);
			},
		};
		return definition;
	}

	/** 给当前运行时注册覆盖(幂等).  */
	function ensureOverrides(): void {
		if (registeredRuntimes.has(pi)) {
			dbg("ensureOverrides: skip (already registered for this runtime)");
			return;
		}
		let names: string[] = [];
		let activeNames: string[] = [];
		try {
			const active = new Set(pi.getActiveTools());
			activeNames = [...active];
			names = Object.keys(FACTORIES).filter((name) => active.has(name));
		} catch {
			// 扩展加载(工厂)阶段读不到活跃集, 只能全量注册. 必须在这里注册: 
			// pi 的 /reload 是"先重建聊天行, 后发 session_start", 行组件创建当场
			// 就会烘进工具渲染定义, 晚一步注册就来不及了(表现为 reload 后全部原生). 
			names = Object.keys(FACTORIES);
			needActiveReconcile = true;
			dbg("ensureOverrides: factory phase, register all and defer active reconcile");
		}
		for (const name of names) {
			pi.registerTool(buildDefinition(name));
		}
		registeredRuntimes.add(pi);
		registeredNames.clear();
		for (const name of names) {
			registeredNames.add(name);
		}
		setOwnedTools(registeredNames);
		dbg("ensureOverrides: registered", names, "active was", activeNames);
		// 重载前已渲染的行用新定义重画
		invalidateAll();
	}

	/** 工厂阶段全量注册过的话, 按 settings 的 defaultTools 校正活跃集, 避免激活未启用的内建工具.  */
	function reconcileActiveTools(cwd: string, projectTrusted: boolean): void {
		if (!needActiveReconcile) {
			return;
		}
		needActiveReconcile = false;
		try {
			const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
			const configured = settings.getDefaultTools();
			// 没显式配 defaultTools 时不裁剪: 意图可能来自 --tools 等命令行, 不替用户做主
			if (!configured) {
				return;
			}
			const keep = new Set(configured);
			const active = pi.getActiveTools();
			const trimmed = active.filter((name) => FACTORIES[name] && !keep.has(name));
			if (trimmed.length > 0) {
				pi.setActiveTools(active.filter((name) => !trimmed.includes(name)));
				dbg("reconcileActiveTools: trimmed", trimmed);
			}
		} catch (error) {
			dbg("reconcileActiveTools failed", String(error));
		}
	}

	// 必须在 session_start 之后注册(而不是扩展加载阶段):registerTool() 会把新工具名
	// 自动加入 active 集合,加载阶段注册会把配置里没启用的内建工具重新激活. 
	// before_agent_start 是兑底: 任何导致注册丢失的生命周期(如 /reload 后)在下一次
	// 对话开始前自愈. 
	pi.on("session_start", (event, ctx) => {
		dbg("session_start", JSON.stringify(event), "mode=", ctx.mode);
		getSharedConfig();
		ensureConfigFile();
		toolOptions = resolveToolOptions(ctx.cwd, ctx.isProjectTrusted());
		setSessionLookup(
			ctx.sessionManager as unknown as { getBranch(): unknown[]; getLeafId(): string },
		);
		// 历史行里的耗时靠会话时间戳补(见 state.ts); reload 会先建行后发 session_start,
		// 因此这里叫醒一次已建出来的行, 让它们拿到刚装好的会话查询
		invalidateAll();
		ensureOverrides();
		reconcileActiveTools(ctx.cwd, ctx.isProjectTrusted());

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
	pi.on("before_agent_start", () => {
		ensureOverrides();
	});
	pi.on("message_update", (event) => noteAssistantMessage(event.message));
	pi.on("message_end", (event) => noteAssistantMessage(event.message));
	pi.on("tool_execution_start", (event) => noteToolStart(event.toolCallId, event.toolName, event.args));
	pi.on("tool_execution_end", (event) => noteToolEnd(event.toolCallId, event.isError));

	pi.registerCommand("tool-display-settings", {
		// 命令描述固定成英文的 "<扩展名> Settings(<配置文件>)", 不参与 i18n(斜杠命令的约定)
		description: "Tool Display Settings(tool-display.json)",
		handler: async (args, ctx) => {
			dbg("command tool-display-settings", JSON.stringify(args));
			// 自愈:若覆盖因生命周期问题丢失,开设置时顺手补回来
			ensureOverrides();
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

	// 关键:覆盖必须在扩展加载(工厂)阶段就注册(见 ensureOverrides 注释里的时序说明), 
	// session_start / before_agent_start / 命令只做幂等补漏
	try {
		ensureOverrides();
	} catch (error) {
		dbg("factory ensureOverrides failed", String(error));
	}
}
