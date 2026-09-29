/**
 * 配置测试: 把扩展复制到临时目录 + 把 agent 目录隔到临时目录, 
 * 在各种 timeline.json 下检查注册出来的快捷键, 以及配置出错时的启动告警. 
 * 跑: node test/config.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	KEY,
	MARK,
	assistantEntry,
	collectStartupNotices,
	createSuite,
	driveCommand,
	drivePicker,
	fakeMessageComponents,
	isMain,
	loadSourceModule,
	loadTimeline,
	makeFakeTui,
	tempDir,
	userEntry,
} from "./harness.mjs";

export async function run() {
	const suite = createSuite("config · 快捷键配置");
	const work = tempDir("config");
	let counter = 0;

	/** 读回扩展刚写盘的那份配置 */
	function written(load) {
		return JSON.parse(readFileSync(load.configPath, "utf8"));
	}

	/**
	 * 每个场景一个干净的副本目录 + 一个隔离的 agent 目录: 扩展源码复制进副本目录, 
	 * 配置写在 agent 目录的 timeline.json 里(和线上一致, 不碰用户的真配置). 
	 */
	async function scenario({ label, config, agentConfig, legacyConfig }) {
		const slug = `${++counter}-${label.replace(/[^\w\u4e00-\u9fa5]+/g, "-")}`;
		const dir = join(work.dir, slug);
		const agent = join(dir, "agent");
		const load = await loadTimeline({ copyTo: dir, config, agentConfig, legacyConfig, agentDir: agent });
		const notices = await collectStartupNotices(load);
		return { shortcuts: load.shortcuts, notices, configPath: load.configPath, dir, agent };
	}

	await suite.test("没有配置文件 → alt+h", async () => {
		const { shortcuts, notices } = await scenario({ label: "默认", config: undefined });
		assert.deepEqual(shortcuts, ["alt+h"]);
		assert.deepEqual(notices, []);
	});

	await suite.test("换成别的键", async () => {
		const { shortcuts } = await scenario({ label: "换键", config: '{"shortcut":"alt+t"}' });
		assert.deepEqual(shortcuts, ["alt+t"]);
	});

	await suite.test("大小写不敏感", async () => {
		const { shortcuts } = await scenario({ label: "大小写", config: '{"shortcut":"Ctrl+Alt+G"}' });
		assert.deepEqual(shortcuts, ["ctrl+alt+g"]);
	});

	await suite.test("绑多个键(顺便去重)", async () => {
		const { shortcuts } = await scenario({ label: "多键", config: '{"shortcut":["alt+g","f8","alt+g"]}' });
		assert.deepEqual(shortcuts, ["alt+g", "f8"]);
	});

	await suite.test("null / [] / 空串 → 不注册快捷键, 不告警", async () => {
		for (const [label, config] of [
			["空值", '{"shortcut":null}'],
			["空数组", '{"shortcut":[]}'],
			["空字符串", '{"shortcut":""}'],
		]) {
			const { shortcuts, notices } = await scenario({ label, config });
			assert.deepEqual(shortcuts, [], `${label} 不该注册快捷键`);
			assert.deepEqual(notices, [], `${label} 不该有告警`);
		}
	});

	await suite.test("只写了别的字段 → 走默认", async () => {
		const { shortcuts } = await scenario({ label: "无shortcut字段", config: '{"foo":1}' });
		assert.deepEqual(shortcuts, ["alt+h"]);
	});

	await suite.test("非法键(无修饰键)→ 退回默认 + 告警", async () => {
		const { shortcuts, notices } = await scenario({ label: "非法无修饰键", config: '{"shortcut":"g"}' });
		assert.deepEqual(shortcuts, ["alt+h"]);
		assert.equal(notices.length >= 1, true, "应当有告警");
		assert.equal(notices[0].kind, "warning");
		assert.match(notices[0].message, /用不了/);
		assert.match(notices[0].message, /timeline\.json/);
	});

	await suite.test("非法键(认不出的按键)→ 退回默认 + 告警", async () => {
		const { shortcuts, notices } = await scenario({ label: "非法字符", config: '{"shortcut":"ctrl+⌘"}' });
		assert.deepEqual(shortcuts, ["alt+h"]);
		assert.match(notices[0].message, /认不出的按键/);
	});

	await suite.test("类型不对 → 退回默认 + 告警", async () => {
		const { shortcuts, notices } = await scenario({ label: "类型不对", config: '{"shortcut":123}' });
		assert.deepEqual(shortcuts, ["alt+h"]);
		assert.match(notices[0].message, /只能是字符串/);
	});

	await suite.test("JSON 写坏了 → 退回默认 + 告警(带路径)", async () => {
		const { shortcuts, notices, configPath } = await scenario({ label: "坏json", config: '{"shortcut":' });
		assert.deepEqual(shortcuts, ["alt+h"]);
		assert.match(notices[0].message, /解析失败/);
		assert.match(notices[0].message, /timeline\.json/);
		assert.equal(configPath.endsWith("timeline.json"), true);
	});

	await suite.test("旧位置(扩展目录 config.json)的配置会被搬到 agent 目录", async () => {
		const { shortcuts, agent, dir } = await scenario({
			label: "旧位置",
			config: undefined,
			legacyConfig: '{"shortcut":"f2"}',
		});
		assert.deepEqual(shortcuts, ["f2"], "旧位置的配置应当生效");
		assert.equal(existsSync(join(agent, "timeline.json")), true, "应当搬到 agent 目录");
		assert.equal(JSON.parse(readFileSync(join(agent, "timeline.json"), "utf8")).shortcut, "f2");
		assert.equal(existsSync(join(dir, "config.json")), false, "搬完就把旧文件删掉");
	});

	await suite.test("两处都有时以 agent 目录那份为准, 旧文件不动", async () => {
		const { shortcuts, agent, dir } = await scenario({
			label: "两处都有",
			config: '{"shortcut":"f3"}',
			legacyConfig: '{"shortcut":"f2"}',
		});
		assert.deepEqual(shortcuts, ["f3"]);
		assert.equal(JSON.parse(readFileSync(join(agent, "timeline.json"), "utf8")).shortcut, "f3", "新那份不该被旧的覆盖");
		assert.equal(existsSync(join(dir, "config.json")), true, "新那份在, 就不动旧文件");
	});

	await suite.test("读写都走 ~/.pi/agent/timeline.json: 包目录里不留任何东西", async () => {
		const work2 = tempDir("agent-config-write");
		const dir = join(work2.dir, "ext");
		const agent = join(work2.dir, "agent");
		const load2 = await loadTimeline({
			copyTo: dir,
			config: '{"shortcut":"alt+g","jumpTo":"user"}',
			agentDir: agent,
		});

		const fake = fakeMessageComponents();
		const doc = fake.document([fake.user("问题"), fake.assistant("回答")]);
		const { tui } = makeFakeTui(doc.render(100), { document: doc });
		const entries = [userEntry("u1", "问题", 0), assistantEntry("a1", "回答", 1)];
		// 落脚点行现在是回车直接切换(user → reply)
		await driveCommand({ load: load2, name: "timeline-settings", tui, entries, inputs: [KEY.enter, KEY.escape] });

		assert.equal(JSON.parse(readFileSync(join(agent, "timeline.json"), "utf8")).jumpTo, "reply", "应当写到 agent 目录那份");
		assert.equal(existsSync(join(dir, "config.json")), false, "包目录里不该出现 config.json");
		assert.deepEqual(readdirSync(dir).sort(), ["src"], "包目录只该有源码目录");
		assert.deepEqual(readdirSync(join(dir, "src")).sort(), ["i18n.ts", "index.ts"], "源码目录里只该有扩展源码");
		work2.cleanup();
	});

	await suite.test("jumpTo=reply → 落到下方回答块的第一行(和 pi 原生一致)", async () => {
		const { user, assistant, document } = fakeMessageComponents();
		const doc = document([user("问题一"), assistant("回答一"), user("问题二"), assistant("回答二")]);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const loadReply = await loadTimeline({ copyTo: join(work.dir, "reply"), config: '{"jumpTo":"reply"}' });
		const entries = [
			userEntry("u1", "问题一", 0),
			assistantEntry("a1", "回答一", 1),
			userEntry("u2", "问题二", 2),
			assistantEntry("a2", "回答二", 3),
		];
		// 行布局: 问题一 0-1, 回答一 2-4(首行是上边距, 带标记), 问题二 5-6, 回答二 7-9
		const { notifications } = await drivePicker({ load: loadReply, tui, entries, inputs: [KEY.enter] });
		assert.deepEqual(notifications, []);
		assert.ok(lines[calls[0]?.row]?.startsWith(MARK), `应当落在回答一块的首行, 实际第 ${calls[0]?.row} 行`);
		assert.match(lines[calls[0].row + 1], /回答一/);
	});

	await suite.test("jumpTo 的中文 / 别名写法都认", async () => {
		const { user, assistant, document } = fakeMessageComponents();
		const doc = document([user("问题"), assistant("回答"), user("问题二"), assistant("回答二")]);
		const lines = doc.render(100);
		for (const [label, config] of [
			["正文", '{"jumpTo":"正文"}'],
			["alias key anchor", '{"anchor":"reply"}'],
			["alias key target", '{"target":"answer"}'],
		]) {
			const { tui, calls } = makeFakeTui(lines, { document: doc });
			const loadReply = await loadTimeline({ copyTo: join(work.dir, `alias-${label.replace(/\W+/g, "")}`), config });
			const entries = [userEntry("u1", "问题", 0), assistantEntry("a1", "回答", 1), userEntry("u2", "问题二", 2), assistantEntry("a2", "回答二", 3)];
			await drivePicker({ load: loadReply, tui, entries, inputs: [KEY.enter] });
			assert.match(lines[calls[0]?.row + 1], /回答/, `${label} 应当落到回答块的首行(正文在下一行)`);
		}
	});

	await suite.test("jumpTo 不合法 → 按默认(跳到消息)处理 + 告警", async () => {
		const loadBad = await loadTimeline({ copyTo: join(work.dir, "bad-jumpto"), config: '{"jumpTo":"whatever"}' });
		const notices = await collectStartupNotices(loadBad);
		assert.equal(notices.length, 1);
		assert.match(notices[0].message, /jumpTo/);

		const { user, assistant, document } = fakeMessageComponents();
		const doc = document([user("问题"), assistant("回答")]);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const entries = [userEntry("u1", "问题", 0), assistantEntry("a1", "回答", 1)];
		await drivePicker({ load: loadBad, tui, entries, inputs: [KEY.enter] });
		assert.match(lines[calls[0]?.row], /问题/, "应当落到消息本身那一行");
	});

	await suite.test("设置面板: 切换落脚点写回配置文件且立即生效", async () => {
		const work2 = tempDir("settings-jumpto");
		const dir = join(work2.dir, "ext");
		const load = await loadTimeline({ copyTo: dir, config: '{"shortcut":"alt+g","jumpTo":"user"}' });
		const { user, assistant, document } = fakeMessageComponents();
		const doc = document([user("问题"), assistant("回答")]);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });

		// /timeline-settings → 回车打开"落脚点"二级菜单 → ↓ 选"下方正文" → 回车 → Esc 关闭
		const result = await driveCommand({
			load,
			name: "timeline-settings",
			tui,
			entries: [userEntry("u1", "问题", 0), assistantEntry("a1", "回答", 1)],
			inputs: [KEY.enter, KEY.escape],
		});
		assert.match(result.rendered, /Timeline 设置/, `面板没渲染对:\n${result.rendered}`);
		assert.match(result.rendered, /落脚点/);
		assert.equal(written(load).jumpTo, "reply", "应当写回 reply");
		// 面板里的值变了本身就是反馈, 不再弹提示
		assert.deepEqual(result.notifications, []);

		// 同一份配置里再跳一次: 立即按新的落脚点走(不用 /reload)
		const { notifications } = await drivePicker({
			load,
			tui,
			entries: [userEntry("u1", "问题", 0), assistantEntry("a1", "回答", 1)],
			inputs: [KEY.enter],
		});
		assert.deepEqual(notifications, []);
		assert.match(lines[calls[0]?.row + 1], /回答/, `应当按新的落脚点落到回答块的首行, 实际第 ${calls[0]?.row} 行`);
		work2.cleanup();
	});

	await suite.test("设置面板: 自定义快捷键(走输入对话框)", async () => {
		const work2 = tempDir("settings-custom");
		const dir = join(work2.dir, "ext");
		const load = await loadTimeline({ copyTo: dir, config: '{"shortcut":"alt+g"}' });
		const { user, assistant, document } = fakeMessageComponents();
		const doc = document([user("甲"), assistant("回甲")]);
		const { tui } = makeFakeTui(doc.render(100), { document: doc });

		// ↓ 选"快捷键"行 → 回车打开二级菜单 → 选"自定义..."(第 6 项)→ 回车
		const result = await driveCommand({
			load,
			name: "timeline-settings",
			tui,
			inputs: [KEY.down, KEY.enter, KEY.down, KEY.down, KEY.down, KEY.enter],
			answer: "alt+y",
		});
		assert.equal(result.prompts.length, 1, "应当问一次快捷键");
		assert.equal(written(load).shortcut, "alt+y");
		assert.match(result.notifications.at(-1).message, /alt\+y/);
		assert.match(result.notifications.at(-1).message, /reload/);
		work2.cleanup();
	});

	await suite.test("设置面板: 关闭快捷键 → 写成 null; 非法自定义键 → 拒绝并提示", async () => {
		const work2 = tempDir("settings-off");
		const dir = join(work2.dir, "ext");
		const load = await loadTimeline({ copyTo: dir, config: '{"shortcut":"alt+g"}' });
		const { user, assistant, document } = fakeMessageComponents();
		const doc = document([user("甲"), assistant("回甲")]);
		const { tui } = makeFakeTui(doc.render(100), { document: doc });

		// 二级菜单: 3 个候选 + 自定义 + 关闭, 选最后一项
		await driveCommand({
			load,
			name: "timeline-settings",
			tui,
			inputs: [KEY.down, KEY.enter, ...Array.from({ length: 4 }, () => KEY.down), KEY.enter],
		});
		assert.equal(written(load).shortcut, null);

		// 自定义一个不合法的键(不能带裸字母)→ 写不进去, 有告警
		const result = await driveCommand({
			load,
			name: "timeline-settings",
			tui,
			inputs: [KEY.down, KEY.enter, KEY.down, KEY.down, KEY.down, KEY.enter],
			answer: "g",
		});
		assert.equal(written(load).shortcut, null, "非法键不应写进去");
		assert.match(result.notifications.at(-1).message, /用不了/);
		work2.cleanup();
	});

	await suite.test("Language: language=en 时界面是英文", async () => {
		const work2 = tempDir("lang-en");
		const loadEn = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g","language":"en"}' });
		const fake = fakeMessageComponents();
		const doc = fake.document([fake.user("问题"), fake.assistant("回答")]);
		const { tui } = makeFakeTui(doc.render(100), { document: doc });
		const result = await drivePicker({
			load: loadEn,
			tui,
			entries: [userEntry("u1", "问题", 0), assistantEntry("a1", "回答", 1)],
			inputs: [],
		});
		// 渲染里夹着颜色码/光标标记, 先剥掉再匹配文案
		const plain = result.rendered
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			.replace(/\x1b_pi:c\x07/g, "")
			.replace(/\x1b\[[0-9;]*m/g, "");
		assert.match(plain, /Mode: user/, `没看到英文界面: \n${plain}`);
		assert.match(plain, /Filter messages/);
		assert.doesNotMatch(plain, /模式/, "language=en 不该再出中文");
		work2.cleanup();
	});

	await suite.test("Language: 设置面板里能切语言, 切完面板以新语言重开", async () => {
		const work2 = tempDir("lang-switch");
		const load2 = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g","language":"zh"}' });
		const fake = fakeMessageComponents();
		const doc = fake.document([fake.user("问题"), fake.assistant("回答")]);
		const { tui } = makeFakeTui(doc.render(100), { document: doc });
		const entries = [userEntry("u1", "问题", 0), assistantEntry("a1", "回答", 1)];

		// 面板: ↓↓ 到最下面的语言行 → 回车开子页面(光标停在当前值"中文"上)→ ↓ 选 English → 回车
		const result = await driveCommand({
			load: load2,
			name: "timeline-settings",
			tui,
			entries,
			inputs: [[KEY.down, KEY.down, KEY.enter, KEY.down, KEY.enter], []],
		});
		assert.match(result.rendered, /Language/);
		assert.match(result.rendered, /Jump target/, `切到英文后面板应当换语言: \n${result.rendered}`);
		assert.equal(written(load2).language, "en", "应当写回 en");
		work2.cleanup();
	});

	await suite.test("列表顶部显示当前模式(user/reply), 改配置立即变", async () => {
		const fake = fakeMessageComponents();
		const doc = fake.document([fake.user("问题"), fake.assistant("回答")]);
		const { tui } = makeFakeTui(doc.render(100), { document: doc });
		const entries = [userEntry("u1", "问题", 0), assistantEntry("a1", "回答", 1)];

		const workReply = tempDir("mode-shown-reply");
		const loadReply = await loadTimeline({ copyTo: join(workReply.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const replyView = await drivePicker({ load: loadReply, tui, entries, inputs: [] });
		assert.match(replyView.rendered, /模式: reply/, `标题里没看到模式: \n${replyView.rendered}`);

		const workUser = tempDir("mode-shown-user");
		const loadUser = await loadTimeline({ copyTo: join(workUser.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"user"}' });
		const userView = await drivePicker({ load: loadUser, tui, entries, inputs: [] });
		assert.match(userView.rendered, /模式: user/, `标题里没看到模式: \n${userView.rendered}`);
		assert.doesNotMatch(userView.rendered, /模式: reply/, "user 模式不该显示成 reply");

		workReply.cleanup();
		workUser.cleanup();
	});

	await suite.test("设置面板: 预设的快捷键就是 alt+t / alt+h / ctrl+h", async () => {
		const work2 = tempDir("settings-choices");
		const load2 = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g"}' });
		const { user, assistant, document } = fakeMessageComponents();
		const doc = document([user("问题"), assistant("回答")]);
		const { tui } = makeFakeTui(doc.render(100), { document: doc });

		// ↓ 到"快捷键"行 → 回车打开二级菜单(中途的渲染就是候选列表)
		const result = await driveCommand({
			load: load2,
			name: "timeline-settings",
			tui,
			inputs: [KEY.down, KEY.enter, KEY.escape, KEY.escape],
		});
		const submenu = result.steps.find((text) => text.includes("alt+t")) ?? "";
		const submenuLines = submenu.split("\n");
		assert.equal(submenuLines[1].trim(), "快捷键", "子页面标题换成该配置项的名字");
		assert.equal(submenuLines[2], "", "子页面正文与标题之间要空一行");
		assert.match(submenuLines[3], /alt\+t/, "空行之后才是候选");
		assert.match(submenu, /alt\+h/);
		assert.match(submenu, /ctrl\+h/);
		assert.doesNotMatch(submenu, /alt\+g/);
		work2.cleanup();
	});

	await suite.test("i18n: zh/en 两套表结构一致, 语言解析按环境变量", async () => {
		const i18n = await loadSourceModule("i18n.ts");
		const keys = (obj, prefix = "") =>
			Object.entries(obj)
				.flatMap(([key, value]) =>
					value && typeof value === "object" ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`],
				)
				.sort();
		assert.deepEqual(keys(i18n.MESSAGES.zh), keys(i18n.MESSAGES.en), "两套表的键必须一一对应");
		assert.equal(i18n.resolveLang("zh"), "zh");
		assert.equal(i18n.resolveLang("en"), "en");

		// auto 先看环境变量: 不能只依赖 Intl(CI 上区域不同, 断言会跟着变)
		const saved = {};
		for (const key of ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"]) saved[key] = process.env[key];
		try {
			for (const key of Object.keys(saved)) delete process.env[key];
			process.env.LC_ALL = "zh_CN.UTF-8";
			assert.equal(i18n.resolveLang("auto"), "zh");
			delete process.env.LC_ALL;
			process.env.LANG = "en_US.UTF-8";
			assert.equal(i18n.resolveLang("auto"), "en");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	await suite.test("没有配置文件时: 界面语言按系统区域解析, 语言行显示 auto 的取值", async () => {
		const work2 = tempDir("panel-language");
		const saved = {};
		for (const key of ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"]) saved[key] = process.env[key];
		try {
			for (const key of Object.keys(saved)) delete process.env[key];
			process.env.LANG = "zh_CN.UTF-8";
			const load2 = await loadTimeline({ copyTo: join(work2.dir, "ext") }); // 不写配置
			const { tui } = makeFakeTui([]);
			const result = await driveCommand({ load: load2, name: "timeline-settings", tui, inputs: [] });
			const plain = result.rendered.replace(/\x1b\[[0-9;]*m/g, "");
			assert.match(plain, /Timeline 设置/, `面板应当是中文: \n${plain}`);
			assert.match(plain, /跳过去时落在哪一块/, `描述应当是中文: \n${plain}`);
			// 配置里是 auto, 行上就该写 auto 的取值; 以前这里会因为默认配置缺 language 字段而写成 English
			assert.match(plain, /Language\s+自动/, `语言行应当取到默认的 auto: \n${plain}`);
			assert.doesNotMatch(plain, /English|Timeline Settings/, "不该退回英文");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		work2.cleanup();
	});

	await suite.test("非 TUI 但有 UI: 逐项选择对话框(标题带当前值, 取消不回滚)", async () => {
		const work2 = tempDir("dialog-fallback");
		const load2 = await loadTimeline({
			copyTo: join(work2.dir, "ext"),
			config: '{"shortcut":"alt+g","jumpTo":"user"}',
		});
		const result = await driveCommand({
			load: load2,
			name: "timeline-settings",
			mode: "rpc",
			hasUI: true,
			selects: ["下方正文(reply)", undefined], // 第二项(快捷键)用户取消
		});

		assert.equal(result.rendered, "", "非 TUI 不该开面板");
		assert.equal(result.selects.length, 2, "取消后就不再问后面的项");
		assert.match(result.selects[0].title, /落脚点/);
		assert.match(result.selects[0].title, /当前: 消息本身\(user\)/);
		assert.deepEqual(result.selects[0].values, ["消息本身(user)", "下方正文(reply)"]);
		assert.equal(written(load2).jumpTo, "reply", "已改的那项要保留");
		assert.deepEqual(result.notifications, [], "中途取消不报保存");
		work2.cleanup();
	});

	await suite.test("没有 UI: 只报当前设置", async () => {
		const work2 = tempDir("no-ui");
		const load2 = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g"}' });
		const result = await driveCommand({ load: load2, name: "timeline-settings", mode: "rpc", hasUI: false });

		assert.equal(result.selects.length, 0);
		assert.equal(result.notifications.length, 1);
		assert.match(result.notifications[0].message, /落脚点: 消息本身\(user\)/);
		assert.match(result.notifications[0].message, /快捷键: alt\+g/);
		assert.match(result.notifications[0].message, /语言: 中文/);
		work2.cleanup();
	});

	await suite.test("命令参数一律忽略: 照样开面板, 不当设置用", async () => {
		const work2 = tempDir("settings-args");
		const load2 = await loadTimeline({
			copyTo: join(work2.dir, "ext"),
			config: '{"shortcut":"alt+g","jumpTo":"user"}',
		});
		const { tui } = makeFakeTui([]);
		const result = await driveCommand({
			load: load2,
			name: "timeline-settings",
			args: "jumpTo=reply",
			tui,
			inputs: [KEY.escape],
		});

		assert.match(result.rendered, /Timeline 设置/, "参数被忽略, 照样开面板");
		assert.equal(written(load2).jumpTo, "user", "参数不该被当成设置项");
		assert.deepEqual(result.notifications, []);
		work2.cleanup();
	});

	await suite.test("设置面板: 原生骨架(边框 / 标题缩进 2 / 搜索行 / 页脚路径)", async () => {
		const work2 = tempDir("settings-skeleton");
		const load2 = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g"}' });
		const { tui } = makeFakeTui([]);
		const result = await driveCommand({
			load: load2,
			name: "timeline-settings",
			tui,
			inputs: [KEY.down, KEY.escape],
		});
		const lines = result.rendered.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
		assert.match(lines[0], /^─+$/, "第一行应当是 DynamicBorder");
		assert.match(lines.at(-1), /^─+$/, "最后一行应当是 DynamicBorder");
		assert.ok(lines[1].startsWith("  Timeline 设置"), "标题应当左缩进 2");
		assert.equal(lines[1].trim(), "Timeline 设置");
		assert.ok(lines.some((line) => line.includes("Type to search")), "应当有搜索行");
		assert.ok(lines.some((line) => line.includes("Language")), "应当有语言行");
		const footer = lines.find((line) => line.includes("timeline.json"));
		assert.ok(footer, `页脚应当给出配置路径: \n${lines.join("\n")}`);
		assert.ok(
			footer.includes(load2.configPath) || footer.includes(load2.configPath.replace(homedir(), "~")),
			`页脚路径应当就是 configPath()(可用 ~ 缩短): ${footer}`,
		);
		assert.ok(tui.renderRequests > 0, "按键后应当请求重绘");
		work2.cleanup();
	});

	await suite.test("设置面板: 搜索框前面的图标是 ⌕", async () => {
		const work2 = tempDir("settings-glyph");
		const load2 = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g"}' });
		const { tui } = makeFakeTui([]);
		const result = await driveCommand({ load: load2, name: "timeline-settings", tui, inputs: [] });
		const lines = result.rendered.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
		assert.equal(lines[1].trim(), "Timeline 设置");
		assert.equal(lines[2].trim(), "⌕", `搜索行应当以 ⌕ 开头: ${JSON.stringify(lines[2])}`);
		work2.cleanup();
	});

	await suite.test("设置面板: 子菜单标题换成该配置项的名字, 末尾与页脚之间空一行", async () => {
		const work2 = tempDir("settings-submenu-chrome");
		const load2 = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g","language":"zh"}' });
		const { tui } = makeFakeTui([]);

		// 语言子菜单: ↓↓ 到语言行 → 回车进子页面
		const language = await driveCommand({
			load: load2,
			name: "timeline-settings",
			tui,
			inputs: [KEY.down, KEY.down, KEY.enter],
		});
		const langLines = language.rendered.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((line) => line.replace(/\s+$/, ""));
		assert.equal(langLines[1], "  Language", `子页面标题应当是该项的行标签: \n${langLines.join("\n")}`);
		// 页脚行(含 timeline.json)前面必须是一个空行
		const footer = langLines.findIndex((line) => line.includes("timeline.json"));
		assert.ok(footer > 0 && langLines[footer - 1] === "", `候选与页脚之间要空一行: ${JSON.stringify(langLines.slice(-4))}`);

		// 退出子菜单后标题换回面板名
		const back = await driveCommand({
			load: load2,
			name: "timeline-settings",
			tui,
			inputs: [KEY.down, KEY.down, KEY.enter, KEY.escape],
		});
		const backLines = back.rendered.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
		assert.equal(backLines[1].trim(), "Timeline 设置", "退出子页面后标题要换回来");
		work2.cleanup();
	});

	work.cleanup();
	return suite.finish();
}

if (isMain(import.meta.url)) {
	process.exit((await run()) === 0 ? 0 : 1);
}
