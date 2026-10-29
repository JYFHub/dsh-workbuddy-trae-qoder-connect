/**
 * LobsterAI 模型目录 —— 把 `/api/models/available` 归一化成适配器与面板能直接用的形状。
 *
 * ## 上游原始字段（实测 31 个模型，2026-10-29）
 *
 * ```
 * { modelId, modelName, provider, apiFormat, contextWindow, costMultiplier,
 *   supportsImage, supportsThinking, thinkingConfig: { options:[{level,openclawLevel}], defaultLevel },
 *   accessible, busy, limitedFree, restrictionHint, description, ... }
 * ```
 *
 * 缺的字段（本渠道上游**没有**，不要假装有）：
 *   · `maxTokens` —— 目录不下发单模型输出上限，统一走 {@link LOBSTERAI_MAX_TOKENS}。
 *   · `supportsToolCalling` / `agenticReady` —— 全是 `null`，无法据此判能力，
 *     所以不做工具开关的门控，`tools` 原样透传（上游自己决定认不认）。
 *
 * ## 为什么不带兜底名单
 *
 * Qoder/Trae 有写死的兜底目录，是因为它们的目录接口会因签名/function 槽位问题整体
 * 失败，而模型 id 相对稳定。这里相反：目录一次 GET 就回全量，失败基本等于**没网或
 * 没登录**——此时编一份名单只会让用户在模型选择器里点到必然 401 的条目。
 * 于是失败就保持空列表，等定时重拉或面板「更新模型」恢复。
 *
 * @module dsh-lobsterai-connect/catalog
 */

import { lobsterApi, num, unwrapLobsterEnvelope } from "./upstream.js";

/** 目录接口（Bearer + 信封）。 */
const PATH_MODELS = "/api/models/available";

/**
 * 单模型输出上限。
 *
 * 上游目录不下发这个值。取 32000 与另外三条渠道同一量级：够长回答，又不至于
 * 让上游按超大 `max_tokens` 预留配额（`deepseek-flash` 实测 24 token 就能收尾，
 * 说明该字段只影响上限、不影响计费起步）。
 */
export const LOBSTERAI_MAX_TOKENS = 32000;

/** 上下文窗口的兜底（目录里 `contextWindow` 可能为 null，如 MiniMax-M2.7）。 */
const DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * 从 `thinkingConfig` 取出**该模型真正声明**的档位（线上拼写）。
 *
 * 上游给的选项形如 `[{level:"off",openclawLevel:"off"},{level:"high",openclawLevel:"high"},
 * {level:"max",openclawLevel:"xhigh"}]`。
 *
 * 用 `level` 而不是 `openclawLevel`：`level` 是服务端自己的档位名，也是
 * `reasoning_effort` 的线上拼写（实测 `high`/`max`/`off` 均 200 且 `off` 真把
 * `reasoning_tokens` 打到 0）。`openclawLevel` 是给另一个客户端做翻译用的。
 */
function declaredLevelsOf(model) {
  const config = model?.thinkingConfig;
  const options = Array.isArray(config?.options) ? config.options : [];
  const levels = [];
  for (const option of options) {
    const level = typeof option?.level === "string" ? option.level : "";
    if (level !== "" && !levels.includes(level)) levels.push(level);
  }
  return levels;
}

/** 一条上游模型 → 适配器/面板共用的描述符。 */
function normalizeModel(model) {
  if (model === null || typeof model !== "object") return undefined;
  const id = typeof model.modelId === "string" ? model.modelId : "";
  if (id === "") return undefined;
  const contextWindow = num(model.contextWindow);
  const declaredLevels = declaredLevelsOf(model);
  return {
    id,
    name: typeof model.modelName === "string" && model.modelName !== "" ? model.modelName : id,
    /** 上游的厂商标注（这里恒为 "LobsterAI"，是聚合网关的自有标签）。 */
    provider: typeof model.provider === "string" ? model.provider : "LobsterAI",
    /** 计费倍率：面板与模型名都用它（0.1 → x0.1）。 */
    rate: num(model.costMultiplier),
    contextWindow: contextWindow !== undefined && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
    maxTokens: LOBSTERAI_MAX_TOKENS,
    supportsImages: model.supportsImage === true,
    /** 声明了档位才算支持思考（与 Qoder 同一判据，理由见其 `reasoningFieldsFor`）。 */
    supportsThinking: model.supportsThinking === true && declaredLevels.length > 0,
    declaredLevels,
    defaultLevel: typeof model.thinkingConfig?.defaultLevel === "string" ? model.thinkingConfig.defaultLevel : undefined,
    /** 上游明确标 `accessible:false` 的模型（如 kimi-k3.1-pro-highspeed）不放进选择器。 */
    accessible: model.accessible !== false,
    busy: model.busy === true,
    limitedFree: model.limitedFree === true && model.limitedFreeActive === true,
    restrictionHint: typeof model.restrictionHint === "string" ? model.restrictionHint : undefined,
    description: typeof model.description === "string" ? model.description : undefined,
  };
}

/**
 * 模型目录。
 *
 * `credential()` 是**每轮重读**的凭据源（桌面客户端的 SQLite 可能被客户端自己刷新），
 * 所以不在构造时抓一次 token 存起来。
 */
export class LobsterAICatalog {
  #credential;
  #logger;
  #models = [];
  #source = "empty";
  #error;

  constructor(options) {
    this.#credential = options.credential;
    this.#logger = options.logger;
  }

  /** 当前目录（同步可读，适配器每次构建模型列表都取这里）。 */
  current() {
    return this.#models;
  }

  /** 目录来源：`upstream` / `empty`。面板与状态文件用它解释"为什么没有模型"。 */
  source() {
    return this.#source;
  }

  /** 最近一次失败原因（成功后清空）。 */
  lastError() {
    return this.#error;
  }

  /**
   * 重拉目录。**永不抛**：失败保留上一份，仅记录原因 —— 目录挂了不该把渠道拖垮。
   */
  async reload() {
    const credential = await this.#credential().catch(() => null);
    if (credential === null) {
      this.#source = "empty";
      this.#error = "no credential";
      return this.#models;
    }
    try {
      const payload = unwrapLobsterEnvelope(await lobsterApi("GET", PATH_MODELS, credential.accessToken));
      const list = Array.isArray(payload) ? payload : [];
      const next = list.map(normalizeModel).filter((entry) => entry !== undefined);
      this.#models = next;
      this.#source = "upstream";
      this.#error = undefined;
      return next;
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      this.#logger?.warn?.(`dsh-lobsterai-connect: 模型目录刷新失败 — ${this.#error}`);
      return this.#models;
    }
  }
}
