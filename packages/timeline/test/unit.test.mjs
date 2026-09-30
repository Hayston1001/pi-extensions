/**
 * 合成渲染行下的行为测试: 行号定位, 过滤, 跳转, 放入输入框, 各种退化情况. 
 * 跑: node test/unit.test.mjs(或 node test/run.mjs)
 */
import assert from "node:assert/strict";
import { join } from "node:path";import {
	KEY,
	MARK,
	assistantEntry,
	bashEntry,
	createSuite,
	drivePicker,
	fakeMessageComponents,
	isMain,
	loadTimeline,
	makeFakeTui,
	renderLines,
	selectByText,
	tempDir,
	userEntry,
} from "./harness.mjs";

export async function run() {
	const suite = createSuite("unit · 合成渲染行");
	// 用隔离的副本 + 隔离的 agent 目录, 不然会受用户真实配置(快捷键 / jumpTo)影响
	const work = tempDir("unit");
	const load = await loadTimeline({ copyTo: join(work.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"user"}' });

	const entries = [
		userEntry("u1", "第一个问题: 把 read 工具改一下", 0),
		assistantEntry("a1", "好的, 我来看看 read 工具", 1),
		userEntry("u2", "继续", 2),
		assistantEntry("a2", "继续之前先确认一下", 3),
		userEntry("u3", "现在把测试跑一遍", 4),
		assistantEntry("a3", "测试通过了", 5),
	];
	const blocks = [
		{ role: "user", text: "第一个问题: 把 read 工具改一下" },
		{ role: "assistant", text: "好的, 我来看看 read 工具" },
		{ role: "user", text: "继续" },
		{ role: "assistant", text: "继续之前先确认一下" },
		{ role: "user", text: "现在把测试跑一遍" },
		{ role: "assistant", text: "测试通过了" },
	];

	const pick = (options = {}) => {
		const lines = renderLines(options.blocks ?? blocks);
		const { tui, view, calls } = makeFakeTui(lines, options.tui);
		return {
			lines,
			view,
			calls,
			run: (inputs) => drivePicker({ load, tui, entries: options.entries ?? entries, inputs, ...(options.renderWidth ? { renderWidth: options.renderWidth } : {}) }),
		};
	};

	await suite.test("扩展只注册 /timeline-settings 命令和配置里的快捷键(列表用快捷键开)", async () => {
		assert.deepEqual(load.commands, ["timeline-settings"]);
		assert.deepEqual(load.shortcuts, ["alt+g"]);
		assert.equal(
			load.extension.commands.get("timeline-settings")?.description,
			"Timeline Settings(timeline.json)",
			"命令描述固定成英文, 不参与 i18n",
		);
	});

	await suite.test("真实包目录也能正常加载", async () => {
		const real = await loadTimeline();
		assert.ok(!real.commands.includes("timeline"), `不应该还有 /timeline: ${real.commands}`);
		assert.ok(real.commands.includes("timeline-settings"), `命令: ${real.commands}`);
	});

	await suite.test("按组件精确定位: 只有工具调用的助手消息(不产生标记)也不会错位", async () => {
		const { user, assistant, textLine, document } = fakeMessageComponents();
		const parts = [
			textLine("头部噪声"),
			user("第一条用户消息"),
			assistant("有文字的助手回复"),
			user("第二条用户消息"),
			assistant("", false), // 只有工具调用 → 一行都不渲染, 也没有标记
			user("第三条用户消息"),
			assistant("", false),
			user("第四条用户消息"),
		];
		const doc = document(parts);
		const lines = doc.render(100);
		// 标记数只有 5(头部噪声不算 + 4 条用户 + 1 条助手), 照标记数对齐会全错
		const markerCount = lines.filter((line) => line.startsWith(MARK)).length;
		assert.equal(markerCount, 5, `预期 5 个标记, 实际 ${markerCount}`);

		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const pickerEntries = [
			userEntry("u1", "第一条用户消息", 0),
			assistantEntry("a1", "有文字的助手回复", 1),
			userEntry("u2", "第二条用户消息", 2),
			assistantEntry("a2", "", 3),
			userEntry("u3", "第三条用户消息", 4),
			assistantEntry("a3", "", 5),
			userEntry("u4", "第四条用户消息", 6),
		];

		// 独立算一遍基准行号: 按顺序累加每个组件的渲染高度
		const expectedRows = [];
		let oracleRow = 0;
		for (const part of parts) {
			if (typeof part.text === "string" && typeof part.outputPad === "number") expectedRows.push(oracleRow);
			oracleRow += part.render(100).length;
		}
		assert.equal(oracleRow, lines.length, "基准累加应当等于内容行数");
		// 逐条跳(用过滤选中, 列表里还夹着助手正文条目), 落点必须正好是该消息块的第一行
		const userTexts = ["第一条用户消息", "第二条用户消息", "第三条用户消息", "第四条用户消息"];
		for (let index = 0; index < userTexts.length; index++) {
			calls.length = 0;
			const { notifications } = await drivePicker({ load, tui, entries: pickerEntries, inputs: selectByText(userTexts[index]) });
			assert.deepEqual(notifications, [], `第 ${index + 1} 条不该有提示`);
			assert.equal(calls[0]?.row, expectedRows[index], `第 ${index + 1} 条落点不对`);
			assert.match(lines[expectedRows[index]], /用户消息/);
		}
	});

	await suite.test("按组件精确定位: 流式中多出一个组件也不会错位", async () => {
		const { user, assistant, document } = fakeMessageComponents();
		const parts = [user("甲"), assistant("回甲"), user("乙"), assistant("回乙"), assistant("流式中的消息")];
		const doc = document(parts);
		const lines = doc.render(100);
		// 流式那条还没落到会话条目里, 条目里只有到回乙为止
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const pickerEntries = [
			userEntry("u1", "甲", 0),
			assistantEntry("a1", "回甲", 1),
			userEntry("u2", "乙", 2),
			assistantEntry("a2", "回乙", 3),
		];
		// 基准: 甲(2 行) + 助手(3 行) = 乙 从第 5 行开始
		const expectedRow = parts[0].render(100).length + parts[1].render(100).length;
		const { notifications } = await drivePicker({ load, tui, entries: pickerEntries, inputs: selectByText("乙") });
		assert.deepEqual(notifications, []);
		assert.equal(calls[0]?.row, expectedRow, `第二条用户消息应当落在第 ${expectedRow} 行`);
		assert.match(lines[expectedRow], /乙/);
	});

	await suite.test("组件结构对不上时退回标记匹配(不会乱跳)", async () => {
		const { user, assistant, document } = fakeMessageComponents();
		const doc = document([user("甲"), assistant("回甲"), user("乙")]);
		// 外面套一层会在开头多插一行的包装: "累加高度 == 内容行数"校验失败 → 退回标记匹配
		const wrapper = { children: [doc], render: (w) => ["包装行", ...doc.render(w)] };
		const lines = wrapper.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: wrapper });
		const pickerEntries = [userEntry("u1", "甲", 0), assistantEntry("a1", "回甲", 1), userEntry("u2", "乙", 2)];
		const { notifications } = await drivePicker({ load, tui, entries: pickerEntries, inputs: selectByText("乙") });
		assert.deepEqual(notifications, []);
		assert.match(lines[calls[0].row], /乙/, `退回标记匹配后也应落在"乙"那一行, 实际第 ${calls[0].row} 行`);
	});

	await suite.test("序号对齐: 第一条消息跳到它自己的行", async () => {
		const { calls, lines, run } = pick();
		const { notifications } = await run([KEY.enter]);
		assert.deepEqual(notifications, []);
		assert.equal(calls.length, 1, "应当只跳一次");
		assert.equal(lines[calls[0].row].includes("第一个问题"), true, `行内容不对: ${lines[calls[0].row]}`);
		assert.equal(calls[0].options?.disableFollow, true, "跳转要禁用 follow-end");
	});

	await suite.test("按文字过滤后跳到「继续」那条用户消息", async () => {
		const { calls, lines, run } = pick();
		await run(selectByText("继续"));
		assert.equal(lines[calls[0].row].includes("继续"), true, `行内容不对: ${lines[calls[0].row]}`);
		assert.equal(lines[calls[0].row].includes("继续之前"), false, "不要落到助手消息上");
	});

	await suite.test("jumpTo=reply: 落到回复块的第一行(和 pi 原生 Ctrl+↓ 一致)", async () => {
		const work2 = tempDir("unit-reply");
		const loadReply = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const { user, assistant, document } = fakeMessageComponents();
		// 助手块 = [空行(上边距, 带标记), 正文, 空行]
		const doc = document([user("问题"), assistant("正文回答")]);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const { notifications } = await drivePicker({
			load: loadReply,
			tui,
			entries: [userEntry("u1", "问题", 0), assistantEntry("a1", "正文回答", 1)],
			inputs: [KEY.enter],
		});
		assert.deepEqual(notifications, []);
		assert.ok(lines[calls[0]?.row]?.startsWith(MARK), `应当落在块首那个带标记的行, 实际第 ${calls[0]?.row} 行`);
		assert.match(lines[calls[0].row + 1], /正文回答/, "正文就在落点下一行");
		work2.cleanup();
	});

	// ---- 稳定性: 重复文本 / 缺条 / 连发(这些都是"概率性跳错"的高发场景) ----

	const rowsOf = (parts, indexes) => {
		const rows = [];
		let position = 0;
		for (const [index, part] of parts.entries()) {
			if (indexes.includes(index)) rows.push(position);
			position += part.render(100).length;
		}
		return rows;
	};

	await suite.test("reply 跳过思考: 只保留紧邻正文的一行空白, 没空白时不回退", async () => {
		const work2 = tempDir("unit-reply-spacing");
		const loadReply = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const { user, assistant, textLine, document } = fakeMessageComponents();
		for (const gap of [[], [""], ["", "", ""], ["\x1b[2m  \x1b[0m"]]) {
			const reply = assistant("正文回答");
			reply.lastMessage.content.unshift({ type: "thinking", thinking: "思考末行" });
			const body = { text: "正文回答", render: () => ["正文回答"] };
			reply.contentContainer = document([
				textLine(MARK),
				{ child: textLine("思考末行"), onMouse() {}, render: () => ["思考末行"] },
				{ render: () => gap },
				{ render: () => [] }, // 零高度包装不应丢掉前一行的信息
				body,
			]);
			reply.render = (width) => reply.contentContainer.render(width);
			const doc = document([user("问题"), reply]);
			const lines = doc.render(100);
			const textRow = lines.indexOf("正文回答");
			const { tui, calls } = makeFakeTui(lines, { document: doc });
			const { notifications } = await drivePicker({
				load: loadReply, tui,
				entries: [userEntry("u1", "问题", 0), assistantEntry("a1", "正文回答", 1)],
				inputs: [KEY.enter],
			});
			assert.deepEqual(notifications, []);
			assert.equal(calls[0].row, textRow - (gap.length > 0 ? 1 : 0), JSON.stringify(gap));
			assert.notEqual(lines[calls[0].row], "思考末行");
		}
		work2.cleanup();
	});

	await suite.test("重复发同一句话: 每条都跳到它自己的那一块(不串位)", async () => {
		const { user, assistant, document } = fakeMessageComponents();
		const parts = [user("继续"), assistant("答一"), user("继续"), assistant("答二"), user("继续"), assistant("答三")];
		const doc = document(parts);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const pickerEntries = [
			userEntry("u1", "继续", 0),
			assistantEntry("a1", "答一", 1),
			userEntry("u2", "继续", 2),
			assistantEntry("a2", "答二", 3),
			userEntry("u3", "继续", 4),
			assistantEntry("a3", "答三", 5),
		];
		const expectedRows = rowsOf(parts, [0, 2, 4]);
		for (const [index, expectedRow] of expectedRows.entries()) {
			tui.getPrimaryScrollView().scrollTop = 0; // 从头开始选: 光标预选会跟着视口位置走
			const inputs = [...Array.from({ length: index }, () => KEY.down), KEY.enter];
			const { notifications } = await drivePicker({ load, tui, entries: pickerEntries, inputs });
			assert.deepEqual(notifications, [], `第 ${index + 1} 条不该有提示`);
			assert.equal(calls[index]?.row, expectedRow, `第 ${index + 1} 条"继续"应当落在第 ${expectedRow} 行, 实际 ${calls[index]?.row}`);
			assert.equal(lines[expectedRow].includes("继续"), true, `第 ${index + 1} 条落点不对`);
		}
		assert.deepEqual(
			calls.map((call) => call.row),
			expectedRows,
			"三条重复消息必须落到三个不同的行",
		);
	});

	await suite.test("中间一条文本被改写, 周围又有重复文本: 也不会整体串位", async () => {
		const { user, assistant, document } = fakeMessageComponents();
		// 渲染出来的文本和条目里的略有出入(context_edit 投影 / 版本差异), 
		// 中间两条在条目里一模一样, 渲染里也一模一样--纯文本比对在这里会把后一条认到前面
		const parts = [user("甲"), assistant("答甲"), user("继续(改写后)"), assistant("答一"), user("继续(改写后)"), assistant("答二"), user("乙"), assistant("答乙")];
		const doc = document(parts);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const pickerEntries = [
			userEntry("u1", "甲", 0),
			assistantEntry("a1", "答甲", 1),
			userEntry("u2", "继续", 2),
			assistantEntry("a2", "答一", 3),
			userEntry("u3", "继续", 4),
			assistantEntry("a3", "答二", 5),
			userEntry("u4", "乙", 6),
			assistantEntry("a4", "答乙", 7),
		];
		const expectedRows = rowsOf(parts, [0, 2, 4, 6]);
		for (const [index, expectedRow] of expectedRows.entries()) {
			tui.getPrimaryScrollView().scrollTop = 0; // 从头开始选: 光标预选会跟着视口位置走
			const inputs = [...Array.from({ length: index }, () => KEY.down), KEY.enter];
			await drivePicker({ load, tui, entries: pickerEntries, inputs });
			assert.equal(calls[index]?.row, expectedRow, `第 ${index + 1} 条应当落在第 ${expectedRow} 行, 实际 ${calls[index]?.row}`);
		}
	});

	await suite.test("中间少渲染一条: 已渲染的各自对上, 缺的提示定位不到而不是乱跳", async () => {
		const { user, assistant, document } = fakeMessageComponents();
		const parts = [user("甲"), assistant("答甲"), user("丙"), assistant("答丙")]; // "乙"没渲染出来
		const doc = document(parts);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const pickerEntries = [
			userEntry("u1", "甲", 0),
			assistantEntry("a1", "答甲", 1),
			userEntry("u2", "乙", 2),
			assistantEntry("a2", "答乙", 3),
			userEntry("u3", "丙", 4),
			assistantEntry("a3", "答丙", 5),
		];
		const expectedRows = rowsOf(parts, [0, 2]);
		tui.getPrimaryScrollView().scrollTop = 0;
		await drivePicker({ load, tui, entries: pickerEntries, inputs: [KEY.enter] });
		assert.equal(calls[0]?.row, expectedRows[0], "甲要落在自己的行");
		tui.getPrimaryScrollView().scrollTop = 0;
		const second = await drivePicker({ load, tui, entries: pickerEntries, inputs: [KEY.down, KEY.down, KEY.enter] });
		assert.deepEqual(second.notifications, []);
		assert.equal(calls[1]?.row, expectedRows[1], `丙要落在自己的行(第 ${expectedRows[1]} 行), 实际 ${calls[1]?.row}`);
		tui.getPrimaryScrollView().scrollTop = 0;
		const missing = await drivePicker({ load, tui, entries: pickerEntries, inputs: [KEY.down, KEY.enter] });
		assert.equal(calls.length, 2, "乙没有对应组件, 不该乱跳");
		assert.match(missing.notifications.map((item) => item.message ?? "").join(""), /定位不到/);
	});

	await suite.test("空白消息也占位(和 pi 的渲染条件一致), 后面的不会串位", async () => {
		const { user, assistant, document } = fakeMessageComponents();
		const parts = [user("甲"), user(" "), user("乙"), assistant("答乙")];
		const doc = document(parts);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const pickerEntries = [userEntry("u1", "甲", 0), userEntry("u2", " ", 1), userEntry("u3", "乙", 2), assistantEntry("a1", "答乙", 3)];
		const expectedRows = rowsOf(parts, [0, 1, 2]);
		for (const [index, expectedRow] of expectedRows.entries()) {
			tui.getPrimaryScrollView().scrollTop = 0; // 从头开始选: 光标预选会跟着视口位置走
			const inputs = [...Array.from({ length: index }, () => KEY.down), KEY.enter];
			const { notifications } = await drivePicker({ load, tui, entries: pickerEntries, inputs });
			assert.deepEqual(notifications, [], `第 ${index + 1} 条不该有提示`);
			assert.equal(calls[index]?.row, expectedRow, `第 ${index + 1} 条应当落在第 ${expectedRow} 行, 实际 ${calls[index]?.row}`);
		}
	});

	await suite.test("同一条 !命令 跑两次: 两条各跳各的", async () => {
		const { user, bash, assistant, document } = fakeMessageComponents();
		const parts = [user("先看看"), bash("ls"), assistant("输出甲"), bash("ls"), assistant("输出乙")];
		const doc = document(parts);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const pickerEntries = [
			userEntry("u1", "先看看", 0),
			bashEntry("b1", "ls", 1),
			assistantEntry("a1", "输出甲", 2),
			bashEntry("b2", "ls", 3),
			assistantEntry("a2", "输出乙", 4),
		];
		const expectedRows = rowsOf(parts, [1, 3]);
		for (const [index, expectedRow] of expectedRows.entries()) {
			tui.getPrimaryScrollView().scrollTop = 0; // 从头开始选: 光标预选会跟着视口位置走
			const inputs = [...Array.from({ length: index + 1 }, () => KEY.down), KEY.enter];
			const { notifications } = await drivePicker({ load, tui, entries: pickerEntries, inputs });
			assert.deepEqual(notifications, [], `第 ${index + 1} 条不该有提示`);
			assert.equal(calls[index]?.row, expectedRow, `第 ${index + 1} 条 !ls 应当落在第 ${expectedRow} 行, 实际 ${calls[index]?.row}`);
		}
	});

	await suite.test("用户连发两条消息: 两条都跳到同一个正文", async () => {
		const work2 = tempDir("unit-group");
		const loadReply = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const { user, assistant, document } = fakeMessageComponents();
		const parts = [user("问题一"), user("问题二"), assistant("一起回答")];
		const doc = document(parts);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const pickerEntries = [userEntry("u1", "问题一", 0), userEntry("u2", "问题二", 1), assistantEntry("a1", "一起回答", 2)];
		const answerRow = rowsOf(parts, [2])[0];
		// 落脚行 = 块的第一行(pi 原生 Ctrl+↓ 同款), 正文在下一行
		const landingRow = answerRow;
		for (const [index, inputs] of [[0, [KEY.enter]], [1, [KEY.down, KEY.enter]]]) {
			const { notifications } = await drivePicker({ load: loadReply, tui, entries: pickerEntries, inputs });
			assert.deepEqual(notifications, []);
			assert.equal(calls[index]?.row, landingRow, `第 ${index + 1} 条都应当落在回复块首行 ${landingRow}, 实际 ${calls[index]?.row}`);
			assert.match(lines[calls[index].row + 1], /一起回答/);
		}
		work2.cleanup();
	});

	await suite.test("这一轮被打断(只有工具调用, 没正文): 落到最近的下一段正文", async () => {
		const work2 = tempDir("unit-interrupt");
		const loadReply = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const { user, assistant, document } = fakeMessageComponents();
		// 甲问了之后被乙打断, 甲那一轮只有带工具调用的块(不算正文), 正文在乙那一轮
		const parts = [user("甲"), assistant("我先看看", true, true), assistant("再查一下", true, true), user("乙"), assistant("这才是答案")];
		const doc = document(parts);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const pickerEntries = [
			userEntry("u1", "甲", 0),
			assistantEntry("a1", "我先看看", 1),
			assistantEntry("a2", "再查一下", 2),
			userEntry("u2", "乙", 3),
			assistantEntry("a3", "这才是答案", 4),
		];
		const answerRow = rowsOf(parts, [4])[0];
		const landingRow = answerRow;
		const { notifications } = await drivePicker({ load: loadReply, tui, entries: pickerEntries, inputs: [KEY.enter] });
		assert.deepEqual(notifications, []);
		assert.equal(calls[0]?.row, landingRow, `甲应当落到下一段回复的块首行(第 ${landingRow} 行), 实际 ${calls[0]?.row}`);
		assert.match(lines[calls[0].row + 1], /这才是答案/);
		work2.cleanup();
	});

	await suite.test("打开面板: 光标停在\"当前这一轮\"的消息上(一轮=用户消息+工具+回复)", async () => {
		const { user, assistant, document } = fakeMessageComponents();
		const parts = [
			user("第一条问题"),
			assistant("第一条回答"),
			user("第二条问题"),
			assistant("第二条回答"),
			user("第三条问题"),
			assistant("第三条回答"),
		];
		const doc = document(parts);
		const lines = doc.render(100);
		const rows = rowsOf(parts, [0, 2, 4]);
		const pickerEntries = [
			userEntry("u1", "第一条问题", 0),
			assistantEntry("a1", "第一条回答", 1),
			userEntry("u2", "第二条问题", 2),
			assistantEntry("a2", "第二条回答", 3),
			userEntry("u3", "第三条问题", 4),
			assistantEntry("a3", "第三条回答", 5),
		];

		// 视口在第二条那一轮里(在回复中间也算)→ 光标是 #2, 不是 #3(#3 那轮还没开始)
		const midTurn = makeFakeTui(lines, { document: doc, scrollTop: rows[1] + 1 });
		const second = await drivePicker({ load, tui: midTurn.tui, entries: pickerEntries, inputs: [] });
		assert.match(second.rendered, /› #2 第二条问题/, `光标应当在第 2 条: \n${second.rendered}`);
		assert.match(second.rendered, /·当前/, "第 2 条应当带\"当前\"标记");

		// 视口在第三条消息上 → 光标是 #3
		const thirdTurn = makeFakeTui(lines, { document: doc, scrollTop: rows[2] });
		const third = await drivePicker({ load, tui: thirdTurn.tui, entries: pickerEntries, inputs: [] });
		assert.match(third.rendered, /› #3 第三条问题/, `光标应当在第 3 条: \n${third.rendered}`);

		// 直接按 Enter 就跳"当前这一轮", 不用先挑
		const { tui, calls } = makeFakeTui(lines, { document: doc, scrollTop: rows[1] + 1 });
		await drivePicker({ load, tui, entries: pickerEntries, inputs: [KEY.enter] });
		assert.equal(calls[0]?.row, rows[1], `Enter 应当跳到第 2 条(第 ${rows[1]} 行), 实际 ${calls[0]?.row}`);
	});

	await suite.test("列表渲染: 序号, 预览, 时间, 完整边框", async () => {
		const { run } = pick();
		const { rendered } = await run([KEY.escape]);
		assert.match(rendered, /消息 3 条/, "列表里只应当有 3 条用户消息");
		assert.match(rendered, /#1/);
		assert.match(rendered, /#3/);
		assert.match(rendered, /第一个问题/);
		assert.match(rendered, /\d{1,2}:\d{2}/);
		for (const line of rendered.split("\n")) {
			assert.match(line, /^╭|^╰|^│/, `每行都该有左右边框: ${JSON.stringify(line)}`);
		}
	});

	await suite.test("实时过滤: 输入关键字后回车, 跳到匹配的那条", async () => {
		const { calls, lines, run } = pick();
		await run([..."测试", KEY.enter]);
		assert.equal(lines[calls[0].row].includes("测试"), true, `行内容不对: ${lines[calls[0].row]}`);
	});

	await suite.test("标记数量对不上时退回内容匹配(助手消息没渲染)", async () => {
		const mixed = blocks.map((block, index) => (index === 3 ? { ...block, noRender: true } : block));
		const { calls, lines, run } = pick({ blocks: mixed });
		await run(selectByText("测试跑一遍"));
		assert.equal(lines[calls[0].row].includes("现在把测试跑一遍"), true, `行内容不对: ${lines[calls[0].row]}`);
	});

	await suite.test("markdown 被渲染改写(** 消失)仍能定位", async () => {
		const { calls, lines, run } = pick({
			entries: [userEntry("u1", "**重要**: 改 read 工具", 0), assistantEntry("a1", "好", 1)],
			blocks: [
				{ role: "user", text: "**重要**: 改 read 工具", rendered: "\x1b[1m重要\x1b[22m: 改 read 工具" },
				{ role: "assistant", text: "好" },
			],
		});
		await run([KEY.enter]);
		assert.equal(lines[calls[0].row].includes("重要"), true, `行内容不对: ${lines[calls[0].row]}`);
	});

	await suite.test("多行 / 被换行的消息按折叠空白匹配", async () => {
		const { calls, lines, run } = pick({
			entries: [userEntry("u1", "第一行内容\n第二行内容很长很长", 0), assistantEntry("a1", "收到", 1)],
			blocks: [
				{ role: "user", text: "第一行内容\n第二行内容很长很长", renderedLines: ["第一行内容", "  第二行内容很长很长"] },
				{ role: "assistant", text: "收到" },
			],
		});
		await run([KEY.enter]);
		assert.equal(lines[calls[0].row].includes("第一行内容"), true, `行内容不对: ${lines[calls[0].row]}`);
	});

	await suite.test("!命令(没有 OSC 标记)也能定位", async () => {
		const { calls, lines, run } = pick({
			entries: [userEntry("u1", "先跑个命令", 0), bashEntry("b1", "npm run build", 1), assistantEntry("a1", "构建成功", 2)],
			blocks: [
				{ role: "user", text: "先跑个命令" },
				{ role: "bash", text: "npm run build" },
				{ role: "assistant", text: "构建成功" },
			],
		});
		const { rendered } = await run(selectByText("npm run build"));
		assert.match(rendered, /npm run build/);
		assert.equal(lines[calls[0].row].includes("npm run build"), true, `行内容不对: ${lines[calls[0].row]}`);
	});

	await suite.test("Ctrl+Enter 把消息文本放进输入框且不滚动", async () => {
		const { calls, run } = pick();
		const { editorText } = await run([KEY.ctrlEnter]);
		assert.equal(editorText, "第一个问题: 把 read 工具改一下");
		assert.equal(calls.length, 0, "放入输入框时不应滚动");
	});

	await suite.test("Esc 取消: 不滚动, 不报错", async () => {
		const { calls, run } = pick();
		const { notifications } = await run([KEY.escape]);
		assert.equal(calls.length, 0);
		assert.equal(notifications.length, 0);
	});

	await suite.test("被压缩掉的旧消息不在列表里出现(也不做压缩计数)", async () => {
		const { rendered } = await drivePicker({
			load,
			tui: makeFakeTui(renderLines(blocks)).tui,
			entries,
			branchEntries: [userEntry("u0", "早就被压缩掉的问题", -5), ...entries],
			inputs: [KEY.escape],
		});
		assert.doesNotMatch(rendered, /早就被压缩掉的问题/);
		assert.doesNotMatch(rendered, /压缩/, "压缩计数已经去掉, 不该再出现");
	});

	await suite.test("非全屏模式: 给出提示而不是崩溃", async () => {
		const { calls, run } = pick({ tui: { mode: "regular" } });
		const { rendered, notifications } = await run([KEY.enter]);
		assert.equal(calls.length, 0);
		assert.equal(notifications.length, 0);
		assert.match(rendered, /fullscreen|视口/);
		assert.match(rendered, /^╭/, "提示也要有完整的框");
	});

	await suite.test("定位不到时给出提示, 而不是乱滚", async () => {
		const { calls, run } = pick({
			entries: [userEntry("u1", "这条消息在渲染里找不到", 0), assistantEntry("a1", "无关内容", 1)],
			// 标记数与预期对不上(助手消息没渲染), 内容也对不上 → 应当拒绝跳转
			blocks: [
				{ role: "user", text: "完全不同的渲染内容", rendered: "完全不同的渲染内容" },
				{ role: "assistant", text: "无关内容", noRender: true },
			],
		});
		const { notifications } = await run([KEY.enter]);
		assert.equal(calls.length, 0);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0].message, /定位不到/);
	});

	await suite.test("跳转后 flash 反馈带上序号和预览", async () => {
		const lines = renderLines(blocks);
		const { tui } = makeFakeTui(lines);
		await drivePicker({ load, tui, entries, inputs: [KEY.enter] });
		assert.equal(tui.flashes.length, 1);
		assert.match(tui.flashes[0], /^→ #1 /);
	});

	await suite.test("OSC 133 标记正则与 Pi 的转义形式一致", async () => {
		assert.equal(MARK, "\x1b]133;A\x07");
	});

	await suite.test("jumpTo=reply: 后面没回答(连着两条用户消息)时退而求其次", async () => {
		const { user, document } = fakeMessageComponents();
		const doc = document([user("甲"), user("乙")]);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const work = tempDir("reply-fallback");
		const loadReply = await loadTimeline({ copyTo: join(work.dir, "ext"), config: '{"jumpTo":"reply"}' });
		const entries = [userEntry("u1", "甲", 0), userEntry("u2", "乙", 1)];

		// 第一条: 下面没有助手消息, 退而用后一个块(甲 0-1, 乙 2-3)
		await drivePicker({ load: loadReply, tui, entries, inputs: [KEY.enter] });
		assert.equal(calls[0]?.row, 2, "应当退到后一个块");

		// 最后一条: 下面什么都没有, 就用它自己
		calls.length = 0;
		await drivePicker({ load: loadReply, tui, entries, inputs: [KEY.down, KEY.enter] });
		assert.equal(calls[0]?.row, 2, "最后一条应当就是它自己");
		work.cleanup();
	});

	await suite.test("jumpTo=reply: 中间隔着只有工具调用的助手消息时往下找到正文", async () => {
		const { user, assistant, document } = fakeMessageComponents();
		// 工具调用的助手消息不会出现在组件序列里, 所以下一条助手消息就是正文
		const doc = document([user("问题"), assistant("回答")]);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const work = tempDir("reply-toolonly");
		const loadReply = await loadTimeline({ copyTo: join(work.dir, "ext"), config: '{"jumpTo":"reply"}' });
		const entries = [userEntry("u1", "问题", 0), assistantEntry("a1", "", 1), assistantEntry("a2", "回答", 2)];
		await drivePicker({ load: loadReply, tui, entries, inputs: [KEY.enter] });
		assert.ok(lines[calls[0]?.row]?.startsWith(MARK), `reply 应当落在回复块首行, 实际第 ${calls[0]?.row} 行`);
		assert.match(lines[calls[0].row + 1], /回答/);
		work.cleanup();
	});

	await suite.test("jumpTo=reply: 一轮里有开场白和工具块时, 落在真正的回答(末块)", async () => {
		const work2 = tempDir("unit-turn");
		const loadReply = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const { user, assistant, document } = fakeMessageComponents();
		const parts = [
			user("问题"),
			assistant("我先看看实现: ", true, true), // 开场白: 带工具调用 → pi 不打标记, 不算正文
			assistant("", false, true), // 只有工具调用
			assistant("", false, true),
			assistant("这才是回答. "), // 不带工具调用 → 正文
			user("下一个问题"),
		];
		const doc = document(parts);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const entries = [
			userEntry("u1", "问题", 0),
			assistantEntry("a1", "我先看看实现: ", 1),
			assistantEntry("a2", "", 2),
			assistantEntry("a3", "这才是回答. ", 3),
			userEntry("u2", "下一个问题", 4),
		];
		const { notifications } = await drivePicker({ load: loadReply, tui, entries, inputs: [KEY.enter] });
		assert.deepEqual(notifications, []);
		assert.ok(lines[calls[0]?.row]?.startsWith(MARK), `应当落在这一轮回复的块首行, 实际第 ${calls[0]?.row} 行`);
		assert.match(lines[calls[0].row + 1], /这才是回答/);
		work2.cleanup();
	});

	await suite.test("jumpTo=reply: 这一轮没生成正文(只有带工具调用的块)时退回最后一条有文字的块", async () => {
		const work2 = tempDir("unit-noreply");
		const loadReply = await loadTimeline({ copyTo: join(work2.dir, "ext"), config: '{"shortcut":"alt+g","jumpTo":"reply"}' });
		const { user, assistant, document } = fakeMessageComponents();
		const parts = [user("问题"), assistant("开场白, 然后就中断了", true, true)];
		const doc = document(parts);
		const lines = doc.render(100);
		const { tui, calls } = makeFakeTui(lines, { document: doc });
		const entries = [userEntry("u1", "问题", 0), assistantEntry("a1", "开场白, 然后就中断了", 1)];
		const { notifications } = await drivePicker({ load: loadReply, tui, entries, inputs: [KEY.enter] });
		assert.deepEqual(notifications, []);
		assert.match(lines[calls[0].row + 1], /开场白/, `应当退回最后一条有文字的块(落块首行), 实际第 ${calls[0]?.row} 行`);
		work2.cleanup();
	});

	work.cleanup();
	return suite.finish();
}

if (isMain(import.meta.url)) {
	process.exit((await run()) === 0 ? 0 : 1);
}
