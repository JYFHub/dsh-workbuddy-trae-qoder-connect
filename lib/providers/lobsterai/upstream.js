/**
 * LobsterAI 上游（网易有道）的常量与请求原语 —— 签到、积分、模型目录、聊天共用这一份。
 *
 * ## 为什么单独成层
 *
 * 签到与聊天打的是**同一个 host、同一套 Bearer 鉴权、同一个 `{code,msg,data}` 信封**。
 * 若各写一份，改版本号或补请求头时必然漏改一处（本项目在 `shared/http.js` 已经吃过
 * 「四份逐字相同的副本」的教训）。这里只放「与渠道无关的上游事实」，不掺业务。
 *
 * ## 三条实测结论（2026-10-29，本机真实 token 活体验证）
 *
 * 1. **聊天是 OpenAI 兼容的**：`POST /api/proxy/v1/chat/completions`，请求/响应形状
 *    与 OpenAI 一致（SSE 的 `data:` 块就是标准 `chat.completion.chunk`）。
 * 2. **上游无视 `stream:false`**：传 false 也照回 `text/event-stream`。所以消费方
 *    必须按 SSE 读；要非流式只能自己聚合（见 `shim.js` 的 `aggregateSse`）。
 * 3. **`reasoning_effort` 不做严格校验**：`bogus_xyz` 也回 200。但 `off` 是**真的**
 *    有效 —— 实测 `reasoning_tokens` 归零，其余档位都仍有思考 token。这条差异是
 *    档位映射的依据（不像 Qoder 那样 `off` 会被 400 拒绝）。
 *
 * @module dsh-lobsterai-connect/upstream
 */

/** 上游网关（网易有道）。 */
export const LOBSTERAI_BASE = "https://lobsterai-server.youdao.com";

/** 每日签到活动 code（实机确认；slot 接口会回同一个值）。 */
export const LOBSTERAI_ACTIVITY_CODE = "daily-check-in-evergreen-prod-20260814";

/**
 * 客户端版本号：签到 slot 接口与 `User-Agent` / `X-LobsterAI-Client-Version` 都要带。
 *
 * 这是集成时本机桌面客户端实测可用的值（2026.10.23）。上游对这个值**不敏感**——
 * 它是查询参数/UA 的一部分，版本号漂移只影响部分活动的可见性，不影响鉴权。
 * 如需跟随真实客户端，可改这里，或通过 `LOBSTERAI_CLIENT_VERSION` 环境变量覆盖。
 */
export const LOBSTERAI_CLIENT_VERSION =
  process.env.LOBSTERAI_CLIENT_VERSION && process.env.LOBSTERAI_CLIENT_VERSION.trim() !== ""
    ? process.env.LOBSTERAI_CLIENT_VERSION.trim()
    : "2026.10.23";

/** 签到 slot 的 placement 串（与桌面客户端一致）。 */
export const LOBSTERAI_PLACEMENT = "desktop_sidebar";

/** 平台串（slot 接口要带）。 */
export const LOBSTERAI_PLATFORM =
  process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "win32";

/**
 * 客户端能力声明 —— 照抄桌面客户端的取值。
 *
 * `thinking-level-control-v1` 是档位生效的前提：不带它时上游按「客户端不会调档」
 * 处理。`virtual-models-v1` 与 `kimi-k3-agentic-v1` 同属客户端握手，一起带上
 * 才能拿到与桌面客户端一致的模型行为。
 */
/**
 * 客户端能力声明 —— 取桌面客户端能力列表的**子集**。
 *
 * 带上：
 *   · `thinking-level-control-v1` —— 思考档位生效的前提；不带它上游按「客户端不会调档」处理。
 *   · `kimi-k3-agentic-v1` —— 与桌面客户端一致的模型可见性（实测会多放出 1 个 Kimi 条目）。
 *
 * **故意不带 `virtual-models-v1`**（2026-10-29 实测）：
 * 带上它，目录会额外下发两个**虚拟模型** `yd-fast`（快速）/ `yd-ultra`（旗舰）—— 它们不是
 * 可直接对话的模型，而是要先打 `POST /api/models/<id>/resolve` 拿 `{mode, sessionId}` 的
 * 路由壳子。直接拿它们发聊天，上游回 **HTTP 200 + `event:error`**
 * `不支持的模型: yd-fast (allowed providers: LobsterAI)`。
 * 不带这个能力，目录就是 32 个真实模型，干净且都能直接聊。
 */
export const LOBSTERAI_CLIENT_CAPABILITIES = "kimi-k3-agentic-v1,thinking-level-control-v1";

/** 取上游数值字段，非有限数一律 undefined（不要 0 也不要 NaN）。 */
export const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * 上游请求头。
 *
 * @param token - 桌面客户端 SQLite 里的 accessToken。
 * @param options.stream - 是否声明接受 SSE（只影响 `Accept`，上游并不据此改行为）。
 */
export function lobsterHeaders(token, options = {}) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: options.stream === true ? "text/event-stream" : "application/json",
    "User-Agent": `LobsterAI/${LOBSTERAI_CLIENT_VERSION}`,
    "X-LobsterAI-Client-Version": LOBSTERAI_CLIENT_VERSION,
    "X-LobsterAI-Client-Capabilities": LOBSTERAI_CLIENT_CAPABILITIES,
  };
}

/**
 * 调一次上游 JSON 接口（非流式）。失败抛 Error（带状态码与响应片段）。
 *
 * @param method - HTTP 方法。
 * @param path - 以 `/` 开头的路径（含 query）。
 * @param token - accessToken。
 * @param body - 需要 JSON 体时传入。
 * @param timeoutMs - 超时；默认 15s。
 */
export async function lobsterApi(method, path, token, body, timeoutMs = 15000) {
  const init = {
    method,
    headers: lobsterHeaders(token),
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${LOBSTERAI_BASE}${path}`, init);
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 120)}`);
  }
}

/**
 * 解上游统一信封 `{code, message, data}` → data。
 *
 * code 非 0（且字段存在）视为错误；有 `data` 字段就取 data；都没有则原样返回。
 * 注意上游的说明字段叫 `message`（签到那批接口）也见过 `msg`，两个都认。
 */
export function unwrapLobsterEnvelope(envelope) {
  if (envelope && typeof envelope === "object") {
    if ("code" in envelope && envelope.code !== 0 && envelope.code !== undefined && envelope.code !== null) {
      throw new Error(`上游错误 code=${envelope.code} msg=${envelope.message ?? envelope.msg ?? ""}`);
    }
    if ("data" in envelope && envelope.data !== undefined && envelope.data !== null) return envelope.data;
  }
  return envelope;
}
