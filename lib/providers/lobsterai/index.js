/**
 * LobsterAI 渠道的宿主半侧驱动（dsh-connect 的子模块，与 workbuddy/trae/qoder 同地位）。
 *
 * ## 这一版做到哪一步
 *
 * **登录 + 签到 + 积分 + 模型聊天**（四件齐了）。
 *
 * - **登录**：LobsterAI 没有官方开放 API，凭据（accessToken / refreshToken）由桌面客户端
 *   写入它自己的本地 SQLite（`%APPDATA%/LobsterAI/lobsterai.sqlite` 的 `kv` 表
 *   `auth_tokens` / `auth_user`）。本驱动**只读**这份本地库取 token，不要求用户粘贴任何东西。
 * - **签到**：LobsterAI 的每日签到是「客户端活动」—— `slot → context → actions/check_in →
 *   复核`，活动 code `daily-check-in-evergreen-prod-20260814`。这套协议是**实机用本机 token
 *   活体验证过**的（与本项目「用真实客户端实测」的纪律一致）。
 * - **积分**：真实余额在 `/api/user/profile-summary` 的 `totalCreditsRemaining`（实测 1000，
 *   由 10 个「每日登录奖励」批次 × 100 组成，各带到期时间）。
 *   ⚠️ 2026-10-29 更正：早先以为上游没有余额端点、拿签到累计 `claimedCredits`（3400）当积分
 *   展示 —— **那个数不对**。累计值只增不减，用来看余额会系统性偏高。余额端点是从桌面客户端的
 *   `app.asar` 里捞出字面量 `/api/user/quota`、`/api/user-credit/credit` 后才找到的；
 *   前 25 条候选路径全 404，是因为**根本没猜中命名**，不是端点不存在。
 * - **聊天**：`POST /api/proxy/v1/chat/completions`，OpenAI 兼容。走本地回环 shim 转发
 *   （见 `./shim.js`），模型目录来自 `/api/models/available`（实测 31 个，1 个 `accessible:false`）。
 *
 * ## 读取本地 SQLite 的双保险
 *
 * 优先 `node:sqlite`（进程内，最快）；若该宿主没开 `--experimental-sqlite` 标志，
 * `import("node:sqlite")` 会抛错，立刻回退到 `python3` 子进程读（只读连接 `mode=ro`）。
 * 读的是用户**自己**桌面客户端的库，只读、不写、不加锁抢占，安全。
 *
 * ## token 过期为什么不在这里刷
 *
 * 刷新要打 `/api/auth/refresh`，请求体带 `keyfrom` 签名（桌面客户端那套）。为一个
 * 兜底路径复刻签名算法不划算，而且桌面客户端自己会在使用/启动时刷新本地 token。
 * 所以 401 时如实告诉用户「打开桌面客户端重新登录」，不做静默重试。
 *
 * @module dsh-lobsterai-connect
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { briefMessage, loopbackRequest, withLegacyImageBudget, writeJson } from "../../shared/http.js";
import { pollInterval } from "../../shared/node.js";
import { diffCatalog } from "../../shared/catalog-diff.js";
import {
  LOBSTERAI_ACTIVITY_CODE,
  LOBSTERAI_CLIENT_VERSION,
  LOBSTERAI_PLACEMENT,
  LOBSTERAI_PLATFORM,
  lobsterApi,
  num,
  unwrapLobsterEnvelope,
} from "./upstream.js";
import { LobsterAICatalog } from "./catalog.js";
import { createLobsterShim } from "./shim.js";
import { createLobsterAdapter } from "./adapter.js";

export const name = "llm-lobsterai";
export const inject = ["llm"];

/** DSH 里对用户展示的 provider id，也是模型选择器上那一组的名字（= 渠道名）。 */
export const LOBSTERAI_PROVIDER = "lobsterai";
const LOBSTERAI_DISPLAY_NAME = "LobsterAI";

/** 附件像素预算（与另外三条渠道同量级）。 */
const REQUEST_IMAGE_BUDGETS = { requestImagePixelBudget: 4194304 };

/** 上游「账号与积分」端点（字面量取自桌面客户端 app.asar）。 */
const PATH_PROFILE_SUMMARY = "/api/user/profile-summary";

//#region 本地 SQLite 定位与读取

/**
 * 桌面客户端 LobsterAI 的 SQLite 路径。
 *
 * 各平台落点不同；逐个候选探测，返回第一个存在的，都不存在则返回一个合理默认值
 * （供 {@link lobsteraiConfigured} 判 false）。
 */
export function lobsteraiDbPath() {
  const roots = [];
  const appdata = process.env.APPDATA;
  const localappdata = process.env.LOCALAPPDATA;
  const home = homedir();
  if (appdata) roots.push(join(appdata, "LobsterAI", "lobsterai.sqlite"));
  if (localappdata && localappdata !== appdata) roots.push(join(localappdata, "LobsterAI", "lobsterai.sqlite"));
  roots.push(join(home, "Library", "Application Support", "LobsterAI", "lobsterai.sqlite"));
  roots.push(join(home, ".config", "LobsterAI", "lobsterai.sqlite"));
  for (const candidate of roots) {
    if (existsSync(candidate)) return candidate;
  }
  return roots[0] ?? "";
}

/** 桌面客户端是否安装（SQLite 库文件存在）。面板据此判定「该渠道在不在用」。 */
export function lobsteraiConfigured() {
  const path = lobsteraiDbPath();
  return path !== "" && existsSync(path);
}

/** 解析可用的 python3 解释器（用于回退读取 SQLite）。 */
function python3Bin() {
  const home = homedir();
  const candidates = [
    // 用户可用环境变量强制指定解释器路径（任意平台）。
    process.env.LOBSTERAI_PYTHON && process.env.LOBSTERAI_PYTHON.trim() !== "" ? process.env.LOBSTERAI_PYTHON.trim() : null,
    // 本机 WorkBuddy 随附的嵌入式 python（稳定可用）：用 homedir() 拼出**原生 Windows 路径**
    // （`C:\Users\...\python3`），不能用 `/c/Users/...` 这种 POSIX 串 —— Windows 的 spawn 不认。
    join(home, ".workbuddy", "binaries", "python", "versions", "3.13.12", "python3"),
    join(home, ".workbuddy", "binaries", "python", "versions", "3.13.12", "python3.exe"),
    "python3",
    "python",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-c", "import sqlite3"], { stdio: "ignore", timeout: 3000 });
      return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

let nodeSqliteModule = undefined; // undefined=未探测, null=不可用, 否则为模块

async function loadNodeSqlite() {
  if (nodeSqliteModule !== undefined) return nodeSqliteModule;
  try {
    nodeSqliteModule = await import("node:sqlite");
  } catch {
    nodeSqliteModule = null;
  }
  return nodeSqliteModule;
}

/**
 * 读 `kv` 表里某个 key 的 value（字符串），读不到返回 null。
 *
 * `node:sqlite` 优先；抛错（含 SQLITE_BUSY）一律回退 python 子进程。
 */
async function readSqliteValue(key) {
  const sqlite = await loadNodeSqlite();
  if (sqlite && typeof sqlite.DatabaseSync === "function") {
    try {
      const db = new sqlite.DatabaseSync(lobsteraiDbPath(), { readOnly: true });
      try {
        const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
        return row?.value ?? null;
      } finally {
        db.close();
      }
    } catch {
      /* 落到 python */
    }
  }
  const bin = python3Bin();
  if (bin === null) return null;
  try {
    const script = [
      "import os, sqlite3, sys",
      "db = os.environ.get('LOB_DB', '')",
      "key = os.environ.get('LOB_KEY', '')",
      "if not db or not key: sys.exit(0)",
      "try:",
      "    con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)",
      "    cur = con.cursor()",
      "    r = cur.execute('SELECT value FROM kv WHERE key=?', (key,)).fetchone()",
      "    print(r[0] if r else '')",
      "    con.close()",
      "except Exception:",
      "    sys.exit(0)",
    ].join("\n");
    const out = execFileSync(bin, ["-c", script], {
      env: { ...process.env, LOB_DB: lobsteraiDbPath(), LOB_KEY: key },
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const text = out.trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/**
 * 从桌面客户端 SQLite 还原登录凭据。
 *
 * 返回 `{ accessToken, refreshToken, userId, nickname, yid }`；任何失败（库不存在、
 * 没有 auth_tokens、token 为空）都返回 null。
 */
export async function readLobsterCredential() {
  if (!lobsteraiConfigured()) return null;
  try {
    const tokensRaw = await readSqliteValue("auth_tokens");
    if (!tokensRaw) return null;
    const tokens = JSON.parse(tokensRaw);
    const userRaw = await readSqliteValue("auth_user");
    const user = userRaw ? JSON.parse(userRaw) : {};
    const accessToken = typeof tokens.accessToken === "string" ? tokens.accessToken : "";
    if (accessToken === "") return null;
    return {
      accessToken,
      refreshToken: typeof tokens.refreshToken === "string" ? tokens.refreshToken : "",
      userId: typeof user.id === "string" ? user.id : "",
      nickname: typeof user.nickname === "string" ? user.nickname : "",
      yid: typeof user.yid === "string" ? user.yid : "",
    };
  } catch {
    return null;
  }
}

//#endregion

//#region 上游读取：账号 / 积分 / 签到

/**
 * 账号与积分快照。
 *
 * 余额取 `totalCreditsRemaining`（**这才是"还剩多少积分"**）；`creditItems` 是分成
 * 批次发放的记录（实测全是「每日登录奖励」100/条），这里只汇总条数与最早到期时间，
 * 让"余额为什么是这个数"在面板上说得清。
 */
async function fetchAccountSnapshot(token) {
  const data = unwrapLobsterEnvelope(await lobsterApi("GET", PATH_PROFILE_SUMMARY, token));
  const items = Array.isArray(data?.creditItems) ? data.creditItems : [];
  const expiries = items
    .map((item) => item?.expiresAt)
    .filter((value) => typeof value === "string" && value !== "")
    .sort();
  return {
    total: num(data?.totalCreditsRemaining),
    itemCount: items.length,
    expiresAt: expiries[0],
    /** 账号访问状态：`ACTIVE` 正常；其它值意味着账号被限制，值得如实上报。 */
    accessState: typeof data?.accountAccess?.state === "string" ? data.accountAccess.state : undefined,
    accessMessage: typeof data?.accountAccess?.message === "string" ? data.accountAccess.message : undefined,
    nickname: typeof data?.nickname === "string" ? data.nickname : "",
  };
}

/** 取签到活动状态：slot → context，返回 `{ code, rev, state }`。 */
async function fetchCheckInState(token) {
  const slot = unwrapLobsterEnvelope(
    await lobsterApi(
      "GET",
      `/api/client-activities/slot?placement=${encodeURIComponent(LOBSTERAI_PLACEMENT)}&clientVersion=${encodeURIComponent(
        LOBSTERAI_CLIENT_VERSION,
      )}&containerApiVersion=2&platform=${encodeURIComponent(LOBSTERAI_PLATFORM)}`,
      token,
    ),
  );
  const code = typeof slot?.activity?.activityCode === "string" ? slot.activity.activityCode : LOBSTERAI_ACTIVITY_CODE;
  const rev = typeof slot?.activity?.configRevision === "number" ? slot.activity.configRevision : 1;
  const context = unwrapLobsterEnvelope(
    await lobsterApi("GET", `/api/client-activities/${encodeURIComponent(code)}/context?configRevision=${rev}`, token),
  );
  const state = context?.state ?? {};
  const revision = typeof context?.configRevision === "number" ? context.configRevision : rev;
  return { code, rev: revision, state };
}

/**
 * 执行一次签到：slot → context → actions/check_in → 复核。
 *
 * 返回 `{ state, message }`，state 取面板 checkinOf 认识的八态之一
 * （claimed / already-claimed / failed）。
 */
async function performCheckIn(token) {
  const before = await fetchCheckInState(token);
  if (before.state.claimedToday === true) return { state: "already-claimed", message: "今天已经签到过了" };
  const body = { configRevision: before.rev, idempotencyKey: randomUUID(), payload: {} };
  await lobsterApi("POST", `/api/client-activities/${encodeURIComponent(before.code)}/actions/check_in`, token, body);
  const after = await fetchCheckInState(token);
  const claimedNow = after.state.claimedToday === true;
  const daysIncreased = (num(after.state.claimedDays) ?? 0) > (num(before.state.claimedDays) ?? 0);
  if (claimedNow || daysIncreased) return { state: "claimed", message: "签到成功" };
  return { state: "failed", message: "签到后复核未确认（claimedToday 未变化）" };
}

//#endregion

//#region 路由

export const LOBSTERAI_STATUS_ROUTE = "/plugins/dsh-lobsterai-connect/status";
export const LOBSTERAI_CHECKIN_ROUTE = "/plugins/dsh-lobsterai-connect/checkin";

/** 状态文档：signed-in/out + 账号 + 积分 + 签到 + 模型目录。 */
export async function lobsteraiWebStatus(deps) {
  const base = { provider: LOBSTERAI_PROVIDER, channel: LOBSTERAI_DISPLAY_NAME };
  const credential = await deps.credential().catch(() => null);
  if (credential === null) {
    return {
      ...base,
      status: "signed-out",
      reason: "未检测到桌面客户端 LobsterAI 的登录态（lobsterai.sqlite 无 auth_tokens）；请先在桌面客户端登录。",
    };
  }
  try {
    const [account, checkin] = await Promise.all([
      fetchAccountSnapshot(credential.accessToken),
      fetchCheckInState(credential.accessToken),
    ]);
    const state = checkin.state;
    const claimedToday = state.claimedToday === true;
    const reward = num(state.rewardCredits);
    const models = deps.catalog?.current?.() ?? [];
    return {
      ...base,
      status: "signed-in",
      account: account.nickname || credential.nickname || credential.yid || credential.userId,
      email: credential.yid !== "" ? credential.yid : undefined,
      userId: credential.userId,
      credits: {
        // 真实可用余额（不是签到累计！）。
        total: account.total,
        // 今日签到可领多少 —— 已经签过就不再宣称"还能领"，免得和余额对不上。
        todayReward: claimedToday ? undefined : reward,
        itemCount: account.itemCount,
        expiresAt: account.expiresAt,
      },
      ...account.accessState !== undefined && account.accessState !== "ACTIVE"
        ? { accountAccess: account.accessState, accountMessage: account.accessMessage }
        : {},
      checkin: {
        claimedToday,
        claimedDays: num(state.claimedDays),
        rewardCredits: reward,
        available: state.completed !== true,
      },
      models: models.map((model) => ({ id: model.id, name: model.name, rate: model.rate })),
      modelCount: models.length,
      catalogSource: deps.catalog?.source?.(),
      ...(deps.catalog?.lastError?.() === undefined ? {} : { catalogError: deps.catalog.lastError() }),
    };
  } catch (error) {
    // 上游/网络问题：降级成 signed-out 并带上原因，而不是让整个文档 500
    // —— 否则面板这一行会整条消失，用户连"为什么"都看不到。
    return { ...base, status: "signed-out", reason: briefMessage(error) };
  }
}

/** 签到路由：GET 读状态（只读），POST 尝试领取。 */
export async function lobsteraiCheckinAction(deps, method) {
  const credential = await deps.credential().catch(() => null);
  if (credential === null) return { state: "signed-out" };
  if (method === "GET") {
    try {
      const { state } = await fetchCheckInState(credential.accessToken);
      return {
        state: "signed-in",
        checkin: {
          claimedToday: state.claimedToday === true,
          claimedDays: num(state.claimedDays),
          rewardCredits: num(state.rewardCredits),
        },
      };
    } catch (error) {
      return { state: "failed", message: briefMessage(error) };
    }
  }
  try {
    return await performCheckIn(credential.accessToken);
  } catch (error) {
    return { state: "failed", message: briefMessage(error) };
  }
}

function lobsteraiRouteHandler(handle) {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: "request-not-trusted" });
      return;
    }
    try {
      writeJson(res, 200, await handle(req.method, req.headers));
    } catch (error) {
      writeJson(res, 500, { error: briefMessage(error) });
    }
  };
}

export function registerLobsterStatusRoutes(ctx, deps) {
  for (const [path, handle] of [
    [LOBSTERAI_STATUS_ROUTE, () => lobsteraiWebStatus(deps)],
    [LOBSTERAI_CHECKIN_ROUTE, (method) => lobsteraiCheckinAction(deps, method)],
  ]) {
    ctx.effect(() => {
      const dispose = ctx.webServer.register({ kind: "exact", path, handler: lobsteraiRouteHandler(handle) });
      return () => {
        dispose();
      };
    }, `dsh-lobsterai-connect: ${path}`);
  }
}

//#endregion

//#region 插件入口

/** provider 自己不知道面板的存在；lib/index.js 启动时用 setExternalHidden 注入禁用列表。 */
let externalHidden = () => [];
export function setExternalHidden(fn) {
  externalHidden = typeof fn === "function" ? fn : () => [];
}

/**
 * 目录签名：id + 声明档位。用来判断"这一轮重拉之后选择器要不要重建"。
 *
 * 只比 id 不够 —— 上游调整档位比增删模型频繁得多（Qoder 那条渠道上已经踩过这个坑）。
 */
function catalogSignature(models) {
  return models
    .map((model) => `${model.id}:${Array.isArray(model.declaredLevels) ? [...model.declaredLevels].sort().join("/") : ""}`)
    .sort()
    .join("|");
}

export function apply(ctx, config) {
  let stopped = false;
  const credential = () => readLobsterCredential();
  const catalog = new LobsterAICatalog({ credential, logger: ctx.logger });
  const shim = createLobsterShim({ credential, logger: ctx.logger });

  // 渠道状态行（账号 / 积分 / 签到 / 模型数）走 DSH 自己的 webServer，不是回环 shim ——
  // 前者给浏览器同源读取，后者只给 pi-ai 发 OpenAI 请求。webServer 在非 web
  // profile 里不存在，所以用 ctx.inject 做可选依赖。
  ctx.inject(["webServer"], (webCtx) => {
    if (stopped) return;
    try {
      registerLobsterStatusRoutes(webCtx, { credential, catalog });
    } catch (error) {
      ctx.logger?.warn?.("dsh-lobsterai-connect: 状态路由注册失败（渠道本身不受影响）", error);
    }
  });

  /** 适配器重建器；拿到之前是 no-op（目录尚未就绪时不该广播）。 */
  let rebuildAdapter = () => {};

  shim.ready
    .then(async () => {
      if (stopped) return;
      // 先拉一次目录：注册适配器时就带上模型，避免"要等 30 秒才出现"。
      await catalog.reload();
      if (stopped) return;
      let signature = catalogSignature(catalog.current());
      const { adapter, invalidate } = createLobsterAdapter({
        shim,
        catalog,
        providerId: LOBSTERAI_PROVIDER,
        displayName: LOBSTERAI_DISPLAY_NAME,
        hidden: () => externalHidden(LOBSTERAI_PROVIDER),
        /** 附件仓库解析器；缺了它，带图请求会被宿主在进 pi-ai 之前拒掉（UNSUPPORTED_CONTENT）。 */
        resolveAttachments: () => {
          const store = ctx.get("attachments");
          return store === undefined ? undefined : withLegacyImageBudget(store, REQUEST_IMAGE_BUDGETS.requestImagePixelBudget);
        },
      });
      const release = ctx.llm.registerAdapter([LOBSTERAI_PROVIDER], adapter);
      try {
        ctx.effect(() => () => {
          release();
          shim.close();
        });
      } catch {
        release();
        shim.close();
      }

      rebuildAdapter = () => {
        invalidate();
        try {
          ctx.emit("llm/adapters-updated");
        } catch (error) {
          ctx.logger?.warn?.("dsh-lobsterai-connect: 广播模型更新失败", error);
        }
      };
      ctx.logger?.info?.(`dsh-lobsterai-connect: LobsterAI 已就绪（${catalog.current().length} 个模型）`);

      const refresh = async () => {
        if (stopped) return;
        await catalog.reload();
        if (stopped) return;
        const next = catalogSignature(catalog.current());
        if (next === signature) return;
        signature = next;
        rebuildAdapter();
      };
      await refresh();
      const timer = setInterval(() => {
        void refresh();
      }, pollInterval(config));
      timer.unref?.();
      ctx.effect(() => () => {
        clearInterval(timer);
      });
    })
    .catch((error) => {
      ctx.logger?.error?.("dsh-lobsterai-connect: 回环 shim 启动失败", error);
    });

  ctx.effect(() => () => {
    stopped = true;
  });

  // 面板「更新模型」：强制重拉目录并广播；差异带档位（目录是档位的真值来源）。
  return {
    kind: "lobsterai",
    forceRefresh: async () => {
      const before = catalog.current();
      const list = await catalog.reload();
      rebuildAdapter();
      const after = Array.isArray(list) ? list : catalog.current();
      return {
        source: catalog.source(),
        count: after.length,
        ...(catalog.lastError() === undefined ? {} : { catalogError: catalog.lastError() }),
        ...diffCatalog(before, after, (entry) => entry?.declaredLevels),
      };
    },
  };
}

//#endregion
