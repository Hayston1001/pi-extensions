/**
 * unit.test.mjs -- 渲染与接线单元测试(node test/run.mjs unit)
 *
 * 覆盖:配置读取, 批次汇总(mini), low/medium/default 两槽位渲染, 耗时戳记,
 * 错误行, hover, reload 注册时序, 鼠标补丁. 全部走与线上一致的加载链路. 
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { copyExtensionTo, loadModules, makeChecker, makeContext, tempDir, theme } from "./harness.mjs";

export async function run() {
	const { check, failures } = makeChecker();
	// 从临时副本加载 + 隔离的 agent 目录: 包目录里不该有运行产物, 也绝不能碰到用户的真配置
	const root = tempDir("unit");
	const extDir = copyExtensionTo(join(root, "ext"));
	const agentDir = join(root, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { tui, config: configMod, panel: panelMod, state, render, index: ext } = await loadModules(extDir);
	const { Text } = tui;


	// ---------------------------------------------------------- 配置
	console.log("config:");
	const cfg = configMod.defaultConfig(); // 渲染测试用固定配置,不受测试期间用户改盘影响
	const configFile = join(agentDir, "tool-display.json");
	check("配置只有一处: ~/.pi/agent/tool-display.json", configMod.configPath() === configFile, configMod.configPath());
	check("没有配置文件时用默认值", configMod.loadConfig().display === "mini");

	// 旧位置(扩展目录 config.json)读一次并搬走
	writeFileSync(join(extDir, "config.json"), JSON.stringify({ display: "medium" }), "utf8");
	const migrated = configMod.loadConfig();
	check("旧位置的配置被读到", migrated.display === "medium", migrated.display);
	check("旧位置的配置被搬到 agent 目录", existsSync(configFile) && !existsSync(join(extDir, "config.json")));

	// 写盘: 2 空格 + 末尾换行 + patch 保留手写的其它字段
	writeFileSync(configFile, `${JSON.stringify({ display: "low", myCustom: 42, low: { mine: 7 } }, null, 4)}\n`, "utf8");
	configMod.saveConfig({ ...configMod.defaultConfig(), hoverHighlight: false });
	const savedRaw = readFileSync(configFile, "utf8");
	check("写盘是 2 空格缩进 + 末尾换行", savedRaw.includes('\n  "') && savedRaw.endsWith("\n"), JSON.stringify(savedRaw.slice(0, 40)));
	check("写盘保留手写的其它字段", JSON.parse(savedRaw).myCustom === 42 && JSON.parse(savedRaw).low.mine === 7);
	check("写盘覆盖认识的字段", JSON.parse(savedRaw).hoverHighlight === false);

	const cfgFile = configMod.loadConfig();
	check("display 从文件读取合法", configMod.TIERS.includes(cfgFile.display), cfgFile.display);
	check("hoverHighlight 默认开", cfg.hoverHighlight === true);
	check("expandStyle 默认 medium", cfg.expandStyle === "medium");
	check("low.nameLimit 默认 3", cfg.low.nameLimit === 3);
	check("渲染测试配置为 mini", cfg.display === "mini");
	const cfgA = configMod.getSharedConfig();
	const cfgB = configMod.getSharedConfig();
	check("配置跨代模块共享同一对象(reload 不隔离)", cfgA === cfgB);

	// 非法值退回默认
	writeFileSync(configFile, `${JSON.stringify({ display: "bogus", expandStyle: "nope", low: { nameLimit: 0 } }, null, 2)}\n`, "utf8");
	const bad = configMod.loadConfig();
	check(
		"非法档位/展开形态/上限都退回默认",
		bad.display === "mini" && bad.expandStyle === "medium" && bad.low.nameLimit === 3,
		JSON.stringify(bad),
	);

	// ---------------------------------------------------------- 假内建定义
	const base = {
		renderCall: (args, theme2) => new Text(`call:${args?.command ?? args?.pattern ?? args?.path ?? "x"}`, 0, 0),
		renderResult: (result, options, theme2) =>
			new Text(result.content.map((c) => c.text ?? "").join("\n"), 0, 0),
	};
	const okResult = { content: [{ type: "text", text: "out line" }] };
	const errResult = { content: [{ type: "text", text: "Command exited with code 1" }] };

	state.setOwnedTools(["bash", "read", "grep", "find", "write", "edit", "ls", "powershell"]);

	// ---------------------------------------------------------- mini 汇总
	console.log("mini:");
	const msg = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "t1", name: "bash" },
			{ type: "toolCall", id: "t2", name: "read" },
			{ type: "toolCall", id: "t3", name: "grep" },
			{ type: "toolCall", id: "t4", name: "find" },
			{ type: "toolCall", id: "t5", name: "write" },
		],
	};
	state.noteAssistantMessage(msg);

	const states = {};
	const ctxs = {};
	for (const [id, name, cmd] of [["t1", "bash", "npm test"], ["t2", "read", "a.ts"], ["t3", "grep", "pat"], ["t4", "find", "*.ts"], ["t5", "write", "b.ts"]]) {
		states[id] = {};
		ctxs[id] = makeContext(id, states[id], { isPartial: true, args: { command: cmd, path: cmd } });
	}
	const outs = {};
	for (const [id, name] of [["t1", "bash"], ["t2", "read"], ["t3", "grep"], ["t4", "find"], ["t5", "write"]]) {
		outs[id] = render.renderCallSlot(name, base, ctxs[id].args, theme, ctxs[id], cfg).render(80);
	}
	check("汇总行是第一个调用", state.isSummaryOwner("t1") === true);
	check("非汇总行折叠成零高度", outs.t2.length === 0 && outs.t5.length === 0, JSON.stringify(outs.t2));
	check("运行中显示 ⋯ n/5(带 + 前缀)", outs.t1.length === 1 && outs.t1[0].includes("+") && outs.t1[0].includes("⋯") && outs.t1[0].includes("0/5 tools"), outs.t1[0]);
	check("汇总行紧凑单行(无额外垫高)", outs.t1.length === 1, JSON.stringify(outs.t1));

	// 全部完成,t2 失败
	state.noteToolEnd("t1", false);
	state.noteToolEnd("t2", true);
	state.noteToolEnd("t3", false);
	state.noteToolEnd("t4", false);
	state.noteToolEnd("t5", false);
	const doneCtx = makeContext("t1", states.t1, { isPartial: false, args: { command: "npm test" } });
	const doneOut = render.renderCallSlot("bash", base, doneCtx.args, theme, doneCtx, cfg).render(80);
	check("有失败显示 ✕ 5 tools", doneOut[0].includes("✕") && doneOut[0].includes("5 tools"), doneOut[0]);

	const okStates = {};
	for (const [id, name] of [["t1", "bash"], ["t3", "grep"], ["t4", "find"], ["t5", "write"]]) {
		okStates[id] = {};
	}
	state.noteToolEnd("t2", false);
	const allOk = render.renderCallSlot("bash", base, { command: "npm test" }, theme, makeContext("t1", okStates.t1, {}), cfg).render(80);
	check("全成功显示 ✓ 5 tools", allOk[0].includes("✓") && allOk[0].includes("5 tools"), allOk[0]);
	state.noteToolEnd("t2", true);

	// 结果槽位:记录错误行(mini 不显示)
	for (const [id, name, result, isErr] of [
		["t1", "bash", okResult, false],
		["t2", "read", errResult, true],
	]) {
		const c = makeContext(id, states[id], { isError: isErr, isPartial: false });
		const out = render.renderResultSlot(name, base, result, { expanded: false, isPartial: false }, theme, c, cfg).render(80);
		check(`mini 结果槽位为空 (${id})`, out.length === 0, JSON.stringify(out));
	}

	// 点汇总行展开整批(默认 expandStyle=medium): 汇总行保留(- 前缀)+ 每条一个 medium 块
	state.toggleBatch("t1");
	const expCtx = makeContext("t1", states.t1, { isPartial: false });
	const expComp = render.renderCallSlot("bash", base, { command: "npm test" }, theme, expCtx, cfg);
	const listOut = expComp.render(80);
	check("展开保留汇总行并带 - 前缀", listOut[0].includes("-") && listOut[0].includes("5 tools"), listOut[0]);
	check(
		"mini 展开默认 medium 形态: 汇总 1 行 + 自己的 3 行调用块",
		listOut.length === 4 && listOut.some((l) => l.includes("call:npm test")),
		`${listOut.length} lines: ${JSON.stringify(listOut)}`,
	);
	check("medium 形态不显示输出", !listOut.some((l) => l.includes("out line")));

	// 同批其余行也一起显示
	const otherCtx = makeContext("t3", states.t3, { args: { pattern: "pat" }, isPartial: false });
	const otherOut = render.renderCallSlot("grep", base, otherCtx.args, theme, otherCtx, cfg).render(80);
	check("整批展开后同批其余行也画内容", otherOut.length === 3 && otherOut.some((l) => l.includes("call:pat")), JSON.stringify(otherOut));

	// 逐条再点开: 该条变完整输出(expanded)
	state.setRowOutput("t3", true);
	const drillCtx = makeContext("t3", states.t3, { args: { pattern: "pat" }, isPartial: false });
	const drillComp = render.renderCallSlot("grep", base, drillCtx.args, theme, drillCtx, cfg);
	render.renderResultSlot("grep", base, okResult, { expanded: false, isPartial: false }, theme, drillCtx, cfg);
	check("逐条点开后出现输出", drillComp.render(80).some((l) => l.includes("out line")), JSON.stringify(drillComp.render(80)));
	state.setRowOutput("t3", false);

	// 点汇总行收起: 又回到单行, 其余行零高度
	state.toggleBatch("t1");
	const collapsedOut = render.renderCallSlot("bash", base, { command: "npm test" }, theme, makeContext("t1", states.t1, {}), cfg).render(80);
	check("收起后回到单行(带 + 前缀)", collapsedOut.length === 1 && collapsedOut[0].includes("+"), JSON.stringify(collapsedOut));
	const otherCollapsed = render.renderCallSlot("grep", base, otherCtx.args, theme, makeContext("t3", {}, { args: { pattern: "pat" } }), cfg).render(80);
	check("收起后同批其余行零高度", otherCollapsed.length === 0, JSON.stringify(otherCollapsed));

	// 汇总行的点击由本扩展接管(不让 pi 那套单条展开也跟着触发)
	const summaryComp = render.renderCallSlot("bash", base, { command: "npm test" }, theme, makeContext("t1", states.t1, {}), cfg);
	const clickRes = summaryComp.handleMouse({ type: "click", button: "left", x: 0, y: 0, width: 80, height: 1 });
	check("汇总行点击被接管", clickRes?.handled === true, JSON.stringify(clickRes));
	check("点击后整批展开", state.batchIsExpanded("t1") === true);
	state.toggleBatch("t1");

	// Ctrl+O(全局展开)走 context.expanded: 直接整批全量
	const forcedOut = render.renderCallSlot("bash", base, { command: "npm test" }, theme, makeContext("t1", states.t1, { expanded: true }), cfg).render(80);
	check("Ctrl+O 时整批可见", forcedOut.some((l) => l.includes("call:npm test")), JSON.stringify(forcedOut));

	// 单条内容的点击同样由我们接管
	state.toggleBatch("t1");
	const contentComp = render.renderCallSlot("grep", base, { pattern: "pat" }, theme, makeContext("t3", {}, { args: { pattern: "pat" } }), cfg);
	const contentClick = contentComp.handleMouse({ type: "click", button: "left", x: 1, y: 1, width: 80, height: 3 });
	check("内容点击被接管", contentClick?.handled === true, JSON.stringify(contentClick));
	check("点击后该条切到完整输出", state.rowOutput("t3") === true);
	state.setRowOutput("t3", false);
	state.toggleBatch("t1");

	// 切换整批时, 同批所有行都被重绘
	state.noteAssistantMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", id: "x1", name: "bash" },
			{ type: "toolCall", id: "x2", name: "ls" },
		],
	});
	const redraws = [];
	const x2Ctx = makeContext("x2", {}, { args: { path: "." }, isPartial: false, invalidate: () => redraws.push("x2") });
	render.renderCallSlot("ls", base, x2Ctx.args, theme, x2Ctx, cfg);
	render.renderCallSlot("bash", base, { command: "x" }, theme, makeContext("x1", {}, { invalidate: () => redraws.push("x1") }), cfg);
	redraws.length = 0;
	state.toggleBatch("x1");
	check("切换整批时同批所有行都被重绘", redraws.includes("x1") && redraws.includes("x2"), JSON.stringify(redraws));
	state.toggleBatch("x1");

	// expandStyle 只决定每条在展开时的形态; 点单条翻成完整输出
	state.noteAssistantMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", id: "e1", name: "bash" },
			{ type: "toolCall", id: "e2", name: "grep" },
		],
	});
	const seenExpand = [];
	const probeBase = {
		renderCall: (a) => new Text(`call:${a?.command ?? a?.pattern ?? ""}`, 0, 0),
		renderResult: (r, o) => {
			seenExpand.push(o.expanded);
			return new Text("out line", 0, 0);
		},
	};
	// medium(默认): 展开后每条只给摘要(不调内建 result); 点单条才变完整输出
	const cfgMedium = { ...cfg, expandStyle: "medium" };
	state.toggleBatch("e1");
	const sumCtx = makeContext("e1", {}, { args: { command: "npm test" } });
	const sumComp = render.renderCallSlot("bash", probeBase, sumCtx.args, theme, sumCtx, cfgMedium);
	render.renderResultSlot("bash", probeBase, okResult, { expanded: false, isPartial: false }, theme, sumCtx, cfgMedium);
	check("medium 形态不给输出", seenExpand.length === 0 && !sumComp.render(80).some((l) => l.includes("out line")), JSON.stringify(sumComp.render(80)));
	state.setRowOutput("e1", true);
	const sumCtx2 = makeContext("e1", {}, { args: { command: "npm test" } });
	const sumComp2 = render.renderCallSlot("bash", probeBase, sumCtx2.args, theme, sumCtx2, cfgMedium);
	render.renderResultSlot("bash", probeBase, okResult, { expanded: false, isPartial: false }, theme, sumCtx2, cfgMedium);
	check("medium 下点单条变完整输出", seenExpand[0] === true && sumComp2.render(80).some((l) => l.includes("out line")), JSON.stringify(seenExpand));
	state.setRowOutput("e1", false);
	state.toggleBatch("e1");

	// default: 展开后每条是原版折叠预览(expanded=false, 带输出但受原版上限)
	const cfgDefault = { ...cfg, expandStyle: "default" };
	state.toggleBatch("e1");
	const outCtx = makeContext("e2", {}, { args: { pattern: "pat" } });
	const outComp = render.renderCallSlot("grep", probeBase, outCtx.args, theme, outCtx, cfgDefault);
	render.renderResultSlot("grep", probeBase, okResult, { expanded: false, isPartial: false }, theme, outCtx, cfgDefault);
	check("default 形态给原版预览(expanded=false)", seenExpand[1] === false && outComp.render(80).some((l) => l.includes("out line")), JSON.stringify(seenExpand));
	state.toggleBatch("e1");

	// ---------------------------------------------------------- low
	console.log("low:");
	const lowCfg = { ...cfg, display: "low" };
	const lowCtx = makeContext("t1", states.t1, { args: { command: "npm test" }, isPartial: false });
	const lowOut = render.renderCallSlot("bash", base, lowCtx.args, theme, lowCtx, lowCfg).render(80);
	check("low 折叠为单行(无上下垫高)", lowOut.length === 1, JSON.stringify(lowOut));
	check("low 不带状态背景", !lowOut[0].includes("toolSuccessBg"), lowOut[0]);
	check(
		"low 报工具名而不是数量",
		lowOut[0].includes("bash") && lowOut[0].includes("read") && lowOut[0].includes("grep") && !lowOut[0].includes("5 tools"),
		lowOut[0],
	);
	check("low 超出 nameLimit 收成 +N", lowOut[0].includes("+2"), lowOut[0]);

	const lowOther = render.renderCallSlot("read", base, { path: "a.ts" }, theme, makeContext("t2", {}, { args: { path: "a.ts" } }), lowCfg).render(80);
	check("low 同批非汇总行零高度", lowOther.length === 0, JSON.stringify(lowOther));

	const cfgLimit = { ...lowCfg, low: { nameLimit: 2 } };
	const limitedOut = render.renderCallSlot("bash", base, lowCtx.args, theme, makeContext("t1", {}, { args: { command: "npm test" } }), cfgLimit).render(80);
	check("low nameLimit 可配", limitedOut[0].includes("bash, read +3"), limitedOut[0]);

	// hover 提亮
	state.hoverRow("t1");
	const lowHoverOut = render.renderCallSlot("bash", base, lowCtx.args, theme, makeContext("t1", {}, { args: { command: "npm test" } }), lowCfg).render(80);
	check("low hover 提亮(<text>)", lowHoverOut[0].includes("<text>"), lowHoverOut[0]);

	// ---------------------------------------------------------- 耗时戳记(bug 回归)
	console.log("timing:");
	const timeState = {};
	const timeCtx = makeContext("tm1", timeState, { args: { command: "sleep 1" }, isPartial: true, executionStarted: true });
	render.renderCallSlot("bash", base, timeCtx.args, theme, timeCtx, lowCfg); // low 折叠态
	const t0 = timeState.startedAt;
	check("折叠态即打 startedAt(执行开始)", typeof t0 === "number", String(t0));
	await new Promise((r) => setTimeout(r, 5));
	const timeCtx2 = makeContext("tm1", timeState, { args: { command: "sleep 1" }, isPartial: false, executionStarted: true });
	render.renderResultSlot("bash", base, okResult, { expanded: false, isPartial: false }, theme, timeCtx2, lowCfg);
	check("折叠态即打 endedAt(执行结束)", typeof timeState.endedAt === "number" && timeState.endedAt >= t0, String(timeState.endedAt));
	check("startedAt 不是展开时才打(保持原值)", timeState.startedAt === t0);

	// ---------------------------------------------------------- medium
	console.log("medium:");
	const medCfg = { ...cfg, display: "medium" };
	const medState = {};
	const medCtx = makeContext("t1", medState, { args: { command: "npm test" }, isPartial: false });
	const medComp = render.renderCallSlot("bash", base, medCtx.args, theme, medCtx, medCfg);
	const medCall = medComp.render(80);
	check("medium 调用块 3 行(上垫 + 内容 + 下垫)", medCall.length === 3, `${medCall.length}: ${JSON.stringify(medCall)}`);
	check("medium 调用块含输入", medCall[1].includes("call:npm test"), medCall[1]);
	const medResult = render.renderResultSlot("bash", base, okResult, { expanded: false, isPartial: false }, theme, medCtx, medCfg).render(80);
	check("medium 成功零输出", medResult.length === 0 && medComp.render(80).length === 3);

	// 摘要: 条目数(列表类工具) + 耗时 + timeout
	const grepResult = {
		content: [{ type: "text", text: "a.ts:1: foo\nb.ts:2: bar\n\n[100 matches limit reached. Use limit=200 for more]" }],
	};
	const entryState = {};
	const entryCtx = makeContext("md2", entryState, { args: { pattern: "foo", path: "src" }, isPartial: false });
	const entryComp = render.renderCallSlot("grep", base, entryCtx.args, theme, entryCtx, medCfg);
	render.renderResultSlot("grep", base, grepResult, { expanded: false, isPartial: false }, theme, entryCtx, medCfg);
	const entryOut = entryComp.render(80);
	check("medium 摘要报 entries(跳过限量提示)", entryOut.some((l) => l.includes("2 entries")), JSON.stringify(entryOut));
	check("medium 摘要不显示具体结果", !entryOut.some((l) => l.includes("a.ts:1:")), JSON.stringify(entryOut));

	const timedState = {};
	const timedCtx = makeContext("md3", timedState, { args: { command: "npm test", timeout: 30 }, isPartial: true, executionStarted: true });
	render.renderCallSlot("bash", base, timedCtx.args, theme, timedCtx, medCfg);
	timedState.startedAt = Date.now() - 3400;
	const timedCtx2 = makeContext("md3", timedState, { args: { command: "npm test", timeout: 30 }, isPartial: false, executionStarted: true });
	const timedComp = render.renderCallSlot("bash", base, timedCtx2.args, theme, timedCtx2, medCfg);
	render.renderResultSlot("bash", base, okResult, { expanded: false, isPartial: false }, theme, timedCtx2, medCfg);
	const timedOut = timedComp.render(80);
	check("medium 摘要含耗时与 timeout", timedOut.some((l) => l.includes("3.4s") && l.includes("timeout 30s")), JSON.stringify(timedOut));

	// 执行中: 耗时已经出现且每秒刷新; 结束后清掉定时器
	const liveState = {};
	const liveCtx = makeContext("md4", liveState, { args: { command: "sleep 5" }, isPartial: true, executionStarted: true });
	const liveComp = render.renderCallSlot("bash", base, liveCtx.args, theme, liveCtx, medCfg);
	liveState.startedAt = Date.now() - 2500;
	render.renderResultSlot("bash", base, { content: [{ type: "text", text: "partial" }] }, { expanded: false, isPartial: true }, theme, liveCtx, medCfg);
	const liveOut = liveComp.render(80);
	check("执行中就显示耗时(无需等结束)", liveOut.some((l) => l.includes("2.5s")), JSON.stringify(liveOut));
	check("执行中挂上了每秒刷新的定时器", liveState.interval !== undefined, String(liveState.interval));
	render.renderResultSlot("bash", base, okResult, { expanded: false, isPartial: false }, theme, liveCtx, medCfg);
	check("结束后清掉定时器", liveState.interval === undefined, String(liveState.interval));

	// write: medium 只留调用行, 不显示写入的正文
	const writeCtx = makeContext("md5", {}, { args: { file_path: "a.ts", content: "SECRET_CONTENT" }, isPartial: false });
	const writeOut = render.renderCallSlot("write", base, writeCtx.args, theme, writeCtx, medCfg).render(80);
	check(
		"write medium 只留调用行(不显示正文)",
		writeOut.some((l) => l.includes("write") && l.includes("a.ts")) && !writeOut.some((l) => l.includes("SECRET_CONTENT")),
		JSON.stringify(writeOut),
	);

	const medErrState = {};
	const medErrCtx = makeContext("t2", medErrState, { isError: true, isPartial: false, args: { path: "x" } });
	const medErrComp = render.renderCallSlot("read", base, medErrCtx.args, theme, medErrCtx, medCfg);
	render.renderResultSlot("read", base, errResult, { expanded: false, isPartial: false }, theme, medErrCtx, medCfg);
	const medErrOut = medErrComp.render(80);
	check("medium 失败多一行错误摘要", medErrOut.length === 4 && medErrOut.some((l) => l.includes("Command exited with code 1")), `${medErrOut.length}`);

	// medium 展开 = 原版全量
	const medExpState = {};
	const medExpCtx = makeContext("t3", medExpState, { expanded: true, isPartial: false, args: { pattern: "pat" } });
	const medExpComp = render.renderCallSlot("grep", base, medExpCtx.args, theme, medExpCtx, medCfg);
	render.renderResultSlot("grep", base, okResult, { expanded: true, isPartial: false }, theme, medExpCtx, medCfg);
	const medExpOut = medExpComp.render(80);
	check("medium 展开含输出", medExpOut.some((l) => l.includes("out line")), JSON.stringify(medExpOut));

	// ---------------------------------------------------------- default
	console.log("default:");
	const defCfg = { ...cfg, display: "default" };
	const defState = {};
	const defCtx = makeContext("t1", defState, { args: { command: "npm test" }, isPartial: false });
	const defComp = render.renderCallSlot("bash", base, defCtx.args, theme, defCtx, defCfg);
	render.renderResultSlot("bash", base, okResult, { expanded: false, isPartial: false }, theme, defCtx, defCfg);
	const defOut = defComp.render(80);
	check("default = 原版调用 + 输出", defOut.length === 4 && defOut.some((l) => l.includes("out line")), JSON.stringify(defOut));

	// ---------------------------------------------------------- 批次:混合非内建工具
	console.log("batch:");
	state.noteAssistantMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", id: "m1", name: "mcp__foo" },
			{ type: "toolCall", id: "t6", name: "bash" },
			{ type: "toolCall", id: "t7", name: "ls" },
		],
	});
	check("MCP 调用不计入汇总", state.batchSummary("m1").total === 2, JSON.stringify(state.batchSummary("m1")));
	check(
		"汇总行归属第一个内建调用",
		state.isSummaryOwner("m1") === false && state.isSummaryOwner("t6") === true && state.isSummaryOwner("t7") === false,
	);

	// 单个调用的批次
	state.noteAssistantMessage({ role: "assistant", content: [{ type: "toolCall", id: "s1", name: "bash" }] });
	check("单工具语法 1 tool", render.renderCallSlot("bash", base, { command: "x" }, theme, makeContext("s1", {}, {}), cfg).render(80)[0].includes("1 tool"));

	// ---------------------------------------------------------- 自带外壳与 lastComponent
	console.log("shell:");
	let selfSeenLast;
	const selfBase = {
		renderShell: "self",
		renderCall: (args, theme2, ctx) => {
			selfSeenLast = ctx.lastComponent;
			return new Text(`self call ${args.command}`, 0, 0);
		},
		renderResult: (result, options, theme2, ctx) => new Text("self result", 0, 0),
	};
	const selfState = {};
	const selfCtx = makeContext("x1", selfState, { args: { command: "q" }, isPartial: false });
	const selfCall1 = render.renderCallSlot("edit", selfBase, selfCtx.args, theme, selfCtx, defCfg);
	const selfOut = selfCall1.render(80);
	check("自带外壳的工具不多包一层", selfOut.length === 1 && selfOut[0].includes("self call q"), JSON.stringify(selfOut));

	// medium 下自带外壳(edit)只留调用行 + 摘要: 跳过它自己的 renderCall(会连 diff 预览一起画)
	const boxSelfBase = {
		renderShell: "self",
		renderCall: (args, theme2) => {
			const box = new tui.Box(1, 1, (text) => theme2.bg("toolSuccessBg", text));
			box.addChild(new Text(`edit:${args.path}`, 0, 0));
			box.addChild(new Text("PREVIEW", 0, 0));
			return box;
		},
		renderResult: () => new Text("self result", 0, 0),
	};
	const editCfg = { ...cfg, display: "medium" };
	const editState = {};
	const editCtx = makeContext("ed1", editState, { args: { path: "a.ts" }, isPartial: false, executionStarted: true });
	const editComp = render.renderCallSlot("edit", boxSelfBase, editCtx.args, theme, editCtx, editCfg);
	editState.startedAt = Date.now() - 1200;
	render.renderResultSlot("edit", boxSelfBase, okResult, { expanded: false, isPartial: false }, theme, editCtx, editCfg);
	const editOut = editComp.render(80);
	const editCallLine = editOut.find((l) => l.includes("a.ts"));
	const editMetaLine = editOut.find((l) => l.includes("1.2s"));
	check("edit medium 不画自带外壳里的细节(diff)", !editOut.some((l) => l.includes("PREVIEW")), JSON.stringify(editOut));
	check("edit medium 摘要进同一个 Box(带背景)", editOut.every((l) => l.includes("toolSuccessBg")), JSON.stringify(editOut));
	check(
		"edit medium 调用行与摘要左对齐",
		editCallLine?.startsWith("[toolSuccessBg] <toolTitle>**edit**</> <accent>a.ts") === true && editMetaLine?.startsWith("[toolSuccessBg] <muted>1.2s") === true,
		JSON.stringify({ editCallLine, editMetaLine }),
	);
	// default 档仍用自带外壳(含 diff)
	const editDefOut = render.renderCallSlot("edit", boxSelfBase, { path: "b.ts" }, theme, makeContext("ed2", {}, { args: { path: "b.ts" } }), defCfg).render(80);
	check("edit default 仍用自带外壳(含 diff)", editDefOut.some((l) => l.includes("PREVIEW")), JSON.stringify(editDefOut));

	let seenLast;
	const reuseBase = {
		renderCall: (args, theme2, ctx) => {
			seenLast = ctx.lastComponent;
			const comp = ctx.lastComponent ?? new Text("", 0, 0);
			comp.setText("built call");
			return comp;
		},
		renderResult: (result, options, theme2, ctx) => {
			const comp = ctx.lastComponent ?? new Text("", 0, 0);
			comp.setText("built result");
			return comp;
		},
	};
	const reuseState = {};
	const reuseCtx = makeContext("x2", reuseState, { args: {}, isPartial: false });
	const reuseComp1 = render.renderCallSlot("bash", reuseBase, {}, theme, reuseCtx, defCfg);
	const inner1 = reuseState.__mtCallComponent;
	render.renderResultSlot("bash", reuseBase, okResult, { expanded: false, isPartial: false }, theme, reuseCtx, defCfg);
	render.renderCallSlot("bash", reuseBase, {}, theme, reuseCtx, defCfg);
	const inner2 = reuseState.__mtCallComponent;
	check(
		"lastComponent 递回内建自己的组件",
		seenLast === inner1 && inner1 === inner2 && inner1 !== undefined,
	);
	check("外壳包住内建组件", reuseComp1.render(80).length === 4 && reuseComp1.render(80)[1].includes("built call"), JSON.stringify(reuseComp1.render(80)));
	check("自带外壳首次 lastComponent 为空", selfSeenLast === undefined);

	// ---------------------------------------------------------- 面板
	console.log("panel:");
	const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
	// 假 theme 用 <fg>..</> 与 [bg]..[/] 表示颜色, 去掉后才好断文字位置
	const plain = (s) => stripAnsi(s).replace(/<[^>]*>/g, "").replace(/\[[^\]]*\]/g, "");
	// applySetting 直接测(显示文案反查配置值)
	const panelCfg = configMod.defaultConfig();
	panelMod.applySetting(panelCfg, "display", "low (batch names)");
	check("applySetting 反查档位标签", panelCfg.display === "low");
	panelMod.applySetting(panelCfg, "expandStyle", "default (native preview)");
	check("applySetting 反查展开形态", panelCfg.expandStyle === "default");
	panelMod.applySetting(panelCfg, "low.nameLimit", "5");
	check("applySetting 解析名字上限", panelCfg.low.nameLimit === 5);
	panelMod.applySetting(panelCfg, "medium.showErrorLine", "off");
	check("applySetting 关错误行", panelCfg.medium.showErrorLine === false);
	panelMod.applySetting(panelCfg, "hoverHighlight", "off");
	check("applySetting 关 hover", panelCfg.hoverHighlight === false);
	check("applySetting 落盘", readFileSync(configFile, "utf8").includes('"expandStyle": "default"'));

	// 面板本体
	let capturedPanel;
	const panelTui = { renders: 0, requestRender() { this.renders += 1; } };
	const panelCfg2 = configMod.defaultConfig();
	let applied = 0;
	let panelClosed = 0;
	const panelUi = {
		custom: (factory) => {
			capturedPanel = factory(panelTui, theme, {}, () => {
				panelClosed += 1;
			});
			return Promise.resolve();
		},
		notify: () => {},
		setToolsExpanded: () => {},
	};
	await panelMod.openSettingsPanel({ mode: "tui", hasUI: true, ui: panelUi }, panelCfg2, () => { applied += 1; });
	const lines = capturedPanel.render(80).map(stripAnsi);
	check("面板第一行是边框", /^─+$/.test(plain(lines[0])), JSON.stringify(lines[0]));
	check("面板最后一行是边框", /^─+$/.test(plain(lines[lines.length - 1])), JSON.stringify(lines[lines.length - 1]));
	check("面板有标题", lines.some((l) => l.includes("Tool Display Settings")), JSON.stringify(lines.slice(0, 3)));
	check("面板页脚给出配置路径", lines.some((l) => l.includes(configMod.shortenHomePath(configFile))), JSON.stringify(lines.slice(-3)));
	check("搜索框图标是 ⌕", lines.some((l) => l.trim().startsWith("⌕")), JSON.stringify(lines.slice(0, 4)));
	check(
		"列出全部设置项",
		["Display density", "Expanded calls", "Low name limit", "Medium error line", "Hover highlight"].every((label) => lines.some((l) => l.includes(label))),
		JSON.stringify(lines),
	);
	check("显示当前档位", lines.some((l) => l.includes("Display density") && l.includes("mini (batch count)")));
	check("显示当前展开形态", lines.some((l) => l.includes("Expanded calls") && l.includes("medium (call row + summary)")));

	capturedPanel.handleInput("\r"); // 进档位子菜单
	const subLines = capturedPanel.render(80).map(plain);
	check(
		"档位是子菜单: 标题换成行标签",
		subLines.some((l) => l.includes("Display density")) && !subLines.some((l) => l.includes("Tool Display Settings")),
		JSON.stringify(subLines.slice(0, 3)),
	);
	check(
		"档位子菜单列出四档且光标预选当前值",
		["mini (batch count)", "low (batch names)", "medium (row + summary)", "default (stock)"].every((t) => subLines.some((l) => l.includes(t))) &&
			subLines.some((l) => l.includes("→ mini (batch count)")),
		JSON.stringify(subLines.slice(0, 8)),
	);
	const firstTierLine = subLines.findIndex((l) => l.includes("mini (batch count)"));
	check("档位子菜单顶部空一行", firstTierLine > 0 && subLines[firstTierLine - 1].trim() === "", JSON.stringify(subLines.slice(0, firstTierLine + 1)));
	const lastTierLine = subLines.findIndex((l) => l.includes("default (stock)"));
	check("档位子菜单底部空一行", lastTierLine > 0 && subLines[lastTierLine + 1]?.trim() === "", JSON.stringify(subLines.slice(lastTierLine)));
	capturedPanel.handleInput("\u001b[B"); // mini → low
	capturedPanel.handleInput("\r"); // 选 low
	check("选完切档并落盘", panelCfg2.display === "low" && readFileSync(configFile, "utf8").includes('"display": "low"'), panelCfg2.display);
	check("退出子菜单后标题换回面板名", capturedPanel.render(80).map(plain).some((l) => l.includes("Tool Display Settings")), JSON.stringify(capturedPanel.render(80).map(plain).slice(0, 3)));
	const afterSubmenu = capturedPanel.render(80).map(plain);
	check(
		"退出子菜单后父行摘要回刷",
		afterSubmenu.some((l) => l.includes("Display density") && l.includes("low (batch names)")),
		JSON.stringify(afterSubmenu.filter((l) => l.includes("Display density"))),
	);
	check("onApplied 回调", applied === 1);
	check("重画走 requestRender", panelTui.renders >= 1);
	capturedPanel.handleInput("\u001b"); // Esc 关面板(onCancel → done)
	check("Esc 关面板", panelClosed === 1, String(panelClosed));

	// 降级对话框(RPC 等)
	const answers = ["low (batch names)", "default (native preview)", "5", "off", "off"];
	let answerIndex = 0;
	const selectTitles = [];
	const dlgNotified = [];
	const dlgCfg = configMod.defaultConfig();
	const dlgUi = {
		select: async (title) => {
			selectTitles.push(title);
			return answers[answerIndex++];
		},
		notify: (message, type) => dlgNotified.push(`${type}:${message}`),
		setToolsExpanded: () => {},
	};
	await panelMod.openSettingsDialog({ mode: "rpc", hasUI: true, ui: dlgUi }, dlgCfg, () => {});
	check("降级对话框逐项问 5 次", selectTitles.length === 5, String(selectTitles.length));
	check("第一问带当前值", selectTitles[0].includes("Display density") && selectTitles[0].includes("mini"), selectTitles[0]);
	check(
		"降级改动生效",
		dlgCfg.display === "low" && dlgCfg.expandStyle === "default" && dlgCfg.low.nameLimit === 5 && dlgCfg.medium.showErrorLine === false && dlgCfg.hoverHighlight === false,
		JSON.stringify(dlgCfg),
	);
	check("走完给提示", dlgNotified.some((n) => n.startsWith("info") && n.includes("saved")), JSON.stringify(dlgNotified));

	// 取消即停: 已改的保留, 未问到的跳过
	const cancelCfg = configMod.defaultConfig();
	let cancelAsks = 0;
	const cancelUi = {
		select: async (title, values) => {
			cancelAsks += 1;
			return cancelAsks === 1 ? "low (batch names)" : undefined;
		},
		notify: () => {},
		setToolsExpanded: () => {},
	};
	await panelMod.openSettingsDialog({ mode: "rpc", hasUI: true, ui: cancelUi }, cancelCfg, () => {});
	check("取消即停, 已改的保留", cancelAsks === 2 && cancelCfg.display === "low" && cancelCfg.expandStyle === "medium", JSON.stringify(cancelCfg));

	check("状态文案含全部字段与完整路径", panelMod.statusText(configMod.defaultConfig()).includes("expandStyle=") && panelMod.statusText(configMod.defaultConfig()).includes(configFile));

	// ---------------------------------------------------------- index 接线
	console.log("wiring:");
	const registeredDefs = [];
	const handlers = {};
	const commands = {};
	const fakePi = {
		registerTool: (d) => registeredDefs.push(d),
		on: (ev, h) => {
			(handlers[ev] ??= []).push(h);
			return () => {};
		},
		registerCommand: (name, def) => {
			commands[name] = def;
		},
		getActiveTools: () => ["read", "bash", "edit"],
	};
	ext.default(fakePi);
	check("注册 /tool-display-settings 命令", typeof commands["tool-display-settings"]?.handler === "function");
	check("事件监听已挂", !!handlers.message_update && !!handlers.tool_execution_start && !!handlers.tool_execution_end);

	let widgetSet = false;
	handlers.session_start[0](null, {
		cwd: "/proj",
		isProjectTrusted: () => true,
		mode: "tui",
		sessionManager: { getBranch: () => [], getLeafId: () => "leaf1" },
		ui: {
			setWidget: () => {
				widgetSet = true;
			},
		},
	});
	check(
		"只覆盖启用的内建工具",
		registeredDefs.length === 3 && registeredDefs.every((d) => ["read", "bash", "edit"].includes(d.name)),
		JSON.stringify(registeredDefs.map((d) => d.name)),
	);
	check("renderShell 统一 self", registeredDefs.every((d) => d.renderShell === "self"));
	check("execute 保留", registeredDefs.every((d) => typeof d.execute === "function"));
	check("hover widget 已挂", widgetSet);

	// 同一运行时重复 session_start 不得重复注册
	handlers.session_start[0](null, {
		cwd: "/proj",
		isProjectTrusted: () => true,
		mode: "print",
		sessionManager: { getBranch: () => [], getLeafId: () => "leaf1" },
		ui: {},
	});
	check("同运行时去重", registeredDefs.length === 3, String(registeredDefs.length));

	// /reload 回归:模块状态被缓存复用但运行时重建 -- 新 API 对象必须重新注册
	const registered2 = [];
	const handlers2 = {};
	const fakePi2 = {
		registerTool: (d) => registered2.push(d),
		on: (ev, h) => {
			(handlers2[ev] ??= []).push(h);
			return () => {};
		},
		registerCommand: () => {},
		getActiveTools: () => ["read", "bash", "edit"],
	};
	ext.default(fakePi2);
	handlers2.session_start[0](null, {
		cwd: "/proj",
		isProjectTrusted: () => true,
		mode: "print",
		sessionManager: { getBranch: () => [], getLeafId: () => "leaf2" },
		ui: {},
	});
	check("reload 后新运行时重新注册", registered2.length === 3, String(registered2.length));
	check("reload 后定义仍是 self 外壳", registered2.every((d) => d.renderShell === "self"));
	// 兑底:before_agent_start 也会补注册(上面已注册过则无副作用)
	handlers2.before_agent_start[0]({});
	check("before_agent_start 兑底不重复注册", registered2.length === 3, String(registered2.length));

	const notified = [];
	const expandedCalls = [];
	const cmdCtx = {
		mode: "print",
		hasUI: false,
		ui: {
			notify: (m, t) => notified.push(`${t}:${m}`),
			setToolsExpanded: (v) => expandedCalls.push(v),
			select: async () => undefined,
		},
	};
	const sharedBefore = JSON.stringify(configMod.getSharedConfig());
	await commands["tool-display-settings"].handler("mini", cmdCtx);
	check("带参数不改配置, 只给用法提示", notified.length === 1 && notified[0].startsWith("warning"), JSON.stringify(notified));
	check("带参数不改配置", JSON.stringify(configMod.getSharedConfig()) === sharedBefore);
	check("带参数不切全局展开", expandedCalls.length === 0, JSON.stringify(expandedCalls));
	notified.length = 0;
	await commands["tool-display-settings"].handler("", cmdCtx);
	check("无 UI 时报当前状态", notified.some((n) => n.startsWith("info") && n.includes("display=")), JSON.stringify(notified));

	// 鼠标补丁:移出清除
	const protoHolder = {
		handleMouseEvent(raw) {
			return "orig";
		},
	};
	const fakeTui = Object.create(protoHolder);
	state.installMousePatch(fakeTui);
	state.hoverRow("t1");
	check("hover 点亮", state.isRowHovered("t1") === true);
	fakeTui.handleMouseEvent({ x: 1, y: 1 });
	check("鼠标事件先清 hover(移出即熄灭)", state.isRowHovered("t1") === false);
	check("补丁不改变原返回值", fakeTui.handleMouseEvent({}) === "orig");

	// /reload 回归:旧包装器必须动态读取当前模块的清除回调
	let sinkCalls = 0;
	protoHolder.__toolDisplayHoverSink = () => {
		sinkCalls += 1;
	};
	state.hoverRow("t1");
	fakeTui.handleMouseEvent({});
	check(
		"包装器动态读取清除回调(reload 不失效)",
		sinkCalls === 1 && state.isRowHovered("t1") === true,
		`sink=${sinkCalls} hovered=${state.isRowHovered("t1")}`,
	);
	state.installMousePatch(fakeTui);
	state.hoverRow("t1");
	fakeTui.handleMouseEvent({});
	check("重新安装后仍清除", state.isRowHovered("t1") === false);

	// 第二通道:借 requestRender 的 this 拿真实实例再补丁
	const proto2 = {
		handleMouseEvent() {
			return "m2";
		},
		requestRender() {
			return "rr";
		},
	};
	const fakeTui2 = Object.create(proto2);
	const fakeUi = {
		requestRender() {
			return "rr";
		},
	};
	state.armInstanceCapture(fakeUi);
	const rr = fakeUi.requestRender.call(fakeTui2);
	check("requestRender 通道装上补丁", rr === "rr" && proto2.__toolDisplayMousePatch === true);
	state.hoverRow("t1");
	fakeTui2.handleMouseEvent({});
	check("第二通道的补丁同样清除 hover", state.isRowHovered("t1") === false);


	return failures();
}
