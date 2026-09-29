/**
 * 跑全部测试: node test/run.mjs [unit|real|config]
 */
import { run as config } from "./config.test.mjs";
import { run as real } from "./real.test.mjs";
import { run as unit } from "./unit.test.mjs";

const suites = { unit, real, config };
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const selected = requested.length > 0 ? requested : Object.keys(suites);

let failures = 0;
const started = process.hrtime.bigint();

for (const name of selected) {
	const run = suites[name];
	if (!run) {
		console.error(`没有这个测试集: ${name}(可选: ${Object.keys(suites).join(", ")})`);
		process.exit(2);
	}
	failures += await run();
}

const seconds = Number(process.hrtime.bigint() - started) / 1e9;
console.log(failures === 0 ? `\n全部通过(${selected.join(", ")}, ${seconds.toFixed(1)}s)` : `\n${failures} 个用例失败`);
process.exit(failures === 0 ? 0 : 1);
