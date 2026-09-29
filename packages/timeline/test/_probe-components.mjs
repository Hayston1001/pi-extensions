/** 看看 pi 的各种消息组件会不会被 timeline 的分类器误认成 user / assistant / bash.  */
import { piPackage, PI_PACKAGE } from "./harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(join(PI_PACKAGE, "package.json"));
const pi = piPackage;
const tuiPath = require.resolve("@earendil-works/pi-tui");
const { Text } = await import(pathToFileURL(tuiPath).href);

const check = (name, component) => {
	if (!component || component.error) return console.log(name.padEnd(30), "(造不出来)", component?.error ?? "");
	const kinds = [];
	if (typeof component.text === "string" && typeof component.rebuild === "function" && typeof component.outputPad === "number") kinds.push("user");
	if (typeof component.updateContent === "function" && "lastMessage" in component) kinds.push("assistant");
	if (typeof component.command === "string" && Array.isArray(component.outputLines) && typeof component.appendOutput === "function") kinds.push("bash");
	console.log(name.padEnd(30), "| 误分类:", (kinds.join(",") || "无").padEnd(12), "| 字段:", Object.keys(component).slice(0, 12).join(","));
};

const theme = pi.getMarkdownTheme();
const T0 = Date.now();
const mk = (fn) => {
	try {
		return fn();
	} catch (error) {
		return { error: String(error).slice(0, 70) };
	}
};

check("UserMessageComponent", mk(() => new pi.UserMessageComponent("你好", theme, 1, [])));
check("AssistantMessageComponent", mk(() => new pi.AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "好" }], timestamp: T0 }, false, theme, "T", 1, [])));
check("BashExecutionComponent", mk(() => new pi.BashExecutionComponent("ls", undefined, false)));
check("ToolExecutionComponent", mk(() => new pi.ToolExecutionComponent("bash", "call-1", { command: "ls" }, {}, undefined, undefined, process.cwd())));
check("CompactionSummaryMessageComponent", mk(() => new pi.CompactionSummaryMessageComponent({ role: "compactionSummary", summary: "摘要", tokensBefore: 1, timestamp: T0 }, theme)));
check("BranchSummaryMessageComponent", mk(() => new pi.BranchSummaryMessageComponent({ role: "branchSummary", summary: "摘要", fromId: "x", timestamp: T0 }, theme)));
check("CustomMessageComponent", mk(() => new pi.CustomMessageComponent({ role: "custom", customType: "t", content: [], display: true, timestamp: T0 }, undefined, theme, 1)));
check("SkillInvocationMessageComponent", mk(() => new pi.SkillInvocationMessageComponent({ name: "skill", userMessage: "用技能做这事", raw: "", frontmatter: {} }, theme)));

try {
	const url = new URL("./dist/modes/interactive/components/custom-entry.js", pathToFileURL(join(PI_PACKAGE, "package.json")));
	const mod = await import(url.href);
	check("CustomEntryComponent", mk(() => new mod.CustomEntryComponent({ type: "custom", id: "e1", timestamp: new Date().toISOString(), customType: "x", content: [] }, undefined)));
} catch (error) {
	console.log("CustomEntryComponent".padEnd(30), "(导入失败)", String(error).slice(0, 70));
}

check("Text(Notice)", mk(() => new Text("Cache miss: 1k tokens", 1, 0)));
