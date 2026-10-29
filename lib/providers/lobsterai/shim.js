/**
 * LobsterAI 的回环 OpenAI shim —— DSH/pi-ai 与上游之间的那一段本地管道。
 *
 * ## 为什么要有它（而不是让 pi-ai 直连上游）
 *
 * `api: "openai-completions"` 的请求由 pi-ai 发出，它能自定义的只有 `baseUrl` 与
 * `apiKey`。但 LobsterAI 上游有三处它表达不了的东西：
 *
 * 1. **额外的握手头**：`X-LobsterAI-Client-Version` / `X-LobsterAI-Client-Capabilities`。
 * 2. **凭据是异步的**：accessToken 躺在桌面客户端的 SQLite 里，每次现读；pi-ai 的
 *    `apiKey` 只能是同步字符串。
 * 3. **上游无视 `stream:false`**：它永远回 SSE（实测）。pi-ai 走流式没问题，但非流式
 *    调用方需要有人替它把 SSE 拼成整包。
 *
 * 这三件事都放在这里，pi-ai 那边就只看见一个标准的 OpenAI 端点。
 *
 * ## ⚠️ 上游用「HTTP 200 + `event:error`」表达业务错误
 *
 * 这是本渠道最容易踩的坑（2026-10-29 实测）：模型选错、额度不足、账号受限时，HTTP 状态
 * **仍然是 200**，错误藏在 SSE 的 `event:error` 事件里：
 *
 * ```
 * event:error
 * data:{"type":"error","error":{"type":"proxy_error","message":"不支持的模型: yd-fast ..."}}
 * ```
 *
 * 若原样透传，pi-ai 只会看到一串它不认识的 `event:error`，典型表现是**空回复**
 * （`content:""` + `finish_reason:"stop"`）—— 完全看不出真实原因。所以这里做两件事：
 *   · 首个事件就是 error 且还没发头 → 回**真正的** HTTP 502 并带上上游原文；
 *   · 流中途才出错 → 转成 OpenAI 形状的 `data:{"error":{...}}` 事件，让 pi-ai 报出来。
 *
 * ## 与另外三条渠道同构
 *
 * 127.0.0.1 + 随机端口 + 每次启动随机的 bearer + Host/Origin 双回环校验。
 * 逐条对齐 qoder/trae/workbuddy 的 shim —— 安全边界不因新增渠道而放松。
 *
 * @module dsh-lobsterai-connect/shim
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { LOBSTERAI_BASE, lobsterHeaders } from "./upstream.js";
import { abortOnClientDisconnect, hostIsLoopback, originIsLoopback, writeJson } from "../../shared/http.js";
import { readBody } from "../../shared/node.js";

/** 上游聊天端点（OpenAI 兼容面）。 */
const PATH_CHAT = "/api/proxy/v1/chat/completions";

/**
 * 上游不认的字段 —— 透传只会增加被拒风险。
 *
 * `stream_options`：上游总在最后一个 chunk 里带 `usage`（实测），不需要请求它。
 * `n` / `logprobs` / `top_logprobs` / `user`：上游未声明支持。
 */
const DROP_FIELDS = ["stream_options", "n", "logprobs", "top_logprobs", "user"];

/** OpenAI 形状的错误体（pi-ai 认得 `error.message` / `error.code`）。 */
function writeOpenAIError(res, status, code, message) {
  writeJson(res, status, { error: { message, type: code, code } });
}

/**
 * OpenAI → LobsterAI 的消息清洗。
 *
 * 只做一件刚需：`developer` → `system`。
 * pi-ai 对**声明了 reasoning 的模型**会用 OpenAI 新拼写 `developer` 发系统提示，
 * 而上游的角色白名单只有 `system/assistant/user/tool`（同一坑在 Qoder 上以
 * `developer is not one of [...]` 的 400 现形过）。两者语义等同，归一化不丢内容。
 *
 * 其余字段（`content` 数组里的 `text` / `image_url`、`tool_calls`、`tool_call_id`）
 * 原样保留 —— 上游就是 OpenAI 形状，不需要翻译。
 */
export function toLobsterMessages(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== "object") continue;
    const role = message.role === "developer" ? "system" : message.role;
    out.push({ ...message, role: typeof role === "string" ? role : "user" });
  }
  if (out.length === 0) out.push({ role: "user", content: "" });
  return out;
}

/**
 * 把 pi-ai 的 OpenAI 请求体翻成上游能吃的体。
 *
 * - `stream` 强制 `true`：上游本来就不理 `false`，显式置真省得两边对赌。
 * - `max_completion_tokens` → `max_tokens`：上游只认后者（pi-ai 已按
 *   `compat.maxTokensField` 收敛，这里再兜一层，防止宿主版本漂移）。
 * - 丢弃 {@link DROP_FIELDS}。
 */
export function toUpstreamBody(request) {
  const body = {};
  for (const [key, value] of Object.entries(request ?? {})) {
    if (DROP_FIELDS.includes(key)) continue;
    if (key === "messages") {
      body.messages = toLobsterMessages(value);
      continue;
    }
    body[key] = value;
  }
  if (body.max_tokens === undefined && typeof body.max_completion_tokens === "number") {
    body.max_tokens = body.max_completion_tokens;
  }
  delete body.max_completion_tokens;
  body.stream = true;
  return body;
}

/**
 * 增量 SSE 解析器：把字节流切成 `{ event, data }`。
 *
 * 必须自己解析而不能按行 `startsWith("data:")` 直接透传，因为要认 `event:error`
 * （错误消息和正常 delta 一样是 `data:` 行，只有靠事件名区分）。
 *
 * 事件在**空行**处结束；`data:` 后的空格可有可无（上游实测写的是 `data:{...}`，
 * 没有空格），所以只剥一个可选前导空格，不 trim 整个 payload（避免破坏 JSON 字符串内
 * 的空白）。
 */
export function createSseParser(onEvent) {
  let buffer = "";
  let event = "";
  let data = "";

  const dispatch = () => {
    const name = event;
    const payload = data;
    event = "";
    data = "";
    if (name === "" && payload === "") return;
    onEvent({ event: name, data: payload });
  };

  const line = (raw) => {
    const value = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (value === "") {
      dispatch();
      return;
    }
    if (value.startsWith("event:")) {
      event = value.slice("event:".length).trim();
      return;
    }
    if (value.startsWith("data:")) {
      const rest = value.slice("data:".length);
      data = rest.startsWith(" ") ? rest.slice(1) : rest;
      return;
    }
    // id: / retry: / 注释行（以 ":" 开头）一律忽略 —— 上游没有用到，但保持宽容。
  };

  return {
    push(text) {
      buffer += text;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    },
    end() {
      if (buffer !== "") {
        line(buffer);
        buffer = "";
      }
      dispatch();
    },
  };
}

/** 从 `event:error` 的 payload 里取一句人话。 */
export function messageOfErrorEvent(payload) {
  try {
    const parsed = JSON.parse(payload);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    /* 不是 JSON 就退回原文 */
  }
  return String(payload).slice(0, 300) || "上游返回错误（无内容）";
}

/** 把一串 chunk 合并成非流式补全的中间状态。 */
function mergeChunk(state, chunk) {
  if (chunk === null || typeof chunk !== "object") return;
  if (typeof chunk.id === "string" && chunk.id !== "") state.id = chunk.id;
  if (typeof chunk.model === "string" && chunk.model !== "") state.model = chunk.model;
  if (typeof chunk.created === "number") state.created = chunk.created;
  if (chunk.usage !== undefined && chunk.usage !== null) state.usage = chunk.usage;
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  if (choice === undefined || choice === null) return;
  if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;
  const delta = choice.delta ?? choice.message ?? {};
  if (typeof delta.content === "string") state.content += delta.content;
  if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content;
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    const index = Number.isInteger(call?.index) ? call.index : state.toolCalls.length;
    if (state.toolCalls[index] === undefined) {
      state.toolCalls[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
    }
    const slot = state.toolCalls[index];
    if (typeof call.id === "string" && call.id !== "") slot.id = call.id;
    if (typeof call.type === "string" && call.type !== "") slot.type = call.type;
    if (typeof call.function?.name === "string") slot.function.name = call.function.name;
    if (typeof call.function?.arguments === "string") slot.function.arguments += call.function.arguments;
  }
}

/** 中间状态 → OpenAI 非流式补全。 */
function completionOf(state) {
  const message = { role: "assistant", content: state.content === "" ? null : state.content };
  if (state.reasoning !== "") message.reasoning_content = state.reasoning;
  const calls = state.toolCalls.filter((call) => call !== undefined);
  if (calls.length > 0) message.tool_calls = calls;
  if (message.content === null && calls.length === 0) message.content = "";
  return {
    id: state.id === "" ? `chatcmpl-lobsterai-${Date.now()}` : state.id,
    object: "chat.completion",
    created: state.created === 0 ? Math.floor(Date.now() / 1000) : state.created,
    model: state.model,
    choices: [{ index: 0, message, finish_reason: state.finishReason ?? "stop" }],
    ...(state.usage === undefined ? {} : { usage: state.usage }),
  };
}

/** 把一批 chunk 对象合并成非流式补全（导出供探针复用）。 */
export function aggregateChunks(chunks) {
  const state = { id: "", created: 0, model: "", content: "", reasoning: "", finishReason: undefined, usage: undefined, toolCalls: [] };
  for (const chunk of chunks) mergeChunk(state, chunk);
  return completionOf(state);
}

/**
 * 把 SSE 文本拼成一条非流式补全。
 *
 * 上游只回 SSE，非流式调用方（手动验证渠道、宿主的非流式分支）需要有人替它拼。
 * 覆盖：文本增量、`reasoning_content` 增量、`tool_calls` 分段（按 `index` 合并
 * `function.arguments`）、`finish_reason`、`usage`。
 */
export function aggregateSse(text) {
  const chunks = [];
  const parser = createSseParser((event) => {
    if (event.event === "error" || event.data === "" || event.data === "[DONE]") return;
    try {
      chunks.push(JSON.parse(event.data));
    } catch {
      /* 非 JSON 事件跳过 */
    }
  });
  parser.push(String(text));
  parser.end();
  return aggregateChunks(chunks);
}

/**
 * 建回环 shim。
 *
 * @param options.credential - 异步取凭据（`{ accessToken }` 或 null）。
 * @param options.logger - 宿主 logger（可选）。
 */
export function createLobsterShim(options) {
  const { credential, logger } = options;
  /** 每次启动换一份共享密钥；只在 127.0.0.1 上用。 */
  const SHARED_SECRET = randomBytes(32).toString("base64url");

  function bearerOk(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) return false;
    const given = Buffer.from(match[1]);
    const expected = Buffer.from(SHARED_SECRET);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  const ready = new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(0, "127.0.0.1");
  const baseUrl = () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("dsh-lobsterai-connect: shim 没有监听地址");
    return `http://127.0.0.1:${address.port}`;
  };

  async function handle(req, res) {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, "host_not_allowed", "Host 必须是回环地址");
        return;
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, "origin_not_allowed", "Origin 必须是回环地址");
        return;
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, "unauthorized", "Authorization bearer 缺失或不匹配");
        return;
      }
      const url = req.url ?? "/";
      if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
        // 只用于自检；pi-ai 的模型表来自 adapter 的 buildModels()。
        writeJson(res, 200, { object: "list", data: [] });
        return;
      }
      if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
        await chatCompletions(req, res);
        return;
      }
      writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) writeOpenAIError(res, 500, "internal", message);
      else res.end();
    }
  }

  async function chatCompletions(req, res) {
    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.toLowerCase().includes("application/json")) {
      writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type 必须是 application/json");
      return;
    }
    /**
     * 取消接线：客户端断开时 abort 上游。
     *
     * 判据是 `res` 的 `'close'`（**不是** `req` 的）—— 理由见
     * `shared/http.js` 的 `abortOnClientDisconnect`：`req` 的 `'close'` 在请求体
     * 读完时就触发，会把每个正常请求都误判成「客户端已取消」。
     */
    const controller = new AbortController();
    abortOnClientDisconnect(res, controller);

    let request;
    try {
      request = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      writeOpenAIError(res, 400, "invalid_json", "请求体不是合法 JSON");
      return;
    }
    const wantsStream = request?.stream !== false;

    const current = await credential().catch(() => null);
    if (current === null) {
      writeOpenAIError(
        res,
        401,
        "not_signed_in",
        "未检测到 LobsterAI 登录态：请先在桌面客户端 LobsterAI 登录，插件会自动读取本地登录凭据。",
      );
      return;
    }

    let upstream;
    try {
      upstream = await fetch(`${LOBSTERAI_BASE}${PATH_CHAT}`, {
        method: "POST",
        headers: lobsterHeaders(current.accessToken, { stream: true }),
        body: JSON.stringify(toUpstreamBody(request)),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (!res.headersSent) writeOpenAIError(res, 499, "aborted", "客户端已取消");
        else res.end();
        return;
      }
      writeOpenAIError(res, 502, "upstream_unreachable", `连不上 LobsterAI 上游：${error?.message ?? error}`);
      return;
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      const snippet = detail.slice(0, 300);
      if (upstream.status === 401 || upstream.status === 403) {
        /**
         * 凭据过期。插件**不去刷** token：刷新要 `keyfrom` 签名（见桌面客户端的
         * `/api/auth/refresh` 调用），而桌面客户端自己会在启动/使用时刷。这里把
         * 恢复动作直接告诉用户，比悄悄失败好。
         */
        writeOpenAIError(
          res,
          401,
          "token_expired",
          `LobsterAI 登录态已失效，请打开桌面客户端 LobsterAI 重新登录后再试。上游返回：${snippet}`,
        );
        return;
      }
      writeOpenAIError(res, upstream.status === 429 ? 429 : 502, "upstream_error", `上游返回 ${upstream.status}：${snippet}`);
      return;
    }

    /**
     * 读上游流并逐事件转发。
     *
     * 响应头**压到第一个正常事件再发**：这样「首个事件就是 `event:error`」时还能回
     * 真正的 502，而不是先把 200 发出去再道歉。
     */
    let headersSent = false;
    const sendHeaders = () => {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // 排掉中间代理缓冲（桌面宿主里通常没有代理，但本地端口也可能被拦）。
        "X-Accel-Buffering": "no",
      });
    };

    /** 首事件错误（还没发头）→ 记下来，由调用方回 502。 */
    let earlyFailure;
    /** 流中途的错误 → 转成 OpenAI 形状事件，让 pi-ai 报出来。 */
    const parsed = [];
    const parser = createSseParser((event) => {
      if (event.event === "error") {
        const message = messageOfErrorEvent(event.data);
        if (!headersSent && earlyFailure === undefined) {
          earlyFailure = message;
          return;
        }
        logger?.warn?.(`dsh-lobsterai-connect: 上游流中途报错 — ${message}`);
        sendHeaders();
        res.write(`data: ${JSON.stringify({ error: { message, type: "proxy_error" } })}\n\n`);
        return;
      }
      if (event.data === "") return;
      if (event.data === "[DONE]") {
        if (wantsStream) {
          sendHeaders();
          res.write("data:[DONE]\n\n");
        }
        return;
      }
      if (!wantsStream) {
        try {
          parsed.push(JSON.parse(event.data));
        } catch {
          /* 跳过非 JSON */
        }
        return;
      }
      sendHeaders();
      res.write(`data:${event.data}\n\n`);
    });

    if (upstream.body === null) {
      if (wantsStream) sendHeaders();
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    try {
      for await (const chunk of Readable.fromWeb(upstream.body)) {
        parser.push(decoder.decode(chunk, { stream: true }));
        // 首事件就是错误：立刻停，别再往下读也别再往客户端写。
        if (earlyFailure !== undefined) break;
        if (controller.signal.aborted) break;
      }
      parser.end();
    } catch (error) {
      if (!controller.signal.aborted) {
        logger?.warn?.(`dsh-lobsterai-connect: 上游流中断 — ${error?.message ?? error}`);
      }
    }

    if (earlyFailure !== undefined) {
      if (!headersSent) writeOpenAIError(res, 502, "upstream_error", earlyFailure);
      else res.end();
      return;
    }
    if (!wantsStream) {
      writeJson(res, 200, aggregateChunks(parsed));
      return;
    }
    sendHeaders();
    res.end();
  }

  return {
    ready,
    baseUrl,
    /** 共享密钥：pi-ai 侧作为 apiKey 发回来。 */
    token: () => SHARED_SECRET,
    close: () => {
      server.close();
    },
  };
}
