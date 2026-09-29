/**
 * reload.test.mjs -- /reload 注册时序回归(node test/run.mjs reload)
 *
 * pi 的 /reload 是"先重建聊天行组件, 后发 session_start";行组件创建当场就把
 * 渲染定义固化. 因此覆盖注册必须在扩展工厂阶段完成--本测试在"行创建的那一瞬间"
 * (reload 的 beforeSessionStart 回调)断言定义已是覆盖版. 
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { copyExtensionTo, isolatedAgentDir, loadPiPackage, makeChecker } from "./harness.mjs";

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
	// 只加载 pi 自己: 扩展模块让 pi 的 loader 从 agent 目录的副本里发现,
	// 不从包目录 import(那个默认路径是 testing-isolation 明确禁止的写法)
	const { piPackage } = await loadPiPackage();
	const { createAgentSession, SessionManager } = piPackage;

	// 临时目录在 tempDir() 开头清, 用例末尾不删: 之后还在用的实例会读不到自己的配置
	const root = isolatedAgentDir("reload");
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	copyExtensionTo(join(agentDir, "extensions", "tool-display"));

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(),
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	const isOurs = () => session.getToolDefinition("bash")?.renderShell === "self";

	await session.bindExtensions({
		mode: "tui",
		uiContext: UI_STUB,
		commandContextActions: COMMAND_ACTIONS,
		abortHandler: () => {},
		shutdownHandler: () => {},
		onError: () => {},
	});
	check("启动流程:绑定后覆盖已注册", isOurs());

	let atRowCreation = false;
	await session.reload({
		beforeSessionStart: () => {
			// 这就是 pi 重建聊天行组件的时刻
			atRowCreation = isOurs();
		},
	});
	check("reload:行创建那一瞬间定义已是覆盖版", atRowCreation);
	check("reload:之后覆盖仍在", isOurs());
	return failures();
}
