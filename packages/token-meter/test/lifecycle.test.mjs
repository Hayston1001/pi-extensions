/**
 * lifecycle.test.mjs -- 真实加载链路(真 AgentSession)
 *
 * 验证 pi 自己发现并加载本扩展:命令 / 结算行入口渲染器 / 事件 handler 都在真实
 * 运行时里注册成功; 命令描述是固定英文(不随语言变), 而"配置在加载时被读到"改用
 * 命令带参数时的用法提示来断言(它按加载时读到的 cfg.language 渲染). /reload 后仍然有效. 
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyExtensionTo, isolatedAgentDir, loadPiPackage, makeChecker } from "./harness.mjs";

const NOTIFICATIONS = [];

const UI_STUB = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: (message) => NOTIFICATIONS.push(message),
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
	copyExtensionTo(join(agentDir, "extensions", "token-meter"));

	const configFile = join(agentDir, "token-meter.json");
	writeFileSync(configFile, JSON.stringify({ live: false, language: "en" }));

	const { piPackage } = await loadPiPackage();
	const { createAgentSession, SessionManager } = piPackage;

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

		const runner = session.extensionRunner;
		const commandNames = () => runner.getRegisteredCommands().map((command) => command.name ?? command.invocationName);
		check("pi 发现并加载了扩展:命令已注册", commandNames().includes("token-meter-settings"), commandNames().join(","));
		check(
			"命令描述是固定英文的 <扩展名> Settings(<配置文件>)(不随语言变)",
			runner.getCommand("token-meter-settings")?.description === "Token Meter Settings(token-meter.json)",
			runner.getCommand("token-meter-settings")?.description,
		);
		check("结算行入口渲染器已注册", !!runner.getEntryRenderer("token-meter.summary"));
		check(
			"事件 handler 挂在真实运行时上",
			session.hasExtensionHandlers("agent_settled") && session.hasExtensionHandlers("message_update"),
		);
		// 配置在扩展加载时就被读到了: 命令带参数时的用法提示按配置语言(这里是 en)
		NOTIFICATIONS.length = 0;
		await runner.getCommand("token-meter-settings")?.handler("x", { mode: "tui", ui: UI_STUB });
		check(
			"配置在加载时被读到(用法提示按配置语言 en)",
			/No arguments/.test(NOTIFICATIONS.at(-1) ?? ""),
			NOTIFICATIONS.at(-1),
		);
		check(
			"扩展来自隔离目录",
			runner.getExtensionPaths().some((path) => path.includes("token-meter")),
			runner.getExtensionPaths().join(","),
		);

		await session.reload({});
		const reloaded = session.extensionRunner;
		check("reload 后命令仍在", reloaded.getRegisteredCommands().some((command) => (command.name ?? command.invocationName) === "token-meter-settings"));
		check("reload 后入口渲染器仍在", !!reloaded.getEntryRenderer("token-meter.summary"));

		// 改配置 + reload:语言换到中文, 只影响界面文案; 命令描述始终是固定英文
		writeFileSync(configFile, JSON.stringify({ live: false, language: "zh" }));
		await session.reload({});
		check(
			"reload 后命令描述仍是固定英文",
			session.extensionRunner.getCommand("token-meter-settings")?.description === "Token Meter Settings(token-meter.json)",
			session.extensionRunner.getCommand("token-meter-settings")?.description,
		);
		NOTIFICATIONS.length = 0;
		await session.extensionRunner.getCommand("token-meter-settings")?.handler("x", { mode: "tui", ui: UI_STUB });
		check(
			"reload 后配置重新被读到(用法提示按配置语言 zh)",
			/不接受参数/.test(NOTIFICATIONS.at(-1) ?? ""),
			NOTIFICATIONS.at(-1),
		);

		// 首次使用:配置文件不存在时, 会话启动会落一份默认配置(让用户找得到这个文件)
		rmSync(configFile, { force: true });
		await session.reload({});
		check(
			"配置文件不存在时会话启动落一份默认配置",
			existsSync(configFile) && readFileSync(configFile, "utf8").includes('"live": true'),
			existsSync(configFile) ? readFileSync(configFile, "utf8").slice(0, 80) : "(missing)",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	return failures();
}
