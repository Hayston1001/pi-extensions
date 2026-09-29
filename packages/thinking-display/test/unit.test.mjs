/**
 * unit.test.mjs -- 配置 / 流式规则 / 折叠标记与 hover / 设置面板
 *
 * 全部走与线上一致的加载链路(jiti + pi 别名):扩展的补丁打在**真实**的
 * AssistantMessageComponent 原型上, 断言基于真实渲染结果(先剥 ANSI 再匹配).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	FakeTui,
	copyExtensionTo,
	isolatedAgentDir,
	loadConfigModule,
	loadModules,
	makeApi,
	makeChecker,
	makeContext,
	makeTheme,
	makeUi,
	stripAnsi,
} from "./harness.mjs";

const STATE_KEY = "__piThinkingStreamState";

const think = (text) => ({ type: "thinking", thinking: text });
const text = (value) => ({ type: "text", text: value });
const toolCall = () => ({ type: "toolCall", id: "call-1", name: "bash" });
/** hover 用的两种琥珀色(与扩展里的常量一致).  */
const AMBER = { dim: "\u001b[38;2;156;131;83m", bright: "\u001b[38;2;240;198;116m" };

export async function run() {
	const { check, failures } = makeChecker();

	const root = isolatedAgentDir("unit");
	rmSync(root, { recursive: true, force: true });
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	// 从**临时目录的副本**加载, 不从包目录直接加载: 包目录里一旦有 config.json
	// (本地开发时就是这个工作流), 扩展的写盘就会落到真实文件上.
	const workDir = join(root, "ext");
	copyExtensionTo(workDir);
	const { piPackage, config, index } = await loadModules(workDir);
	const { AssistantMessageComponent } = piPackage;
	const sharedState = () => globalThis[STATE_KEY];
	const configFile = join(agentDir, "thinking-display.json");

	try {
		// ---------------------------------------------------------- 配置
		console.log("config:");
		const defaults = config.defaultConfig();
		check("默认快照:streaming / decorate 都开", defaults.streaming === true && defaults.decorate === true);
		check("配置只有一处: agent 目录", config.configPath() === configFile, config.configPath());
		check("缺文件读到默认值", config.loadConfig().streaming === true);

		writeFileSync(configFile, JSON.stringify({ streaming: false, decorate: false }));
		const fromFile = config.loadConfig();
		check("文件里的两个字段都生效", fromFile.streaming === false && fromFile.decorate === false);

		writeFileSync(configFile, JSON.stringify({ streaming: "yes" }));
		const badType = config.loadConfig();
		check("字段类型不对退回默认值", badType.streaming === true && badType.decorate === true);

		writeFileSync(configFile, "{ not json");
		check("坏 JSON 退回默认值", config.loadConfig().streaming === true);

		config.saveConfig({ streaming: false, decorate: true });
		const saved = config.loadConfig();
		check("saveConfig 往返一致", saved.streaming === false && saved.decorate === true);

		// 写盘是 patch: 文件里我们自己不认识的字段要留着
		writeFileSync(configFile, JSON.stringify({ streaming: true, myOwnField: "keep me" }));
		config.saveConfig({ streaming: false, decorate: true });
		const patched = JSON.parse(readFileSync(configFile, "utf8"));
		check(
			"写盘 patch: 未知字段保留, 认识的字段被覆盖",
			patched.myOwnField === "keep me" && patched.streaming === false && patched.decorate === true,
			JSON.stringify(patched),
		);
		const raw = readFileSync(configFile, "utf8");
		check("写盘: 2 空格缩进 + 末尾换行", raw.startsWith('{\n  "') && raw.endsWith("}\n"), JSON.stringify(raw));

		const home = homedir();
		const homePath = join(home, ".pi", "agent", "thinking-display.json");
		check(
			"页脚路径: 主目录缩成 ~",
			config.shortenHomePath(homePath) === `~${homePath.slice(home.length)}`,
			config.shortenHomePath(homePath),
		);
		// node 自己的路径不在主目录下, 应当原样返回
		check("页脚路径: 不在主目录下就原样", config.shortenHomePath(process.execPath) === process.execPath);
		check("页脚路径: 前缀相同但不是主目录的子路径不改", config.shortenHomePath(`${home}-other`) === `${home}-other`);

		const localDir = join(root, "local-package");
		copyExtensionTo(localDir);
		writeFileSync(join(localDir, "config.json"), JSON.stringify({ streaming: false, decorate: false }));
		const localConfig = await loadConfigModule(localDir);
		check(
			"旧位置(扩展目录 config.json)不再当配置位置",
			localConfig.configPath() === configFile,
			localConfig.configPath(),
		);

		// 新位置没有文件时才搬家: 读到旧那份, 写到新位置, 旧文件删掉
		rmSync(configFile, { force: true });
		const migrated = localConfig.loadConfig();
		check(
			"旧位置的配置读一次就搬过来",
			migrated.streaming === false &&
				migrated.decorate === false &&
				!existsSync(join(localDir, "config.json")) &&
				existsSync(configFile),
		);

		// 新位置已有文件时: 以新位置为准, 旧文件不动
		writeFileSync(configFile, JSON.stringify({ streaming: true, decorate: true }));
		writeFileSync(join(localDir, "config.json"), JSON.stringify({ streaming: false, decorate: false }));
		const kept = localConfig.loadConfig();
		check(
			"新位置已有配置时以新位置为准, 旧文件不动",
			kept.streaming === true && kept.decorate === true && existsSync(join(localDir, "config.json")),
		);

		// ---------------------------------------------------------- 流式规则(纯函数)
		console.log("rule:");
		const rule = index.computeStreamingVisibility;
		check("空内容 → 没有约束", rule([]).length === 0);
		check("只有正在写的 thinking → 展开", JSON.stringify(rule([think("a")])) === "[false]");
		check("后面出现正文 → 收起", JSON.stringify(rule([think("a"), text("hi")])) === "[true]");
		check("连续 thinking 算一段", JSON.stringify(rule([think("a"), think("b")])) === "[false]");
		check("空 thinking 跳过, 同段有内容仍算数", JSON.stringify(rule([think("  "), think("a"), text("hi")])) === "[true]");
		check("后面出现工具调用 → 收起", JSON.stringify(rule([think("a"), toolCall()])) === "[true]");
		check("出现在前面的正文不算数", JSON.stringify(rule([text("hi"), think("a")])) === "[false]");
		check("两段各自判断", JSON.stringify(rule([think("a"), text("hi"), think("b")])) === "[true,false]");
		check("空白正文不算可见内容", JSON.stringify(rule([think("a"), text("   ")])) === "[false]");

		// ---------------------------------------------------------- 补丁接线
		console.log("hook:");
		rmSync(configFile, { force: true });
		const { api, handlers, commands } = makeApi();
		const { ui, calls } = makeUi();
		const ctx = makeContext(ui);
		index.default(api);
		const command = commands.get("thinking-display-settings");
		check("注册了 thinking-display-settings", !!command);
		check("命令描述与文档一致", command?.description === "Thinking Display Settings(thinking-display.json)", command?.description);
		check("注册了 thinking-display-refresh(运行时重捕, 不是设置项)", !!commands.get("thinking-display-refresh"));
		check("只有这两个命令", commands.size === 2, [...commands.keys()].join(","));

		try {
			piPackage.initTheme("dark");
			piPackage.getMarkdownTheme();
		} catch (error) {
			check("主题可初始化(渲染断言的前提)", false, String(error));
		}

		await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const marker = AssistantMessageComponent.prototype.__piThinkingStreamPatched;
		check("session_start 后原型已打补丁", typeof marker === "number" && marker >= 4, String(marker));
		check("工厂阶段就把配置镜像进共享状态", sharedState()?.enabled === true && sharedState()?.decorate === true);
		check("缺文件时落一份默认配置", readFileSync(configFile, "utf8").includes('"streaming": true'));

		// 首次落盘不限 TUI: 没有面板的宿主(如 RPC)只能靠这个文件配置
		rmSync(configFile, { force: true });
		const headless = makeApi();
		index.default(headless.api);
		await headless.handlers
			.get("session_start")({ type: "session_start", reason: "startup" }, makeContext(makeUi().ui, { mode: "rpc" }));
		check("非 TUI 会话启动也落一份默认配置", existsSync(configFile));

		// 借零高度 widget 拿 TUI 并给鼠标派发打补丁
		const widget = calls.widgets.get("thinking-stream.runtime");
		check("session_start 注册了 runtime widget", typeof widget === "function");
		const fakeTui = new FakeTui();
		widget?.(fakeTui, makeTheme());
		check("鼠标派发补丁已安装", sharedState()?.mousePatchInstalled === true);
		sharedState().hover = { component: {}, runIndex: 0 };
		fakeTui.handleMouseEvent({ type: "move" });
		check("任何鼠标事件先清 hover(移出即熄灭)", sharedState().hover === null);

		// ---------------------------------------------------------- 渲染行为
		console.log("render:");
		const render = (content, { hide = true, streaming = true } = {}) => {
			const message = { role: "assistant", content };
			const component = new AssistantMessageComponent(message, hide, undefined, undefined, 0);
			component.updateContent(message, streaming);
			const views = component.contentContainer.children.filter((child) => child?.__piThinkingRegionView === true);
			return { component, views, lines: component.render(72).map(stripAnsi) };
		};

		const answered = render([think("first pass"), text("the answer")]);
		check(
			"流式中:后面的正文让前一段 thinking 收起",
			answered.views.length === 1 && answered.views[0].hidden === true,
			JSON.stringify(answered.views.map((view) => view.hidden)),
		);
		check(
			"收起态:折叠标记 + 隐藏标签",
			answered.lines.some((line) => line.startsWith("+ ") && line.includes("Thinking...")),
			JSON.stringify(answered.lines),
		);
		check("正文照常渲染", answered.lines.some((line) => line.includes("the answer")));
		check("渲染完清空临时 override", answered.component.thinkingVisibilityOverrides.size === 0);

		const live = render([think("currently writing")]);
		check(
			"流式中:正在写的 thinking 保持展开",
			live.views.length === 1 && live.views[0].hidden === false,
			JSON.stringify(live.views.map((view) => view.hidden)),
		);
		check(
			"展开态:标记是 -",
			live.lines.some((line) => line.startsWith("- ") && line.includes("currently writing")),
			JSON.stringify(live.lines),
		);
		// 外壳要扮成被包的 MouseRegion: 下游(别的扩展)靠 `child` / `onMouse` 认思考块
		check(
			"装饰外壳转发 child / onMouse(下游才认得出来是思考块)",
			live.views[0].child === live.views[0].region.child &&
				live.views[0].onMouse === live.views[0].region.onMouse &&
				typeof live.views[0].onMouse === "function",
		);

		const midTurn = render([think("first pass"), text("the answer"), think("second pass")]);
		check("多段:前面的收起, 正在写的展开", JSON.stringify(midTurn.views.map((v) => v.hidden)) === "[true,false]");

		const finished = render([think("first pass"), text("the answer"), think("second pass")], { streaming: false });
		check(
			"回合结束后不再施加规则",
			finished.views.every((view) => view.hidden === true),
			JSON.stringify(finished.views.map((view) => view.hidden)),
		);

		const stockExpanded = render([think("a"), text("b")], { hide: false });
		check(
			"Ctrl+T 展开模式下规则不生效",
			stockExpanded.views.length === 1 && stockExpanded.views[0].hidden === false,
		);

		// hover / click
		sharedState().hover = null;
		const hovered = render([think("currently writing")]);
		const view = hovered.views[0];
		const beforeHover = view.render(72)[0];
		view.handleMouse({ type: "move" });
		const afterHover = view.render(72)[0];
		check("hover 前是暗琥珀色", beforeHover.includes(AMBER.dim));
		check("hover 时提亮", afterHover.includes(AMBER.bright) && !afterHover.includes(AMBER.dim));
		check("hover 目标记在共享状态里(跨模块代际)", sharedState().hover?.runIndex === 0);
		view.handleMouse({ type: "click", button: "left" });
		const clicked = hovered.component.render(72).map(stripAnsi);
		check(
			"click 透传给原 region(点击折叠/展开仍生效, 且压过自动规则)",
			hovered.component.thinkingVisibilityOverrides.get(0) === true,
			String(hovered.component.thinkingVisibilityOverrides.get(0)),
		);
		check(
			"click 后立刻变成收起态",
			clicked.some((line) => line.startsWith("+ ") && line.includes("Thinking...")),
			JSON.stringify(clicked),
		);

		// ---------------------------------------------------------- 关配置后的退化路径
		console.log("opt-out:");
		writeFileSync(configFile, JSON.stringify({ streaming: true, decorate: false }));
		const off = makeApi();
		index.default(off.api);
		await off.handlers.get("session_start")({ type: "session_start", reason: "startup" }, makeContext(makeUi().ui));
		check("decorate off 写进共享状态", sharedState().decorate === false);

		const plain = render([think("first pass"), text("the answer")]);
		check("decorate off:不包装 region", plain.views.length === 0);
		check(
			"decorate off:渲染里没有折叠标记, 但规则仍在(标签是隐藏态)",
			!plain.lines.some((line) => /^[+-] /.test(line)) && plain.lines.some((line) => line.includes("Thinking...")),
			JSON.stringify(plain.lines),
		);

		writeFileSync(configFile, JSON.stringify({ streaming: false, decorate: true }));
		const onlyDecor = makeApi();
		index.default(onlyDecor.api);
		await onlyDecor.handlers
			.get("session_start")({ type: "session_start", reason: "startup" }, makeContext(makeUi().ui));
		const noRule = render([think("first pass"), text("the answer")]);
		check(
			"streaming off:规则回到原版(全部按 Ctrl+T 状态)",
			noRule.views.length === 1 && noRule.views[0].hidden === true && sharedState().enabled === false,
		);

		// ---------------------------------------------------------- 命令 / 面板
		console.log("command:");
		writeFileSync(configFile, JSON.stringify({ streaming: true, decorate: true }));
		index.default(makeApi().api); // 重新镜像配置

		// 命令不接受参数: 带了参数只给一句用法提示, 配置一点都不动
		await command.handler("streaming off", ctx);
		check(
			"带参数: 给用法提示",
			calls.notify.at(-1)?.type === "warning" && calls.notify.at(-1)?.message.includes("takes no arguments"),
			calls.notify.at(-1)?.message,
		);
		check(
			"带参数: 配置一点没动",
			sharedState().enabled === true &&
				sharedState().decorate === true &&
				readFileSync(configFile, "utf8") === '{"streaming":true,"decorate":true}',
		);
		await command.handler("refresh", ctx);
		check("refresh 不再是 -settings 的参数", calls.notify.at(-1)?.type === "warning", calls.notify.at(-1)?.message);

		console.log("panel:");
		// 多写一个我们不认识的字段: 写盘是 patch, 它必须活着
		writeFileSync(configFile, JSON.stringify({ streaming: true, decorate: true, myOwnField: "keep me" }));
		index.default(makeApi().api);
		const panelUi = makeUi();
		await command.handler("", makeContext(panelUi.ui));
		check("无参数:打开面板(ui.custom)", panelUi.calls.custom.length === 1);

		const panelTui = new FakeTui();
		const panel = panelUi.calls.custom[0](panelTui, makeTheme(), undefined, () => {});
		const panelLines = panel.render(80).map(stripAnsi);
		check("首行是边框", panelLines[0].includes("──────"), panelLines[0]);
		check("末行是边框", panelLines.at(-1).includes("──────"), panelLines.at(-1));
		check(
			"第二行是标题(标题带 accent + bold, 缩进 2 列)",
			panelLines[1].startsWith("  <accent>**Thinking Display Settings**</>"),
			JSON.stringify(panelLines[1]),
		);
		check(
			"开启了搜索(提示行带 Type to search)",
			panelLines.some((line) => line.includes("Type to search") && line.includes("Esc to cancel")),
			JSON.stringify(panelLines),
		);
		check(
			"搜索框前面的图标是 ⌕",
			panelLines.some((line) => line.trim().startsWith("⌕")),
			JSON.stringify(panelLines.slice(0, 4)),
		);
		check(
			"列出两项设置及当前值",
			panelLines.some((line) => line.includes("Streaming collapse") && line.includes("on")) &&
				panelLines.some((line) => line.includes("Fold marker & hover") && line.includes("on")),
			JSON.stringify(panelLines),
		);
		// 页脚里的路径可能很长并被折行(折行处还带右侧补齐空格), 所以取最后一段 `dim` 文本,
		// 去掉所有空白后拼回去再找文件名, 并确认它确实在底边框之前.
		const footerStart = panelLines.reduce((acc, line, index) => (line.startsWith("  <dim>") ? index : acc), -1);
		const footerText = panelLines.slice(footerStart, -1).join("").replace(/\s+/g, "");
		check(
			"页脚是配置文件路径(缩进 2 列, 在底边框之前)",
			footerStart > 0 && footerText.includes("thinking-display.json"),
			JSON.stringify(panelLines.slice(-3)),
		);

		panel.handleInput("\r");
		const afterEnter = panel.render(80).map(stripAnsi);
		check(
			"回车切换值并立刻重画",
			afterEnter.some((line) => line.includes("Streaming collapse") && line.includes("off")),
			JSON.stringify(afterEnter),
		);
		check("面板重画走 requestRender", panelTui.renders >= 1);
		const savedRaw = readFileSync(configFile, "utf8");
		check("面板改动写回 config.json", savedRaw.includes('"streaming": false'));
		check("写盘: 2 空格缩进 + 末尾换行", savedRaw.startsWith('{\n  "') && savedRaw.endsWith("}\n"), JSON.stringify(savedRaw));
		check("写盘是 patch: 未知字段保留", savedRaw.includes('"myOwnField": "keep me"'));

		console.log("dialog:");
		writeFileSync(configFile, JSON.stringify({ streaming: true, decorate: true }));
		index.default(makeApi().api);
		const dialogUi = makeUi(["off", "on"]);
		await command.handler("", makeContext(dialogUi.ui, { mode: "rpc" }));
		check("非 TUI: 逐项选择而不是开面板", dialogUi.calls.select.length === 2 && dialogUi.calls.custom.length === 0);
		check(
			"对话框标题带当前值",
			dialogUi.calls.select[0].title.includes("currently"),
			dialogUi.calls.select[0].title,
		);
		check("选项就是 on / off", JSON.stringify(dialogUi.calls.select[0].options) === '["on","off"]');
		check("选完落盘", readFileSync(configFile, "utf8").includes('"streaming": false'));
		check("全部走完报 saved", dialogUi.calls.notify.at(-1)?.message.includes("settings saved"));

		// 取消(select 返回 undefined): 已改的保留, 后面的不再问, 不报 saved
		writeFileSync(configFile, JSON.stringify({ streaming: true, decorate: true }));
		index.default(makeApi().api);
		const cancelUi = makeUi(["off", undefined]);
		await command.handler("", makeContext(cancelUi.ui, { mode: "rpc" }));
		check("取消: 问到取消那一项就停", cancelUi.calls.select.length === 2);
		check("取消: 前面改的保留, 后面的没动", sharedState().enabled === false && sharedState().decorate === true);
		check("取消: 不报 saved", !cancelUi.calls.notify.some((call) => call.message.includes("saved")));

		const noUi = makeUi();
		await command.handler("", makeContext(noUi.ui, { hasUI: false }));
		check("没有 UI 时打印状态而不是开面板", noUi.calls.notify.at(-1)?.message.includes("streaming collapse:"));
		check("状态里带配置文件路径", noUi.calls.notify.at(-1)?.message.includes("thinking-display.json"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	return failures();
}
