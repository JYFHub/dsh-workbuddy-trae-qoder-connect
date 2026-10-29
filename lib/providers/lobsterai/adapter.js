/**
 * 把 LobsterAI 的模型目录装成 pi-ai 的 provider + DSH 的 adapter。
 *
 * 结构与 qoder/trae/workbuddy 三条渠道一致：`createProvider(...)` 产出 pi-ai 的
 * provider 描述，`PiAiAdapter` 用一份 profile 把它接到宿主的 `llm` 服务上。
 * baseUrl 指向本地 shim（`http://127.0.0.1:<port>/v1`），由 shim 负责鉴权与转发。
 *
 * ## 思考档位为什么直接按声明映射
 *
 * Qoder 那条渠道把 `off` 置 `null`，因为上游对 `off` 返回 **400**。LobsterAI 相反：
 * 实测 `reasoning_effort:"off"` 回 200 且 `reasoning_tokens` 归零（其余档位都有思考
 * token），所以这里的 `off` 是**真档位**，照声明放行。
 *
 * 上游目录声明的档位是逐模型的（`thinkingConfig.options[].level`，常见
 * `off / high / max`），因此这里逐模型生成 `thinkingLevelMap`；未声明的键置 `null`
 * —— pi-ai 对「缺失键」与「null」处理不对称，缺失会被当成支持并用默认值。
 *
 * @module dsh-lobsterai-connect/adapter
 */

import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { hiddenMatcher } from "../../shared/hidden.js";

/** 流式请求在两次数据之间允许的最长静默。与 qoder 同值。 */
export const LOBSTERAI_STREAM_IDLE_TIMEOUT_MS = 300000;

/** pi-ai 模型描述里要显式写 0，否则计费面板会按未知价格处理。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};

/**
 * pi-ai 的 auth 平面在本插件里必须是惰性的：认证只走 shim 的共享密钥，
 * 由 `resolveApiKey` 每个请求现取，pi-ai 自己不该凭空造一份凭据出来。
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error("dsh-lobsterai-connect: the lobsterai route has no pi-ai credential lifecycle");
    },
    async delete() {},
  },
  authContext: {
    async env() {},
  },
};

/** pi-ai 认的档位键（`thinkingLevelMap` 的键必须落在这一组里）。 */
const LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 倍率挂在名字上：`DeepSeek-V4.1-Flash` → `DeepSeek-V4.1-Flash · x0.1`。
 *
 * DSH 的模型下拉只渲染 `model.name`（不读 `description`），所以想让用户看到
 * 「这个模型贵不贵」只能挂在名字上。拿不到倍率就原样返回，不硬凑。
 */
function withRateName(info) {
  const rate = info.rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return info.name;
  return `${info.name} · x${Number(rate.toFixed(2))}`;
}

/**
 * 逐模型生成 pi-ai 的推理字段。
 *
 * 判据是**上游声明**：`supportsThinking === true` 且至少声明了一个档位。声明为空
 * 一律 `reasoning: false` —— 宁可不给档位，也不要给一个必然被上游忽略的下拉。
 */
export function reasoningFieldsFor(info) {
  const declared = new Set(Array.isArray(info?.declaredLevels) ? info.declaredLevels : []);
  if (info?.supportsThinking !== true || declared.size === 0) return { reasoning: false };
  const map = {};
  for (const key of LEVEL_KEYS) map[key] = declared.has(key) ? key : null;
  return { reasoning: true, thinkingLevelMap: map };
}

/**
 * 建 LobsterAI 的 adapter。
 *
 * @param options.shim - `createLobsterShim` 的返回值（要 `baseUrl()` 与 `token()`）。
 * @param options.catalog - `LobsterAICatalog`。
 * @param options.providerId - DSH provider id（默认 `lobsterai`，与渠道注册表一致）。
 * @param options.displayName - 选择器上那一组的名字。
 * @param options.hidden - 返回「面板禁用」的模型 id 列表。
 * @param options.resolveAttachments - 附件仓库解析器；缺了它带图请求会在进 pi-ai
 *   之前被宿主以 `UNSUPPORTED_CONTENT` 拒掉（详见 `shared/http.js` 的说明）。
 */
export function createLobsterAdapter(options) {
  const { shim, catalog } = options;
  const providerId = options.providerId ?? "lobsterai";
  const displayName = options.displayName ?? "LobsterAI";
  /** [dsh-connect] 面板禁用的模型 id（每次构建列表时重读，改完立即生效）。 */
  const hidden = options.hidden ?? (() => []);

  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`;
    // hiddenMatcher 返回的是判定函数（(id) => boolean），按函数调用 ——
    // 曾把它当 Set 调 .has()，每次构建列表都抛 TypeError，选择器里整个渠道消失。
    const isHidden = hiddenMatcher(hidden());
    return catalog
      .current()
      .filter((info) => info.accessible !== false && !isHidden(info.id))
      .map((info) => ({
        id: info.id,
        name: withRateName(info),
        api: "openai-completions",
        provider: providerId,
        baseUrl,
        input: info.supportsImages === true ? ["text", "image"] : ["text"],
        ...reasoningFieldsFor(info),
        cost: NO_COST,
        contextWindow: info.contextWindow,
        maxTokens: info.maxTokens,
        compat: { maxTokensField: "max_tokens" },
      }));
  };

  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: "LobsterAI 回环凭据（由插件自己维护，无需填写）",
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: "LobsterAI" };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: LOBSTERAI_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, "dsh-lobsterai-connect retryPolicy"),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };
  let profiles = new Map([[providerId, profile]]);
  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
      resolveAttachments: options.resolveAttachments,
    }),
    invalidate: () => {
      profiles = new Map([[providerId, profile]]);
    },
  };
}
