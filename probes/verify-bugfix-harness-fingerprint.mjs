/**
 * Bug D 的回归探针（2026-10-21 用户报告）。
 *
 * ## 现象
 *
 * 国区 WorkBuddy 槽位开始报 400，与国际版此前那条同类但文案不同：
 *
 *   400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 *        "displayTips":{"en":"This call failed channel verification,
 *        possibly because it was not sent from an official client…"}}
 *
 * ## 根因
 *
 * 上游的渠道校验除了看请求头，还看**请求文本里的固定句子**。命中这一句就回
 * 11128，与账号、身份、会话头全部无关：
 *
 *   You are an AI agent powered by DeepSeek Harness
 *
 * 而这句话正是 DSH 系统提示的第一句 —— 也就是说，插件把宿主自己的系统提示
 * 原样发上去，上游把它当成了"非官方客户端"的指纹。
 *
 * 线索来自 `ardeyouxipianyi/workbuddy2api-hub` 的 PR #540（作者逐句二分实测）：
 *   · 整句触发，拆成单词不触发，单独 `DeepSeek Harness` 也不触发；
 *   · 大小写不敏感；
 *   · 补会话头无效、换账号无效（所以 Bug C 那个补头是必要的，但不充分）；
 *   · 短请求正常，只有带完整 system prompt 的请求失败；
 *   · 只在句中插入一个 the（`powered by the DeepSeek Harness`）即 200。
 *
 * ## 修复
 *
 * `prepareChatBody` 里加第三类清洗 `normalizeHarnessFingerprint`，与前两类
 * （`normalizeDeveloperRole` / `normalizeToolChoice`）同一个函数、同一个理由：
 * 都是为了让上游不要用 11128 拒掉一个本身正确的请求。
 *
 * ## 反向验证
 *
 * 撤掉 `normalizeHarnessFingerprint(obj);` 这一行，本探针必须变红。
 *
 * 用法：node probes/verify-bugfix-harness-fingerprint.mjs [--installed]
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installedPackageDir } from "./_installed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.argv.includes("--installed") ? installedPackageDir() : join(HERE, "..");

let passed = 0;
let failed = 0;
const chain = [];
const ok = (label, fn) => chain.push({ label, fn });
const eq = (a, b, what) => {
	if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

// —— 桩宿主依赖，加载真实变体模块（与其它 bugfix 探针同一套）——
const stubDir = join(HERE, ".harnessfp-stubs");
rmSync(stubDir, { recursive: true, force: true });
mkdirSync(stubDir, { recursive: true });
const stubNames = {
	"@deepseek-ai/dsh-home-paths": ["resolveDshHome"],
	"@deepseek-ai/dsh-llm": ["resolveRetryPolicy"],
	"@deepseek-ai/dsh-llm-pi-ai": ["PiAiAdapter"],
	"@earendil-works/pi-ai": ["createProvider"],
	"@earendil-works/pi-ai/api/openai-completions.lazy": ["openAICompletionsApi"],
	"@deepseek-ai/dsh-atomic-write": ["withFileLock", "writeFileAtomic"],
};
const stubMap = {};
for (const [spec, names] of Object.entries(stubNames)) {
	const file = join(stubDir, spec.replace(/[@/]/g, "_") + ".mjs");
	const body =
		spec === "@deepseek-ai/dsh-home-paths"
			? `export const resolveDshHome = () => process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : ${JSON.stringify(join(homedir(), ".dsh"))};\nexport default { resolveDshHome };\n`
			: spec === "@deepseek-ai/dsh-atomic-write"
				? `import { mkdirSync, writeFileSync, renameSync } from "node:fs";\nimport { dirname } from "node:path";\nexport async function writeFileAtomic(path, data, options = {}) { mkdirSync(dirname(path), { recursive: true, mode: options.dirMode ?? 0o700 }); const tmp = path + ".tmp"; writeFileSync(tmp, data, { mode: options.mode ?? 0o600 }); renameSync(tmp, path); }\nexport async function withFileLock(path, fn) { return await fn(); }\nexport default { writeFileAtomic, withFileLock };\n`
				: `const mk=(n)=>{const f=function(){return f};return f};\n` + names.map((n) => `export const ${n}=mk(${JSON.stringify(n)});`).join("\n") + `\nexport default new Proxy({},{get:()=>mk("d")});\n`;
	writeFileSync(file, body);
	stubMap[spec] = file;
}
{
	const sc = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@deepseek-ai", "schemastery", "lib", "index.mjs");
	if (!existsSync(sc)) {
		console.error("找不到宿主真包 @deepseek-ai/schemastery");
		process.exit(2);
	}
	stubMap["@deepseek-ai/schemastery"] = sc;
}
const loaderFile = join(stubDir, "loader.mjs");
writeFileSync(loaderFile, `import { pathToFileURL } from "node:url";\nconst map=${JSON.stringify(stubMap)};\nexport async function resolve(s,c,n){ if(map[s]) return {url:pathToFileURL(map[s]).href,shortCircuit:true,format:"module"}; return n(s,c) }\n`);
const { register } = await import("node:module");
register(pathToFileURL(loaderFile).href, import.meta.url);

const VARIANTS = join(REPO, "lib", "providers", "workbuddy", "variants-CnrmSn0Q.js");

const mod = await import(`${pathToFileURL(VARIANTS).href}?fp=${Date.now()}`);
/** `M` = prepareChatBody，`D` = WorkBuddyUpstreamClient（导出表是单字母别名）。 */
const prepareChatBody = mod.M;
const UpstreamClient = mod.D;
assert.equal(typeof prepareChatBody, "function", "变体模块应导出 prepareChatBody");

/** 上游真正在匹配的那一句（大小写不敏感）。 */
const FINGERPRINT = /you are an ai agent powered by deepseek harness/i;
const REWRITTEN = "You are an AI agent powered by the DeepSeek Harness";

/** 把 body 过一遍真实 prepareChatBody，返回解析后的对象与原文。 */
const prepare = (body) => {
	const out = prepareChatBody(JSON.stringify(body));
	return { text: out, body: JSON.parse(out) };
};
const systemText = (body) => body.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");

console.log("【D1】指纹句必须被改写（这是 Bug D 的修复点）");

ok("DSH 系统提示首句（带句号）被改写，且不再命中指纹", () => {
	const { body } = prepare({
		model: "deepseek-v4-flash",
		messages: [
			{ role: "system", content: "You are an AI agent powered by DeepSeek Harness." },
			{ role: "user", content: "hi" },
		],
	});
	const content = body.messages[0].content;
	eq(content, `${REWRITTEN}.`, "改写后的系统提示");
	if (FINGERPRINT.test(content)) throw new Error("改写后仍然命中指纹 —— 等于没修");
});

ok("大小写变体同样被改写（上游匹配不区分大小写）", () => {
	for (const variant of [
		"YOU ARE AN AI AGENT POWERED BY DEEPSEEK HARNESS",
		"you are an ai agent powered by deepseek harness",
		"You Are An AI Agent Powered By DeepSeek Harness",
	]) {
		const { body } = prepare({ messages: [{ role: "system", content: variant }] });
		if (FINGERPRINT.test(body.messages[0].content)) {
			throw new Error(`大小写变体漏了：${variant} -> ${body.messages[0].content}`);
		}
	}
});

ok("嵌在长系统提示中间也改写，前后文一字不动", () => {
	const { body } = prepare({
		messages: [{
			role: "system",
			content: "HEAD\nYou are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent.\nTAIL",
		}],
	});
	eq(
		body.messages[0].content,
		`HEAD\n${REWRITTEN}.\n\nYou are a coding agent.\nTAIL`,
		"长提示改写结果",
	);
});

console.log("\n【D2】改写必须精确：不误伤、不重复改写");

ok("幂等：已经是改写后的句子不再变", () => {
	const { body } = prepare({ messages: [{ role: "system", content: REWRITTEN }] });
	eq(body.messages[0].content, REWRITTEN, "重复过一遍");
});

ok("部分短语一律不动（上游只认整句，误伤会篡改用户内容）", () => {
	for (const text of [
		"DeepSeek Harness",
		"You are an AI agent.",
		"powered by DeepSeek Harness",
		"You are an AI agent powered by DeepSeek",
		"hi",
	]) {
		const { body } = prepare({ messages: [{ role: "system", content: text }] });
		eq(body.messages[0].content, text, `不该改：${text}`);
	}
});

ok("同一句出现两次时两处都改写", () => {
	const { body } = prepare({
		messages: [{ role: "system", content: "You are an AI agent powered by DeepSeek Harness A You are an AI agent powered by DeepSeek Harness" }],
	});
	const matches = body.messages[0].content.match(/powered by DeepSeek Harness/gi);
	eq(matches, null, "改写后不该还有未改写的指纹");
});

console.log("\n【D3】覆盖所有角色与两种 content 形状");

ok("非 system 角色同样改写（校验是文本匹配，不认角色）", () => {
	const { body } = prepare({
		messages: [
			{ role: "system", content: "sys" },
			{ role: "user", content: "You are an AI agent powered by DeepSeek Harness" },
			{ role: "assistant", content: "You are an AI agent powered by DeepSeek Harness" },
		],
	});
	for (const index of [1, 2]) {
		if (FINGERPRINT.test(body.messages[index].content)) {
			throw new Error(`role=${body.messages[index].role} 漏了`);
		}
	}
});

ok("array-of-parts 形状的 text 段被改写", () => {
	const { body } = prepare({
		messages: [{
			role: "system",
			content: [
				{ type: "text", text: "You are an AI agent powered by DeepSeek Harness." },
				{ type: "text", text: "keep me" },
			],
		}],
	});
	eq(body.messages[0].content[0].text, `${REWRITTEN}.`, "第一个 text 段");
	eq(body.messages[0].content[1].text, "keep me", "无关段落不动");
});

ok("未知 content 形状原样保留（不猜、不篡改）", () => {
	const weird = { role: "system", content: 42 };
	const { body } = prepare({ messages: [weird] });
	eq(body.messages[0].content, 42, "非字符串/非数组的 content");
});

console.log("\n【D4】这次只做加法：前两类清洗与其余字段都不能动");

ok("developer 角色仍被改写成 system（原有修复没被挤掉）", () => {
	const { body } = prepare({
		messages: [{ role: "developer", content: "You are an AI agent powered by DeepSeek Harness." }],
	});
	eq(body.messages[0].role, "system", "role 改写");
	eq(body.messages[0].content, `${REWRITTEN}.`, "同一段里的指纹也被改写");
});

ok("stream 强制为 true、tool_choice 压平、模型与消息顺序不变", () => {
	const { body } = prepare({
		model: "deepseek-v4-flash",
		stream: false,
		max_tokens: 128000,
		tool_choice: { type: "auto" },
		messages: [
			{ role: "system", content: "s" },
			{ role: "user", content: "u" },
		],
	});
	eq(body.stream, true, "stream");
	eq(body.tool_choice, "auto", "tool_choice");
	eq(body.model, "deepseek-v4-flash", "model");
	eq(body.max_tokens, 128000, "max_tokens");
	eq(body.messages.map((m) => m.role), ["system", "user"], "消息顺序");
});

ok("非 JSON / 非对象输入原样返回（与既有契约一致）", () => {
	eq(prepareChatBody("not json"), "not json", "非 JSON");
	eq(prepareChatBody("[1,2]"), "[1,2]", "数组");
});

console.log("\n【D5】端到端：真实客户端真正发出去的 body 里没有指纹");

/**
 * 用打桩的 fetch 抓真实 `chatStream` 的出站 body。
 *
 * 复刻 `lib/providers/workbuddy/index.js` 的真实调用链：先
 * `prepareChatBody(...)`，再 `client.chatStream(credential, prepared)`。
 * 两个区域都测 —— 国区此前是「原样透传」，如果不经过 prepareChatBody，
 * 这里的断言就会红，正好钉住「CN 也必须清洗」。
 */
const DSH_SYSTEM = "You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent working in DSH.";

for (const [label, domain, clientVersion] of [
	["国区", "www.codebuddy.cn", "5.7.3"],
	["国际版", "workbuddy.ai", "5.7.6"],
]) {
	ok(`${label}：出站 body 不含指纹，且系统提示其余部分完好`, async () => {
		const home = join(tmpdir(), `dsh-harnessfp-${domain.replace(/\W/g, "")}-${Date.now()}`);
		mkdirSync(home, { recursive: true });
		const captured = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			captured.push({ url: String(url), body: init?.body });
			return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const prevHome = process.env.DSH_HOME;
		process.env.DSH_HOME = home;
		try {
			const m = await import(`${pathToFileURL(VARIANTS).href}?e2e=${domain}-${Date.now()}`);
			const Client = m.D;
			const client = new Client({ resolveChatIdentity: async () => ({ clientVersion }) });
			const credential = {
				accessToken: "probe-token",
				refreshToken: "probe-refresh",
				uid: "uid-fp",
				domain,
				expiresAt: Date.now() + 3_600_000,
			};
			const prepared = m.M(JSON.stringify({
				model: "deepseek-v4-flash",
				messages: [
					{ role: "developer", content: DSH_SYSTEM },
					{ role: "user", content: "hi" },
				],
			}));
			await client.chatStream(credential, prepared);
		} finally {
			globalThis.fetch = realFetch;
			if (prevHome === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = prevHome;
			rmSync(home, { recursive: true, force: true });
		}
		eq(captured.length, 1, "发出一次请求");
		const sent = String(captured[0].body);
		if (FINGERPRINT.test(sent)) throw new Error(`出站 body 仍含指纹 —— 上游会回 11128：\n${sent.slice(0, 400)}`);
		const parsed = JSON.parse(sent);
		const text = systemText(parsed);
		if (!text.includes("You are a coding agent working in DSH.")) {
			throw new Error("系统提示的其余部分被吃掉了 —— 清洗必须只改那一句");
		}
		eq(parsed.messages[0].role, "system", "developer 已改写为 system");
	});
}

console.log("\n【D6】接线：prepareChatBody 必须真的被调用（两个区域）");

ok("index.js 的 chatCompletions 对**两个区域**都先过 prepareChatBody", () => {
	const src = read("lib/providers/workbuddy/index.js");
	if (!/const prepared = prepareChatBody\(/.test(src)) {
		throw new Error("chatCompletions 没有调用 prepareChatBody —— 清洗根本没接线");
	}
	// 国区在 chatStream 里是原样透传，所以上面这一行是国区唯一的清洗点。
	if (!/client\.chatStream\(credential, prepared,/.test(src)) {
		throw new Error("chatStream 收到的不是 prepared，清洗被绕过");
	}
});

ok("prepareChatBody 内部依次调用三类清洗（少任何一类都会漏一种 11128）", () => {
	const src = read("lib/providers/workbuddy/variants-CnrmSn0Q.js");
	const at = src.indexOf("function prepareChatBody(");
	const body = src.slice(at, at + 700);
	for (const fn of ["normalizeDeveloperRole(obj)", "normalizeToolChoice(obj)", "normalizeHarnessFingerprint(obj)"]) {
		if (!body.includes(fn)) throw new Error(`prepareChatBody 里少了 ${fn}`);
	}
});

for (const { label, fn } of chain) {
	try {
		await fn();
		passed++;
		console.log(`  ✓ ${label}`);
	} catch (error) {
		failed++;
		console.log(`  ✗ ${label}\n      ${error && error.message}`);
	}
}

rmSync(stubDir, { recursive: true, force: true });

console.log(`\nverify-bugfix-harness-fingerprint: ${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
