/**
 * unit.test.mjs -- 文案 / 配置 / 计量 / 渲染 / 面板 / 事件接线
 *
 * 全部走与线上一致的加载链路(jiti + pi 别名). 面板与事件接线用假 ExtensionAPI /
 * ui context 驱动(真实加载链路见 lifecycle.test.mjs).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
	copyExtensionTo,
	emit,
	isolatedAgentDir,
	loadConfigModule,
	loadModules,
	makeApi,
	makeChecker,
	makeContext,
	makeTheme,
	makeUi,
	plainTheme,
	sleep,
	stripAnsi,
	useFakeClock,
} from "./harness.mjs";

const ENTER = "\r";
const DOWN = "\u001b[B";
const ESC = "\u001b";

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const totals = (input = 0, output = 0, extra = {}) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: 0,
	estimated: false,
	...extra,
});

export async function run() {
	const { check, failures } = makeChecker();

	const root = isolatedAgentDir("unit");
	rmSync(root, { recursive: true, force: true });
	const agentDir = join(root, "agent");
	const workDir = join(root, "extension");
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// 从临时副本加载: 包里任何"就地运行"的副作用都不会留在真实包目录
	copyExtensionTo(workDir);

	const { config, i18n, meter, render, panel, index } = await loadModules(workDir);
	const configFile = join(agentDir, "token-meter.json");
	const mZh = i18n.MESSAGES.zh;
	const mEn = i18n.MESSAGES.en;

	try {
		// ---------------------------------------------------------- 文案
		console.log("i18n:");
		check("zh 文案", mZh.settings.live.label === "动态行显示" && mZh.settings.resultInTranscript.label === "结算行显示");
		check("en 文案", mEn.settings.live.label === "Live line" && mEn.settings.resultInTranscript.label === "Result line");
		const tableKeys = (obj, prefix = "") =>
			Object.entries(obj)
				.flatMap(([key, value]) => (value && typeof value === "object" ? tableKeys(value, `${prefix}${key}.`) : [`${prefix}${key}`]))
				.sort();
		check("zh/en 两套表键集合完全一致", sameJson(tableKeys(mZh), tableKeys(mEn)), JSON.stringify(tableKeys(mZh)));
		check("面板标题两套都在", mZh.settingsTitle === "Token Meter 设置" && mEn.settingsTitle === "Token Meter Settings");
		check("语言项行标签统一为 Language", mZh.settings.language.label === "Language" && mEn.settings.language.label === "Language");
		check("动画名两套都有", mZh.animationLabels.merge === "合并" && mEn.animationLabels.merge === "Merge");
		check("显式语言直接生效", i18n.resolveLang("zh") === "zh" && i18n.resolveLang("en") === "en");

		const savedEnv = {
			LC_ALL: process.env.LC_ALL,
			LC_MESSAGES: process.env.LC_MESSAGES,
			LANG: process.env.LANG,
			LANGUAGE: process.env.LANGUAGE,
		};
		process.env.LC_ALL = "";
		process.env.LC_MESSAGES = "";
		process.env.LANGUAGE = "";
		process.env.LANG = "zh_CN.UTF-8";
		check("auto 跟随系统区域(zh)", i18n.resolveLang("auto") === "zh");
		process.env.LANG = "en_US.UTF-8";
		check("auto 跟随系统区域(en)", i18n.resolveLang("auto") === "en");
		process.env.LANG = "";
		check("没有环境变量时 auto 也有确定结果", ["zh", "en"].includes(i18n.resolveLang("auto")));
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}

		// ---------------------------------------------------------- 配置
		console.log("config:");
		const defaults = config.defaultConfig();
		check("默认 language = auto", defaults.language === "auto");
		check("默认动画 = merge", defaults.animation === "merge");
		check(
			"默认动态行只显示箭头+速度+耗时",
			defaults.liveShowArrows === true &&
				defaults.liveShowCache === false &&
				defaults.liveShowCost === false &&
				defaults.liveShowTps === true &&
				defaults.liveShowDuration === true &&
				defaults.liveShowModel === false &&
				defaults.liveShowThinking === false,
			JSON.stringify(defaults),
		);
		check(
			"默认结算行全开(含新增的箭头与缓存)",
			defaults.showArrows === true && defaults.showCache === true && defaults.showCost === true && defaults.showModel === true && defaults.showThinking === true,
		);

		const full = config.normalizeConfig({
			live: false,
			animation: "merge",
			showArrows: false,
			showCache: true,
			showCost: false,
			showTps: false,
			showDuration: false,
			liveShowArrows: true,
			liveShowCache: true,
			liveShowCost: false,
			liveShowTps: false,
			liveShowDuration: true,
			showModel: false,
			showThinking: false,
			liveShowModel: true,
			liveShowThinking: true,
			resultInTranscript: false,
			refreshMs: 200,
			language: "en",
		});
		check(
			"归一化:合法字段全部采纳",
			sameJson(full, {
				live: false,
				animation: "merge",
				showArrows: false,
				showCache: true,
				showCost: false,
				showTps: false,
				showDuration: false,
				liveShowArrows: true,
				liveShowCache: true,
				liveShowCost: false,
				liveShowTps: false,
				liveShowDuration: true,
				showModel: false,
				showThinking: false,
				liveShowModel: true,
				liveShowThinking: true,
				resultInTranscript: false,
				refreshMs: 200,
				language: "en",
			}),
			JSON.stringify(full),
		);
		const legacy = config.normalizeConfig({ showCost: false, showTps: false });
		check("旧配置兼容:只有 showCost/showTps 时动态行跟随", legacy.liveShowCost === false && legacy.liveShowTps === false);
		check("有独立键时以独立键为准", config.normalizeConfig({ showCost: false, liveShowCost: true }).liveShowCost === true);
		check(
			"坏字段一律退回默认",
			sameJson(
				config.normalizeConfig({ live: "yes", animation: "wobble", refreshMs: "fast", language: "fr", resultInTranscript: 1 }),
				defaults,
			),
		);
		check(
			"刷新间隔吸附到档位",
			config.snapRefreshMs(100) === 80 && config.snapRefreshMs(190) === 200 && config.snapRefreshMs(9999) === 500,
		);

		check("配置只有一个位置: agent 目录", config.configPath() === configFile, config.configPath());
		check(
			"页脚路径把主目录缩成 ~",
			config.shortenHomePath(join(homedir(), "agent", "token-meter.json")) === join("~", "agent", "token-meter.json"),
			config.shortenHomePath(join(homedir(), "agent", "token-meter.json")),
		);
		const outsideHome = `${homedir()}-other${sep}x.json`;
		check("前缀相同但不是子路径时不缩", config.shortenHomePath(outsideHome) === outsideHome, config.shortenHomePath(outsideHome));
		check("耗时开关默认两行都显示", config.defaultConfig().showDuration === true && config.defaultConfig().liveShowDuration === true);
		check(
			"normalizeConfig 认耗时开关",
			config.normalizeConfig({ showDuration: false, liveShowDuration: false }).showDuration === false &&
				config.normalizeConfig({ showDuration: false, liveShowDuration: false }).liveShowDuration === false,
		);

		// 首次使用: 落一份默认配置, 让用户找得到这个文件
		rmSync(configFile, { force: true });
		config.ensureConfigFile();
		check("首次使用落一份默认配置", existsSync(configFile) && readFileSync(configFile, "utf8").includes('"refreshMs": 120'));

		// 早期位置(扩展目录里的 config.json): 第一次读时搬到正式位置, 之后不再参考
		const legacyDir = join(root, "legacy-package");
		copyExtensionTo(legacyDir);
		writeFileSync(join(legacyDir, "config.json"), `${JSON.stringify({ live: false, language: "en" }, null, 2)}\n`);
		rmSync(configFile, { force: true });
		const legacyConfig = await loadConfigModule(legacyDir);
		const migrated = legacyConfig.loadConfig();
		check("旧位置的配置会被读到", migrated.live === false && migrated.language === "en");
		check("旧配置被搬到正式位置", existsSync(configFile) && readFileSync(configFile, "utf8").includes('"live": false'));
		check("搬完删掉旧文件", !existsSync(join(legacyDir, "config.json")));
		check("旧位置不再作为路径", legacyConfig.configPath() === configFile, legacyConfig.configPath());

		writeFileSync(configFile, JSON.stringify({ live: false, refreshMs: 100 }));
		const loaded = config.loadConfig();
		check("读文件:采纳已知字段, 补齐其余默认", loaded.live === false && loaded.refreshMs === 80 && loaded.animation === "merge");
		config.saveConfig({ ...loaded, language: "zh" });
		const savedRaw = readFileSync(configFile, "utf8");
		check("写盘:归一化后落盘(吸附值一并写回)", savedRaw.includes('"refreshMs": 80') && savedRaw.includes('"language": "zh"'));

		writeFileSync(configFile, `${JSON.stringify({ ...config.defaultConfig(), myCustom: 42 }, null, 2)}\n`);
		config.saveConfig({ ...config.loadConfig(), language: "en" });
		const patched = JSON.parse(readFileSync(configFile, "utf8"));
		check("写盘是 patch: 手写的其它字段保留", patched.myCustom === 42 && patched.language === "en", JSON.stringify(patched));

		writeFileSync(configFile, "{ broken");
		check("坏 JSON 退回默认", config.loadConfig().live === true && config.loadConfig().language === "auto");

		// ---------------------------------------------------------- 计量引擎
		console.log("meter:");
		const clock = useFakeClock();
		const model = { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };

		check("usageToTotals(undefined) 全零", sameJson(meter.usageToTotals(undefined), totals()));
		check("promptSide 含缓存读写", meter.promptSide(totals(10, 0, { cacheRead: 5, cacheWrite: 2 })) === 17);
		check("CJK ≈ 0.9 token/字", meter.estimateOutputTokens({ content: [{ type: "text", text: "你好世界" }] }) === 4);
		check("非 CJK ≈ 4 字符/token", meter.estimateOutputTokens({ content: [{ type: "text", text: "abcdefgh" }] }) === 2);
		const toolEstimate = meter.estimateOutputTokens({
			content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } }],
		});
		check("工具调用带结构开销(>40)", toolEstimate > 40, String(toolEstimate));
		check(
			"按每百万单价计价",
			Math.abs(meter.computeCost(model, totals(1000, 2000)) - 0.033) < 1e-9,
			String(meter.computeCost(model, totals(1000, 2000))),
		);
		check(
			"1h 缓存写按 2 倍输入计价",
			Math.abs(meter.computeCost(model, totals(0, 0, { cacheWrite: 1000 }), 1000) - (3 * 2 * 1000) / 1e6) < 1e-9,
		);
		const tiered = { cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, tiers: [{ inputTokensAbove: 100, input: 10, output: 20, cacheRead: 1, cacheWrite: 10 }] } };
		check("分档定价:超过阈值换档", Math.abs(meter.computeCost(tiered, totals(200, 0)) - (10 * 200) / 1e6) < 1e-9);
		check("分档定价:未超阈值用基础档", Math.abs(meter.computeCost(tiered, totals(50, 0)) - (1 * 50) / 1e6) < 1e-9);

		const empty = new meter.Meter();
		check("空轮不产出结算行", empty.endRound() === null);
		check("没有轮次时 active=false", empty.active === false);

		const m1 = new meter.Meter();
		m1.beginRound();
		check("beginRound 后 active=true", m1.active === true);
		m1.beginAssistantMessage({ id: "mimo", name: "mimo" }, "high");
		clock.advance(1000);
		const partial = { role: "assistant", content: [{ type: "text", text: "hello world" }] };
		m1.updatePartial(partial, { input: 100, cacheRead: 900, cacheWrite: 0 }, model);
		const liveMid = m1.liveTotals();
		check("未上报时输入侧按请求时刻估算", liveMid.input === 100 && liveMid.cacheRead === 900);
		check("未上报时输出侧按内容估算", liveMid.output === meter.estimateOutputTokens(partial) && liveMid.estimated === true);
		check("流式阶段就给出当前模型信息", m1.currentInfo()?.model.id === "mimo" && m1.currentInfo()?.thinkingLevel === "high");

		clock.advance(500);
		m1.endAssistantMessage(
			{
				role: "assistant",
				stopReason: "stop",
				content: partial.content,
				usage: { input: 1000, output: 200, totalTokens: 1200, cost: { total: 0.01 } },
			},
			model,
		);
		const settled = m1.liveTotals();
		check(
			"message_end 用 provider 数字覆盖估算",
			settled.input === 1000 && settled.output === 200 && settled.cost === 0.01 && settled.estimated === false,
		);
		check("tps = 输出 ÷ 纯生成时长(500ms)", Math.abs(m1.tps() - 400) < 1e-6, String(m1.tps()));
		m1.markTurn();
		m1.recordOutcome("aborted");
		m1.recordOutcome("completed");
		m1.foldToolUsage({ input: 50, output: 10, totalTokens: 60, cost: { total: 0.002 } });
		m1.foldCompactionUsage({ input: 5, output: 5, totalTokens: 10, cost: { total: 0.0005 } });
		clock.advance(0);
		const summary = m1.endRound();
		check("结算:工具内调用与压缩消耗并入本轮", summary.totals.input === 1055 && summary.totals.output === 215, JSON.stringify(summary.totals));
		check("结算:模型与思考强度按出现顺序", summary.models[0].id === "mimo" && summary.thinkingLevels[0] === "high");
		check("结算:结果取更严重的那个", summary.outcome === "aborted");
		check(
			"结算:turns / messages / genMs / tps",
			summary.turns === 1 && summary.messages === 1 && summary.genMs === 500 && Math.abs(summary.tps - 400) < 1e-6,
		);
		check("结算:压缩标记与工具用量明细", summary.compacted === true && summary.toolUsage.totalTokens === 70);
		check("结算后清空当前轮", m1.active === false && m1.endRound() === null);

		const m2 = new meter.Meter();
		m2.beginRound();
		m2.beginAssistantMessage({ id: "x", name: "x" }, "off");
		m2.updatePartial(partial, { input: 700, cacheRead: 0, cacheWrite: 0 }, model);
		m2.endAssistantMessage({ role: "assistant", stopReason: "stop", content: [], usage: { output: 500, totalTokens: 500 } }, model);
		const onlyOutput = m2.liveTotals();
		check("provider 只报输出时保留输入侧估算", onlyOutput.input === 700 && onlyOutput.output === 500 && onlyOutput.estimated === true);

		const m3 = new meter.Meter();
		m3.beginRound();
		m3.beginAssistantMessage({ id: "x", name: "x" }, "low");
		m3.updatePartial(partial, { input: 300, cacheRead: 0, cacheWrite: 0 }, model);
		clock.advance(250);
		m3.endAssistantMessage({ role: "assistant", stopReason: "aborted", content: partial.content }, model);
		const aborted = m3.endRound();
		check("中断且无 usage 时沿用估算并标记", aborted.totals.estimated === true && aborted.totals.input === 300, JSON.stringify(aborted.totals));
		check("中断写入 aborted", aborted.outcome === "aborted");

		const m4 = new meter.Meter();
		m4.beginRound();
		check("abandonRound 报告曾有轮次", m4.abandonRound() === true);
		check("abandon 之后 active=false", m4.active === false && m4.abandonRound() === false);

		// 本轮耗时: 从用户发出消息(before_agent_start)算起, 与 tps 用的纯生成时长无关
		const m5 = new meter.Meter();
		m5.markPromptSubmitted();
		check("没开轮时已耗时为 0", m5.elapsedMs() === 0);
		clock.advance(90_000); // 发出消息到 agent 启动之间的间隔也要算进去
		m5.beginRound();
		check("耗时起点是发出消息的时刻", m5.elapsedMs() === 90_000, String(m5.elapsedMs()));
		clock.advance(10_000);
		check("已耗时跟着走", m5.elapsedMs() === 100_000);
		m5.beginAssistantMessage({ id: "x", name: "x" }, "off");
		m5.endAssistantMessage({ role: "assistant", stopReason: "stop", content: [], usage: { output: 10, totalTokens: 10 } }, model);
		const timed = m5.endRound();
		check("结算:完整耗时从发出消息算起", timed.durationMs === 100_000, String(timed.durationMs));

		const m6 = new meter.Meter();
		m6.markPromptSubmitted();
		m6.beginRound();
		clock.advance(5_000);
		m6.markPromptSubmitted(); // 排队消息: 并入本轮, 不重置起点
		clock.advance(5_000);
		check("排队消息不重置耗时起点", m6.elapsedMs() === 10_000, String(m6.elapsedMs()));
		m6.abandonRound();
		clock.restore();

		// ---------------------------------------------------------- 渲染
		console.log("render:");
		check(
			"formatTokens 紧凑写法",
			[0, 999, 1234, 12345, 1234567].map(render.formatTokens).join(",") === "0,999,1.2k,12k,1.2M",
			[0, 999, 1234, 12345, 1234567].map(render.formatTokens).join(","),
		);
		check(
			"formatCost 有效数字",
			render.formatCost(0) === "$0" &&
				render.formatCost(0.0000536) === "$0.000054" &&
				render.formatCost(0.0042) === "$0.0042" &&
				render.formatCost(0.43) === "$0.43" &&
				render.formatCost(43) === "$43.0",
			[0, 0.0000536, 0.0042, 0.43, 43].map(render.formatCost).join(","),
		);
		check("formatTps 小值一位小数, 数字与单位间无空格", render.formatTps(6.44) === "6.4tok/s" && render.formatTps(44.6) === "45tok/s");
		check(
			"formatDuration 复合两级, 单位自适应",
			render.formatDuration(47_000) === "47s" &&
				render.formatDuration(212_000) === "3m32s" &&
				render.formatDuration(7_500_000) === "2h05m",
			[47_000, 212_000, 7_500_000].map(render.formatDuration).join(","),
		);
		check(
			"formatDuration 低位为 0 就省掉, 不足两位补零",
			render.formatDuration(0) === "0s" &&
				render.formatDuration(59_999) === "59s" &&
				render.formatDuration(180_000) === "3m" &&
				render.formatDuration(185_000) === "3m05s" &&
				render.formatDuration(7_200_000) === "2h",
			[0, 59_999, 180_000, 185_000, 7_200_000].map(render.formatDuration).join(","),
		);
		check("formatCache 非零才显示", render.formatCache(totals()) === undefined);
		check("formatCache R/W 紧凑", render.formatCache(totals(0, 0, { cacheRead: 13_400_000, cacheWrite: 1200 })) === "R13.4M W1.2k");
		check(
			"formatModels 多模型用箭头",
			render.formatModels({ models: [{ id: "a" }] }, "?") === "a" &&
				render.formatModels({ models: [{ id: "a" }, { id: "b" }] }, "?") === "a→b" &&
				render.formatModels({ models: [] }, "未知模型") === "未知模型",
		);

		const roundSummary = {
			totals: totals(286_000, 1200, { cacheRead: 13_400_000, cost: 0.0025 }),
			models: [{ id: "mimo", name: "mimo" }],
			thinkingLevels: ["high"],
			outcome: "completed",
			turns: 2,
			messages: 2,
			durationMs: 212_000,
			genMs: 21_000,
			tps: 57.14,
			toolUsage: null,
			compacted: false,
		};
		const cfgEn = { ...config.defaultConfig(), language: "en" };
		const line = render.buildResultLine(roundSummary, cfgEn, plainTheme());
		check(
			"结算行 = 计数区 · 信息区(箭头与数字间无空格, 耗时跟在速度后)",
			line === "↑286k ↓1.2k R13.4M 57tok/s 3m32s · mimo (high) $0.0025",
			line,
		);
		check(
			"关掉耗时就没有耗时段",
			render.buildResultLine(roundSummary, { ...cfgEn, showDuration: false }, plainTheme()) === "↑286k ↓1.2k R13.4M 57tok/s · mimo (high) $0.0025",
			render.buildResultLine(roundSummary, { ...cfgEn, showDuration: false }, plainTheme()),
		);
		check(
			"结算行的箭头与缓存是独立开关",
			render.buildResultLine(roundSummary, { ...cfgEn, showArrows: false }, plainTheme()) === "R13.4M 57tok/s 3m32s · mimo (high) $0.0025" &&
				render.buildResultLine(roundSummary, { ...cfgEn, showCache: false }, plainTheme()) === "↑286k ↓1.2k 57tok/s 3m32s · mimo (high) $0.0025",
			`${render.buildResultLine(roundSummary, { ...cfgEn, showArrows: false }, plainTheme())} | ${render.buildResultLine(roundSummary, { ...cfgEn, showCache: false }, plainTheme())}`,
		);
		check(
			"全关时不剩分隔符也不留空段",
			render.buildResultLine(roundSummary, { ...cfgEn, showArrows: false, showCache: false, showTps: false, showDuration: false, showModel: false, showThinking: false, showCost: false }, plainTheme()) === "",
		);
		check("关掉金额后没有 $", !render.buildResultLine(roundSummary, { ...cfgEn, showCost: false }, plainTheme()).includes("$"));
		check("关掉速度后没有 tok/s", !render.buildResultLine(roundSummary, { ...cfgEn, showTps: false }, plainTheme()).includes("tok/s"));
		check(
			"信息区全关时连分隔符一起去掉",
			!render.buildResultLine(roundSummary, { ...cfgEn, showModel: false, showThinking: false, showCost: false }, plainTheme()).includes("·"),
		);
		check(
			"模型未知时的占位按语言",
			render.formatModels({ models: [] }, mEn.unknownModel) === "unknown model" &&
				render.formatModels({ models: [] }, mZh.unknownModel) === "未知模型",
		);

		const counter = new render.LiveCounter();
		const liveCfg = { ...cfgEn, animation: "steady", liveShowCost: true, liveShowTps: true };
		const info = (t, tps = 0) => ({ tps, elapsedMs: 0, totals: t });
		check("第一帧就动(至少 +1)", counter.tick(totals(100)) === true);
		check(
			"数字逐帧跳跃逼近而不是一次到位",
			counter.render(plainTheme(), liveCfg, info(totals(100))).includes("↑40"),
			counter.render(plainTheme(), liveCfg, info(totals(100))),
		);
		let frames = 1;
		while (counter.tick(totals(100))) frames += 1;
		check("追上目标所需帧数有限", frames < 20, String(frames));
		check(
			"追上后显示真实值",
			counter.render(plainTheme(), liveCfg, info(totals(100))).includes("↑100 ↓0"),
			counter.render(plainTheme(), liveCfg, info(totals(100))),
		);
		check("无变化时 tick 返回 false", counter.tick(totals(100)) === false);

		const rec = makeTheme();
		counter.reset();
		counter.tick(totals(50));
		const growing = counter.render(rec, liveCfg, info(totals(50)));
		check("增长中的一路提亮(accent)", growing.includes("[accent]↑"), growing);
		check("没变化的一路保持灰色(muted)", growing.includes("[muted]↓"), growing);
		counter.reset();
		while (counter.tick(totals(50))) {
			/* 追上 */
		}
		check("追上后不再发亮", counter.render(rec, liveCfg, info(totals(50))).includes("[muted]↑"));

		const mergeCfg = { ...liveCfg, animation: "merge" };
		counter.reset();
		counter.tick(totals(0, 30));
		const merged = counter.render(plainTheme(), mergeCfg, info(totals(0, 30)));
		check("合并模式只显示正在变化的一路", merged.startsWith("↓") && !merged.includes("↑"), merged);

		const blinkCfg = { ...liveCfg, animation: "blink" };
		counter.reset();
		counter.tick(totals(50));
		const blink1 = counter.render(rec, blinkCfg, info(totals(50)));
		counter.tick(totals(50));
		const blink2 = counter.render(rec, blinkCfg, info(totals(50)));
		check("闪烁模式逐帧切换亮/灰", blink1.includes("[muted]↑") && blink2.includes("[accent]↑"), `${blink1} | ${blink2}`);

		check(
			"速度与模型按开关附加",
			counter.render(plainTheme(), liveCfg, { tps: 42, elapsedMs: 0, totals: totals(50), model: "mimo", thinkingLevel: "high" }).includes("42tok/s") &&
				!counter.render(plainTheme(), { ...liveCfg, liveShowTps: false }, { tps: 42, elapsedMs: 0, totals: totals(50) }).includes("tok/s"),
		);
		check(
			"动态行的耗时跟在速度后, 圆点前",
			counter.render(plainTheme(), liveCfg, { tps: 42, elapsedMs: 212_000, totals: totals(50) }).includes("42tok/s 3m32s ·"),
			counter.render(plainTheme(), liveCfg, { tps: 42, elapsedMs: 212_000, totals: totals(50) }),
		);
		check(
			"动态行关掉耗时就没有耗时段",
			!counter.render(plainTheme(), { ...liveCfg, liveShowDuration: false }, { tps: 42, elapsedMs: 212_000, totals: totals(50) }).includes("3m32s"),
		);
		check(
			"动态行的箭头与缓存是独立开关",
			counter.render(plainTheme(), { ...liveCfg, liveShowCache: true }, { tps: 0, elapsedMs: 0, totals: totals(50, 0, { cacheRead: 1200 }) }).includes("R1.2k") &&
				!counter.render(plainTheme(), { ...liveCfg, liveShowCache: false }, { tps: 0, elapsedMs: 0, totals: totals(50, 0, { cacheRead: 1200 }) }).includes("R1.2k") &&
				!counter.render(plainTheme(), { ...liveCfg, liveShowArrows: false }, { tps: 0, elapsedMs: 0, totals: totals(50) }).includes("↑"),
		);
		check(
			"动态行的模型/思考强度是独立开关",
			counter.render(plainTheme(), { ...liveCfg, liveShowModel: true, liveShowThinking: true }, { tps: 0, elapsedMs: 0, totals: totals(50), model: "mimo", thinkingLevel: "high" }).includes("mimo (high)") &&
				!counter.render(plainTheme(), { ...liveCfg, liveShowModel: false, liveShowThinking: false }, { tps: 0, elapsedMs: 0, totals: totals(50), model: "mimo", thinkingLevel: "high" }).includes("mimo"),
		);

		// ---------------------------------------------------------- 面板
		console.log("panel:");
		const c1 = config.defaultConfig();
		panel.applySetting(c1, "live", mZh.off, mZh);
		check("applySetting 认中文标签", c1.live === false);
		panel.applySetting(c1, "animation", mEn.animationLabels.merge, mEn);
		check("applySetting 认英文标签", c1.animation === "merge");
		panel.applySetting(c1, "refreshMs", mEn.refreshMs(200), mEn);
		check("刷新频率解析成档位值", c1.refreshMs === 200);
		panel.applySetting(c1, "liveShowCost", mEn.off, mEn);
		check("动态行显示项可关", c1.liveShowCost === false);
		panel.applySetting(c1, "language", mEn.languageLabels.zh, mEn);
		check("语言反查到配置值", c1.language === "zh");
		check("改动立刻落盘", readFileSync(configFile, "utf8").includes('"language": "zh"'));

		// auto 的语言解析靠环境变量定死, 面板文案才是确定的
		process.env.LC_ALL = "";
		process.env.LC_MESSAGES = "";
		process.env.LANG = "zh_CN.UTF-8";
		const cfgPanel = { ...config.defaultConfig(), language: "auto" };
		const panelUi = makeUi();
		let applied = 0;
		await panel.openSettingsPanel(makeContext(panelUi.ui), cfgPanel, () => {
			applied += 1;
		});
		check("TUI 模式走 ui.custom", panelUi.calls.custom.length === 1);

		const panelTui = { renders: 0, requestRender() { this.renders += 1; } };
		let panelResult;
		const component = panelUi.calls.custom[0](panelTui, makeTheme(), undefined, (result) => {
			panelResult = result;
		});
		const lines = component.render(80).map(stripAnsi);
		check("面板有标题", lines.some((line) => line.includes(mZh.settingsTitle)), JSON.stringify(lines.slice(0, 3)));
		check(
			"面板页脚给出配置路径",
			lines.some((line) => line.includes(config.shortenHomePath(configFile))),
			JSON.stringify(lines.slice(-3)),
		);
		// 一级菜单的顺序与名字(面板与降级对话框共用同一张表)
		const topLabels = ["动画", "动态行显示", "动态行显示项", "结算行显示", "结算行显示项", "刷新频率", "Language"];
		const rows = lines.map((line) => line.replace(/\[[a-z]+\]/g, "").replace(/^→\s*/, "").trim());
		const topRows = topLabels.map((label) => rows.findIndex((line) => line.startsWith(`${label} `)));
		check(
			"一级菜单顺序: 动画 → 动态行显示 → 动态行显示项 → 结算行显示 → 结算行显示项 → 刷新频率 → Language",
			topRows.every((index, i) => index > 0 && (i === 0 || index > topRows[i - 1])),
			JSON.stringify({ topRows, rows }),
		);
		check("动态行摘要 3/7 开", lines.some((line) => line.includes("动态行显示项") && line.includes("3/7 开")), JSON.stringify(lines));
		check("结算行摘要 7/7 开", lines.some((line) => line.includes("结算行显示项") && line.includes("7/7 开")));
		check("刷新频率带毫秒", lines.some((line) => line.includes("120 毫秒")));
		check("语言行显示 自动", lines.some((line) => line.includes("Language") && line.includes("自动")));
		check("带原生提示行", lines.some((line) => line.includes("Enter/Space to change") && line.includes("Esc to cancel")));
		check("搜索框前面的图标是 ⌕", lines.some((line) => line.trim().startsWith("⌕")), JSON.stringify(lines.slice(0, 4)));

		component.handleInput(ENTER);
		check("回车切换并落盘", cfgPanel.animation === "steady" && readFileSync(configFile, "utf8").includes('"animation": "steady"'));
		check("onApplied 回调", applied === 1);
		check("重画走 requestRender", panelTui.renders >= 1);
		component.handleInput(ENTER);
		check("再回车切到下一个预设(合并→常亮→闪烁)", cfgPanel.animation === "blink");

		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		const subLines = component.render(80).map(stripAnsi);
		check(
			"子菜单列出七项显示开关",
			["显示箭头", "显示缓存", "显示预估金额", "显示速度", "显示耗时", "显示模型", "显示思考强度"].every((label) => subLines.some((line) => line.includes(label))),
			JSON.stringify(subLines),
		);
		const firstSubItem = subLines.findIndex((line) => line.includes("显示箭头"));
		check(
			"子菜单顶部空一行(不跟标题贴一起)",
			firstSubItem > 0 && subLines[firstSubItem - 1].trim() === "",
			JSON.stringify(subLines.slice(0, firstSubItem + 1)),
		);
		check(
			"子菜单标题换成该项行标签",
			subLines.some((line) => line.includes(mZh.settings.liveDisplay.label)) && !subLines.some((line) => line.includes(mZh.settingsTitle)),
			JSON.stringify(subLines.slice(0, 3)),
		);
		const subFooter = subLines.findIndex((line) => line.includes(config.shortenHomePath(configFile)));
		check(
			"子菜单底部与页脚之间空一行",
			subFooter > 0 && subLines[subFooter - 1].trim() === "",
			JSON.stringify(subLines.slice(Math.max(0, subFooter - 2), subFooter + 1)),
		);
		component.handleInput(ENTER);
		check("子菜单改动生效", cfgPanel.liveShowArrows === false);
		component.handleInput(ESC);
		check("返回一级菜单后摘要同步", component.render(80).map(stripAnsi).some((line) => line.includes("动态行显示项") && line.includes("2/7 开")));
		check("退出子菜单后标题换回面板名", component.render(80).map(stripAnsi).some((line) => line.includes(mZh.settingsTitle)));

		for (let i = 0; i < 4; i += 1) component.handleInput(DOWN);
		component.handleInput(ENTER); // 进语言子菜单
		const langLines = component.render(80).map(stripAnsi);
		check(
			"语言子菜单列出三项且光标预选在当前值上",
			["自动", "中文", "English"].every((label) => langLines.some((line) => line.includes(label))) &&
				langLines.some((line) => line.includes("→ 自动")),
			JSON.stringify(langLines.slice(0, 8)),
		);
		const firstLangItem = langLines.findIndex((line) => line.includes("自动"));
		check("语言子菜单顶部空一行", firstLangItem > 0 && langLines[firstLangItem - 1].trim() === "", JSON.stringify(langLines.slice(0, firstLangItem + 1)));
		check(
			"语言子菜单标题换成行标签 Language",
			langLines.some((line) => line.includes(mZh.settings.language.label)) && !langLines.some((line) => line.includes(mZh.settingsTitle)),
			JSON.stringify(langLines.slice(0, 3)),
		);
		const langFooter = langLines.findIndex((line) => line.includes(config.shortenHomePath(configFile)));
		check(
			"语言子菜单底部与页脚之间空一行",
			langFooter > 0 && langLines[langFooter - 1].trim() === "",
			JSON.stringify(langLines.slice(Math.max(0, langFooter - 2), langFooter + 1)),
		);
		component.handleInput(DOWN); // 自动 -> 中文
		component.handleInput(ENTER);
		check("语言从 自动 切到 中文", cfgPanel.language === "zh", String(cfgPanel.language));
		check("改语言后要求立即用新语言重开面板", panelResult?.languageChanged === true, JSON.stringify(panelResult));

		// 降级对话框(RPC 等)
		const answers = [
			mZh.animationLabels.blink, // animation
			mZh.off, // live(动态行显示)
			mZh.off, mZh.off, mZh.on, mZh.on, mZh.on, mZh.on, mZh.on, // 动态行七项(箭头/缓存/金额/速度/耗时/模型/思考强度)
			mZh.on, // resultInTranscript(结算行显示)
			mZh.on, mZh.on, mZh.on, mZh.on, mZh.on, mZh.on, mZh.on, // 结算行七项
			mZh.refreshMs(200), // refreshMs
			mZh.languageLabels.zh, // language
		];
		const fallbackUi = makeUi(answers);
		const cfgFallback = { ...config.defaultConfig(), language: "zh" };
		await panel.openSettingsDialog(makeContext(fallbackUi.ui, { mode: "rpc" }), cfgFallback, () => {});
		check("降级模式逐项问 19 次", fallbackUi.calls.select.length === 19, String(fallbackUi.calls.select.length));
		// 降级对话框按同一张表的顺序逐项问: 动画 → 动态行显示 → 动态行七项 → 结算行显示 → 结算行七项 → 刷新频率 → Language
		const asks = (index, label) => fallbackUi.calls.select[index].title.startsWith(`${label}?`);
		check(
			"第一问是动画且带当前值",
			asks(0, mZh.settings.animation.label) && fallbackUi.calls.select[0].title.includes(mZh.animationLabels.merge),
			fallbackUi.calls.select[0].title,
		);
		check("第二问是动态行显示", asks(1, mZh.settings.live.label), fallbackUi.calls.select[1].title);
		check("子菜单项带分组前缀", fallbackUi.calls.select[2].title.startsWith("动态行: 显示箭头? "), fallbackUi.calls.select[2].title);
		check("结算行显示在结算行七项之前", asks(9, mZh.settings.resultInTranscript.label), fallbackUi.calls.select[9].title);
		check("结算行项带分组前缀", fallbackUi.calls.select[10].title.startsWith("结算行: 显示箭头? "));
		check("降级模式的改动照样生效", cfgFallback.live === false && cfgFallback.animation === "blink" && cfgFallback.refreshMs === 200);
		check("走完给提示", fallbackUi.calls.notify.at(-1)?.message === "token-meter 设置已保存");

		const cancelUi = makeUi([mZh.animationLabels.merge, undefined]); // 第一项改完, 第二项取消
		const cancelCfg = { ...config.defaultConfig(), language: "zh" };
		await panel.openSettingsDialog(makeContext(cancelUi.ui, { mode: "rpc" }), cancelCfg, () => {});
		check(
			"取消即停:已改的保留, 不再继续问",
			cancelUi.calls.select.length === 2 && cancelCfg.animation === "merge" && cancelCfg.live === true && cancelUi.calls.notify.length === 0,
		);

		// ---------------------------------------------------------- 事件接线
		console.log("handlers:");
		writeFileSync(configFile, JSON.stringify({ ...config.defaultConfig(), language: "en" }));
		const api = makeApi();
		index.default(api.api);
		check("注册设置命令", api.commands.has("token-meter-settings"));
		check("命令描述是固定英文, 不随语言变", api.commands.get("token-meter-settings")?.description === "Token Meter Settings(token-meter.json)");

		// 命令带了参数: 只给用法提示, 绝不改配置, 也不开面板
		const hintUi = makeUi();
		const hintCfgBefore = readFileSync(configFile, "utf8");
		await api.commands.get("token-meter-settings").handler("live=false", makeContext(hintUi.ui));
		check(
			"命令带参数只给用法提示",
			hintUi.calls.notify.length === 1 && hintUi.calls.notify[0].message === mEn.usageHint && hintUi.calls.notify[0].type === "warning",
			JSON.stringify(hintUi.calls.notify),
		);
		check("带参数不开面板也不改配置", hintUi.calls.custom.length === 0 && readFileSync(configFile, "utf8") === hintCfgBefore);

		// 无 UI(json / print): 只报当前设置, 不弹对话框
		const noUi = makeUi();
		await api.commands.get("token-meter-settings").handler("", makeContext(noUi.ui, { mode: "print", hasUI: false }));
		check(
			"无 UI 时报当前设置",
			noUi.calls.notify.length === 1 && noUi.calls.notify[0].message === panel.statusText(config.loadConfig(), mEn),
			JSON.stringify(noUi.calls.notify),
		);
		check("无 UI 的状态带上完整配置路径", noUi.calls.notify[0].message.includes(configFile) && !noUi.calls.notify[0].message.includes("~"), JSON.stringify(noUi.calls.notify));
		check(
			"无 UI 不弹对话框也不改配置",
			noUi.calls.select.length === 0 && noUi.calls.custom.length === 0 && readFileSync(configFile, "utf8") === hintCfgBefore,
		);

		check("注册结算行入口渲染器", api.entryRenderers.has("token-meter.summary"));
		check(
			"监听关键事件",
			["session_start", "before_agent_start", "agent_start", "message_update", "message_end", "turn_end", "agent_end", "agent_settled"].every((event) =>
				api.handlers.has(event),
			),
		);

		const { ui, calls } = makeUi();
		const ctx = makeContext(ui);
		const partialMsg = { role: "assistant", model: "test-model", content: [{ type: "text", text: "hello world" }] };
		const finalMsg = {
			role: "assistant",
			model: "test-model",
			stopReason: "stop",
			content: partialMsg.content,
			usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.001 } },
		};
		await emit(api.handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await emit(api.handlers, "before_agent_start", { type: "before_agent_start", prompt: "hi" }, ctx);
		await emit(api.handlers, "agent_start", { type: "agent_start" }, ctx);
		await sleep(150);
		// 前缀用"思考强度边框色"(假主题渲染成 [thinking:<level>]), 计时自己套 muted, 不跟着一起变色
		check(
			"等待计时: 前缀用思考强度边框色, 计时保持灰色",
			/^\[thinking:[a-z]+\]Working \[muted\]\d+s$/.test(calls.workingMessages.at(-1) ?? ""),
			JSON.stringify(calls.workingMessages.slice(-2)),
		);
		await emit(api.handlers, "message_start", { type: "message_start", message: { role: "assistant", model: "test-model" } }, ctx);
		await emit(api.handlers, "message_update", { type: "message_update", message: partialMsg }, ctx);
		await sleep(150);
		check(
			"工作行被动态计数接管(默认合并预设只显示一路)",
			calls.workingMessages.some((message) => typeof message === "string" && /[↑↓]/.test(message) && message.includes("tok/s")),
			JSON.stringify(calls.workingMessages.slice(-2)),
		);
		check(
			"模型开始返回后就去掉 working 文案",
			typeof calls.workingMessages.at(-1) === "string" && !calls.workingMessages.at(-1).startsWith("Working"),
			JSON.stringify(calls.workingMessages.slice(-2)),
		);
		await emit(api.handlers, "message_end", { type: "message_end", message: finalMsg }, ctx);
		await emit(api.handlers, "turn_end", { type: "turn_end", outcome: "completed" }, ctx);
		await emit(api.handlers, "agent_end", { type: "agent_end" }, ctx);
		check("agent_end 只安排结算, 等落定才写", api.entries.length === 0);
		await emit(api.handlers, "agent_settled", { type: "agent_settled" }, ctx);
		check("落定后写入一行结算", api.entries.length === 1 && api.entries[0].type === "token-meter.summary");
		const roundData = api.entries[0].data;
		check("结算含本轮完整耗时(从发出消息算起)", roundData.durationMs >= 150, String(roundData.durationMs));
		check(
			"结算内容是本轮合计",
			roundData.totals.input === 100 && roundData.totals.output === 50 && roundData.totals.cost === 0.001,
			JSON.stringify(roundData.totals),
		);
		check("结算后清掉工作行", calls.workingMessages.at(-1) === undefined);
		const entryComponent = api.entryRenderers.get("token-meter.summary")({ data: roundData }, {}, plainTheme());
		check("入口渲染器画出结算行", /↑100 ↓50/.test(entryComponent.render(80)[0]), entryComponent.render(80)[0]);
		const afterSettle = calls.workingMessages.length;
		await sleep(150);
		check("结算后不再刷新动态行", calls.workingMessages.length === afterSettle);

		// 关掉"显示耗时": 等待期不缀计时, working 交还给 pi
		writeFileSync(configFile, JSON.stringify({ ...config.defaultConfig(), liveShowDuration: false, language: "en" }));
		const noDur = makeApi();
		index.default(noDur.api);
		const noDurUi = makeUi();
		const noDurCtx = makeContext(noDurUi.ui);
		await emit(noDur.handlers, "before_agent_start", { type: "before_agent_start", prompt: "hi" }, noDurCtx);
		await emit(noDur.handlers, "agent_start", { type: "agent_start" }, noDurCtx);
		await sleep(150);
		check(
			"关掉显示耗时后等待期不缀计时",
			noDurUi.calls.workingMessages.length > 0 && !noDurUi.calls.workingMessages.some((message) => typeof message === "string" && message.startsWith("Working ")),
			JSON.stringify(noDurUi.calls.workingMessages),
		);
		await emit(noDur.handlers, "session_shutdown", { type: "session_shutdown" }, noDurCtx);

		// 关掉动态行 / 结算行
		writeFileSync(configFile, JSON.stringify({ ...config.defaultConfig(), live: false, resultInTranscript: false, language: "en" }));
		const quiet = makeApi();
		index.default(quiet.api);
		const quietUi = makeUi();
		const quietCtx = makeContext(quietUi.ui);
		await emit(quiet.handlers, "agent_start", { type: "agent_start" }, quietCtx);
		await emit(quiet.handlers, "message_update", { type: "message_update", message: partialMsg }, quietCtx);
		await sleep(150);
		check(
			"live=false 不占工作行",
			!quietUi.calls.workingMessages.some((message) => typeof message === "string"),
			JSON.stringify(quietUi.calls.workingMessages),
		);
		await emit(quiet.handlers, "message_end", { type: "message_end", message: finalMsg }, quietCtx);
		await emit(quiet.handlers, "agent_settled", { type: "agent_settled" }, quietCtx);
		check("resultInTranscript=false 不写结算行", quiet.entries.length === 0);

		// RPC 模式:没有工作行,退化为状态条
		writeFileSync(configFile, JSON.stringify({ ...config.defaultConfig(), language: "en" }));
		const rpc = makeApi();
		index.default(rpc.api);
		const rpcUi = makeUi();
		const rpcCtx = makeContext(rpcUi.ui, { mode: "rpc" });
		await emit(rpc.handlers, "agent_start", { type: "agent_start" }, rpcCtx);
		await emit(rpc.handlers, "message_start", { type: "message_start", message: { role: "assistant", model: "test-model" } }, rpcCtx);
		await emit(rpc.handlers, "message_update", { type: "message_update", message: partialMsg }, rpcCtx);
		await sleep(150);
		check(
			"无工作行的模式改用状态条",
			rpcUi.calls.status.some(
				(entry) => entry.key === "token-meter" && typeof entry.text === "string" && /[↑↓]/.test(entry.text) && entry.text.includes("tok/s"),
			),
			JSON.stringify(rpcUi.calls.status.slice(-2)),
		);
		await emit(rpc.handlers, "agent_settled", { type: "agent_settled" }, rpcCtx);
		check("RPC 结算后清掉状态条", rpcUi.calls.status.at(-1)?.text === undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	return failures();
}
