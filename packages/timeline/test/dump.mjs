/**
 * 把两个界面按指定宽度打印出来, 并逐行核对可见宽度 -- 调边框/排版时用. 
 * 跑: node test/dump.mjs [宽度...]   (默认 90 52 34)
 */
import { THEME, assistantEntry, loadTimeline, makeFakeTui, renderLines, tui, userEntry } from "./harness.mjs";

const widths = process.argv.slice(2).map(Number).filter(Boolean);
const targets = widths.length > 0 ? widths : [90, 52, 34];

const entries = [
	userEntry("u1", "第一个问题: 把 read 工具改一下, 顺便看看 中文宽度 会不会把框撑破", 0),
	assistantEntry("a1", "好的", 1),
	userEntry("u2", "继续", 2),
	assistantEntry("a2", "嗯", 3),
	userEntry("u3", "**重要**: 现在把测试跑一遍", 4),
	assistantEntry("a3", "过了", 5),
];
const lines = renderLines(
	entries.map((entry) => ({ role: entry.message.role === "user" ? "user" : "assistant", text: entry.message.content[0].text })),
);

const load = await loadTimeline();

/** 打开一次界面并拿到组件(不投递按键).  */
async function openComponent(mode, width, { name, args = "" } = {}) {
	const { tui: fakeTui } = makeFakeTui(lines, { mode, scrollTop: 22 });
	let component;
	const ctx = {
		mode: "tui",
		sessionManager: { buildContextEntries: () => entries, getBranch: () => entries },
		ui: {
			notify() {},
			setEditorText() {},
			input: async () => undefined,
			custom: (factory) =>
				new Promise((resolvePromise) => {
					component = factory(fakeTui, THEME, { matches: () => false }, resolvePromise);
					resolvePromise(null);
				}),
		},
	};
	if (name) await load.runNamed(name, args, ctx);
	else await load.runShortcut(ctx);
	return component;
}

function show(label, component, width) {
	console.log(`\n=== ${label} (width=${width}) ===`);
	let bad = 0;
	for (const line of component.render(width)) {
		console.log(`${line}\x1b[0m`);
		const visible = tui.visibleWidth(line);
		if (visible !== width) bad += 1;
		console.log(`   [可见宽度 ${visible}]`);
	}
	if (bad > 0) console.log(`   !! ${bad} 行的可见宽度不等于 ${width}`);
}

for (const width of targets) {
	show("选择界面", await openComponent("fullscreen", width), width);
}
show("非全屏提示", await openComponent("regular", targets[0]), targets[0]);
for (const width of targets.slice(0, 1)) {
	show("设置面板", await openComponent("fullscreen", width, { name: "timeline-settings" }), width);
}

