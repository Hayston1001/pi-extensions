/**
 * lifecycle.test.mjs -- 真实加载链路(真 AgentSession + /reload 时序)
 *
 * 验证 pi 自己发现并加载本扩展, session_start 时装好补丁, 以及最关键的一条:
 * pi 的 /reload 是"先重建聊天行组件, 后发 session_start", 所以配置必须在**扩展
 * 工厂阶段**就读盘--本测试把共享状态改脏, 再在"行创建的那一瞬间"断言它已经
 * 被读完的配置纠正回来了.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyExtensionTo, isolatedAgentDir, loadPiPackage, makeChecker } from "./harness.mjs";

const STATE_KEY = "__piThinkingStreamState";

const UI_STUB = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => {},
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
};

const COMMAND_ACTIONS = {
	waitForIdle: async () => {},
	newSession: async () => ({ cancelled: true }),
	fork: async () => ({ cancelled: true }),
	navigateTree: async () => ({ cancelled: false }),
	switchSession: async () => ({ cancelled: false }),
	reload: async () => {},
};

export async function run() {
	const { check, failures } = makeChecker();

	const root = isolatedAgentDir("lifecycle");
	rmSync(root, { recursive: true, force: true });
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	// 扩展读配置走这个目录;必须在它被加载之前设好
	process.env.PI_CODING_AGENT_DIR = agentDir;
	copyExtensionTo(join(agentDir, "extensions", "thinking-display"));

	const configFile = join(agentDir, "thinking-display.json");
	writeFileSync(configFile, JSON.stringify({ streaming: false, decorate: true }));

	const { piPackage } = await loadPiPackage();
	const { createAgentSession, SessionManager, AssistantMessageComponent } = piPackage;
	// 真机上 TUI 会先 initTheme, 测试里手动补上(组件渲染需要全局主题)
	piPackage.initTheme("dark");
	const state = () => globalThis[STATE_KEY];

	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(),
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});

		await session.bindExtensions({
			mode: "tui",
			uiContext: UI_STUB,
			commandContextActions: COMMAND_ACTIONS,
			abortHandler: () => {},
			shutdownHandler: () => {},
			onError: () => {},
		});

		check(
			"pi 加载了扩展并装上原型补丁",
			AssistantMessageComponent.prototype.__piThinkingStreamPatched >= 4,
			String(AssistantMessageComponent.prototype.__piThinkingStreamPatched),
		);
		check(
			"配置在启动阶段被读到(streaming=false)",
			state()?.enabled === false && state()?.decorate === true,
			JSON.stringify(state() && { enabled: state().enabled, decorate: state().decorate }),
		);

		// 把共享状态改脏, 再 reload:重建聊天行那一刻它必须已被配置纠正
		let enabledAtRowCreation = null;
		let decoratedAtRowCreation = -1;
		state().enabled = true;
		await session.reload({
			beforeSessionStart: () => {
				// 这就是 pi 重建聊天行组件的时刻
				enabledAtRowCreation = globalThis[STATE_KEY].enabled;
				const message = {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "row created here" },
						{ type: "text", text: "answer" },
					],
				};
				const component = new AssistantMessageComponent(message, true, undefined, undefined, 0);
				component.updateContent(message, true);
				decoratedAtRowCreation = component.contentContainer.children.filter(
					(child) => child?.__piThinkingRegionView === true,
				).length;
			},
		});
		check("reload:重建聊天行的瞬间配置已生效", enabledAtRowCreation === false, String(enabledAtRowCreation));
		check(
			"reload:那一刻创建的行也能被装饰(原型补丁对新旧组件一视同仁)",
			decoratedAtRowCreation === 1,
			String(decoratedAtRowCreation),
		);
		check(
			"reload 后补丁仍在",
			AssistantMessageComponent.prototype.__piThinkingStreamPatched >= 4,
			String(AssistantMessageComponent.prototype.__piThinkingStreamPatched),
		);

		// 配置缺失时自愈:reload 会重新读盘并落一份默认值
		rmSync(configFile, { force: true });
		await session.reload({});
		check("缺配置文件时会重新落一份", existsSync(configFile));
		check(
			"这份默认值是默认值(streaming on)",
			readFileSync(configFile, "utf8").includes('"streaming": true'),
			readFileSync(configFile, "utf8"),
		);
		check("共享状态跟着回到默认", state()?.enabled === true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	return failures();
}
