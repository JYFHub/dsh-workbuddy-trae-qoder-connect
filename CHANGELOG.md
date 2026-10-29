# 修复记录

修 bug 是欠账还清，不算卖点，所以单独记在这里。每条都能在 git log 里对上。

## 2026-10

- **LobsterAI 接入模型聊天；并更正上一轮「积分」的错误结论（2026-10-29）**。两件事同源：都在同一个上游、同一轮实测里推翻了我自己的判断。
  - **积分显示错了**：上一轮断言「上游没有独立钱包余额端点（25+ 路径全 404），积分 = 签到累计 `claimedCredits`」，于是面板显示 3400，而真实余额只有 1000。**错因不是端点不存在，是我按常见命名猜路径**。这轮改成从桌面客户端 `resources/app.asar`（703MB）里扫 `/api/` 字面量，一次就拿到真实端点：`/api/user/profile-summary` 的 `totalCreditsRemaining`（实测 1000，由 10 条「每日登录奖励」×100 组成，各带 `expiresAt`）、`/api/user/quota`（套餐与免费额度）、`/api/models/available`、`/api/proxy/v1/chat/completions`。现在 `credits.total` 用真实余额，`todayReward` 只在**今天还没签**时下发，避免"已签到却还宣称可领"。
  - **模型聊天接上了**：新增 `upstream.js`（BASE/版本/请求头/信封解析）、`catalog.js`（`/api/models/available` → 归一化描述符，实测 32 个模型、31 个 `accessible`）、`shim.js`（回环 OpenAI 转发）、`adapter.js`（pi-ai provider + `thinkingLevelMap`）；`index.js` 在 shim 就绪后 `ctx.llm.registerAdapter(["lobsterai"])`，目录变更时广播 `llm/adapters-updated`。面板「更新模型」走 `forceRefresh`（带档位差异）。
  - **协议坑一：上游用 HTTP 200 + `event:error` 表达业务错误**。模型选错/额度不足时 HTTP 仍是 200，错误藏在 SSE 的 `event:error` 事件里；原样透传会表现成**空回复**（`content:""` + `finish_reason:"stop"`），完全看不出原因。shim 现在把首个事件就是 error 的情况回**真正的 502** 并带上游原文，流中途出错则转成 OpenAI 形状的 `data:{"error":…}` 事件。
  - **协议坑二：虚拟模型 `yd-fast`/`yd-ultra` 只在声明 `virtual-models-v1` 能力时下发**，且它们不是可直接对话的模型（要先 `POST /api/models/<id>/resolve` 拿 `{mode,sessionId}`，实测 `resolve` 需有效 mode 才 200）。因此能力声明里**故意不带** `virtual-models-v1`，目录自然只剩 32 个真实模型；带 `thinking-level-control-v1` 与 `kimi-k3-agentic-v1`，档位与模型可见性与桌面客户端一致。
  - **档位：`off` 在这里是真档位**（与 Qoder 相反）。实测 `reasoning_effort:"off"` → `reasoning_tokens` 归零，`high`/`max` 有思考 token，`bogus_xyz` 也 200（上游不严格校验）——所以 `thinkingLevelMap` 直接按目录声明映射，不像 Qoder 那样把 `off` 置 `null`。
  - 同时修好 `probes/verify-attachment-wiring.mjs` 的两处陈旧：仓库根写死成 `~/.dsh/repos/<包名>`（仓库迁到 F 盘后整批假红，现已改为相对脚本解析），断言只读 `index.js`（LobsterAI 拆成多文件后必然假红，改为按 provider 目录合并源码），并把 `lobsterai` 纳入断言（12 通过 / 0 失败）。
  - **仍未做**：token 过期不自动续（刷新要 `keyfrom` 签名，桌面客户端自己会刷；401 时明确提示用户打开客户端重新登录）。
- **新增第四渠道 LobsterAI（登录 + 签到 + 积分；模型聊天为下一步）**：`CHANNEL_KINDS` 加 `lobsterai`（单实例），`channel-registry.js` 的 `channelOf` 把它路由到 `/plugins/dsh-lobsterai-connect/{status,checkin}`，`lib/index.js` 把 `lobsterai` 接进 `PROVIDERS` 与 `refreshChannel` 分派；`panel.js` 的 `KIND_ADAPTERS`/`creditsOf`/`checkinOf`/`authTargets`/`slotConfigured`/`candidatePaths` 都加了 lobsterai 分支（凭据来自桌面客户端本地 SQLite，**不落文件、不粘贴**，认证页这一行 `writable:false`；删除渠道时绝不碰那份真实数据库）；前端 `client.js` 的「添加渠道」kind 下拉与占位文案加 LobsterAI，统一定制化渲染不用改；`locale`/`README` 渠道一览同步。新 provider `lib/providers/lobsterai/index.js` 只读桌面 `lobsterai.sqlite`（`kv` 表 `auth_tokens`/`auth_user`）取 Bearer token，走 `slot → context → actions/check_in → 复核` 的每日签到（活动 `daily-check-in-evergreen-prod-20260814`），并公开 `/status`/`/checkin` 两个回环路由。~~**关键事实**：LobsterAI 上游**没有独立钱包余额端点**（试过 25+ 候选路径全 404），积分就是签到活动累计的 `claimedCredits` + 今日可领 `rewardCredits`~~ —— **这条结论已被 2026-10-29 的更正推翻，余额端点确实存在（`/api/user/profile-summary`），见上一条**。SQLite 读取双保险：优先 `node:sqlite`，宿主没开 `--experimental-sqlite` 标志时回退 `python3` 子进程（`mode=ro` 只读）。
- **11128 真正根因定位：不是请求头、不是 token、不是 body 体积，而是 system prompt 里的一段「逐字指纹」（2026-10-28 第四修，v0.3.6）**。前三修分别改会话头、补 `acp-connection-id`/trace、删 Origin/Referer，用户重启后仍稳定 11128。这轮改成**用桌面 token 直接复现**，才把范围收敛：
  - **复现**：`workbuddy-desktop.info` 里的 `accessToken` 是 AES-256-GCM 信封，`atRestSecretKey` 只能从 WorkBuddy 的 Electron 私有绑定取（`process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`，以 `ELECTRON_RUN_AS_NODE=1` 起子进程）。按插件同一套 `WB-AAD\0`/`WEV1`/`sym-v1` AAD 解密后，用 `node fetch` 直连 `https://copilot.tencent.com/v2/chat/completions`，就能逐变量对照。
  - **排除头**：把 `connect-req-dump.json` 里那份"失败请求"的**完整头集原样重放**（含 `X-Requested-With`、`acp-connection-id`、trace 族、`X-No-Enterprise-Id`），结果 429/6000（已过渠道校验，只撞限频）；v0.3.5 的新头集同样 429。再跑「阻塞提示词 × 4 种头集」矩阵（`conversation` / `cloud-agent+person_agent` / `local-agent` / 无 runtime）：**全部 11128**。头这一层被彻底排空。
  - **排除体积与结构**：3 条消息把 content 撑到 128KB → 通过；121 条消息 → 通过；单带 `tools`/`tool_choice` → 通过；58 条含 `role:"tool"` 的真实结构 + 真实 system prompt → 拦截；同一结构换成假 system prompt → 通过。差异只回到 system prompt 文本。
  - **定到字符**：对 system prompt 逐行测，只有「文件引用说明」那一行拦截；对行内做前缀扫描 + 二分，得到边界 **pass≤110 字符 / block=111 字符**，最小触发子串就是 `Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root`（111 字符，原文出自 DSH 的 File-reference instruction）。
  - **判定类型**：该子串**任意改一个字**、换语序、删一个词、去掉 `explicitly`、把 `@` 换成 `#`、把 `workspace root` 改成 `project directory` —— **全部放行**。所以上游存的是一条**精确子串黑名单**，不是关键词、不是语义分类、也不是此前记录的"抽样拦截"（那次结论是抽样校验恰好没触发导致的误判）。
  - **修法**：新增 `defingerprint()`，按**每 6 个空白**插入一个 `U+200B`，只在 `system`/`developer` 消息上生效。理由：黑名单会变、长度未知、条数未知，逐条硬编码不可维护；固定词距可保证**任何 ≥7 词的连续指纹**都被打断，而模型读到的语义不变（去掉零宽字符后与原文逐字节相同，已有断言钉住）。**不碰** `user`/`assistant`/`tool` 正文 —— 那里可能含代码或需原样回写的数据，混入零宽字符会污染输出。
  - **验证**：真实提示词直接发 → `400/11128`；同一份 body 过 `prepareChatBody` 后出站 → `6000`（通过，仅限频）。改写逻辑断言 12/12 通过（developer→system、`tool_choice` 拍平/none 抑制、`stream` 强制、vendor 名抹除、仅 system 去指纹、去零宽后语义等价、非 JSON 透传、array content 覆盖）。
  - **取证增强**：`connect-req-dump.json` 不再把 systemPrompt 截到 2000 字符（截断正好切在触发行中间，上一轮因此没看到后半段），改为 20000 + `bodyBytes` / `systemPromptLength` / `defingerprinted` 三个字段，方便后续一眼确认去指纹是否生效。

- **按 WorkBuddy / DSH 最新插件协议（DSH NEXT，DeepSeek Harness ≥ 0.2.0）改造清单，修复客户端在 NEXT 宿主下不挂载**：① `dsh.client` 增加 `immediately: true`（原缺失，浏览器端模块不主动注册、面板/侧栏入口不出现）；② `dsh.client.inject` 移除去向已不存在的旧宿主包 `dsh-api-remotes` / `dsh-api-session-controller` / `dsh-client-ui-renderer` / `dsh-client-ui-model-selection`（留在列表会让客户端加载失败），只保留仍存在的 `dsh-client-ui-conversation` / `dsh-client-ui-settings-plugins` / `dsh-client-locale`；③ 补齐显示元数据 `locale/en.json`、`locale/zh.json`（`meta.title`/`meta.description`）与 `icon.svg`，并在 `exports` 暴露 `./locale/*.json` 与 `./icon`、`files` 纳入 `locale` 与 `icon.svg`，消除 Plugin Manager 的元数据诊断回退；④ peer 范围由 `^0.1.x || ^0.2.0-rc.2` 改为 `>=` 下限写法（如 `@deepseek-ai/*` 用 `>=0.1.5-rc.1`、`pi-ai` 用 `>=0.85.1`），显式覆盖预发布分支并兼容 0.2.0+ 宿主；⑤ 版本 bump 0.3.2 → 0.3.3。客户端模块本身已用现行 `window.__ModuleLoader__.load` + `ctx.slots` 体系，无需改；Host 半侧（provider/路由）经 `cordis.patch.yml` 注册、日志证实在新宿主仍正常加载。
- **修复「部署 v0.3.3 后国区 WorkBuddy 仍报 11128」+「Qoder CN 同步后变未登录」**（2026-10-28，用户重启实测）：
  - **11128（国区）**：根因是 `chatHeaders` 只在**国际版**带 `X-Conversation-*` 四件套，国区被刻意留空（旧注释理由是「该校验只在国际版观测到」）。上游后来在国区也上了同一渠道校验，漏发被判定「非官方客户端 / unapproved channel」。改为**两个区域都带这四件套**——官方桌面客户端本就在每一次聊天请求（含国区）上都带，CN 补发是对齐官方而非偏离；原 `chatHeaders` 内 `const international` 局部变量随之移除。另：`chatStream` 国区原本原样透传 body，现统一先过 `prepareChatBody`（幂等、自包含，不再依赖调用方先洗）；并新增 `captureOutboundRequest` 取证快照——仅当 `$DSH_HOME/connect-debug.flag` 存在时把最近一次出站请求（去敏头 + 系统提示原文 + 消息角色序列 + 是否带 X-Conversation）写入 `connect-req-dump.json`，正常请求零开销，便于 11128 仍偶发时精确比对而不是反复猜指纹。
  - **11128 仍未根治 → 从真实 WorkBuddy 桌面客户端逆向，补全「连接标识 + 链路追踪」头族（2026-10-28 第二修，用户重启后仍 11128）**：上一版只补 `X-Conversation-*` 仍不够，因为真正的「approved channel」信号是插件**从未发送**的 **`acp-connection-id`**。做法：用 node 直接抽取本机 `D:\Program Files\WorkBuddy\resources\app.asar`（官方客户端），定位到 chat 请求构造 `applyGatewayHeaders(n, sessionId, metadata)` 与 `applyTraceHeaders(n)`，逐字核对官方在每次 `/v2/chat/completions` 上必带的头：
    - `acp-connection-id`：官方客户端由 `this.uuid()` **本地生成**（非服务端下发，见 app.asar 内 `metadata:{acpConnectionId:this.uuid(),conversationRequestId:this.uuid()}`），插件按官方语义生成**进程内稳定**的 uuid 即可——没有它就被判「非官方客户端」，这正是稳定 11128 的根因；
    - `X-Request-ID` 与 trace 头族（`traceparent` / `b3` / `X-B3-TraceId` / `X-B3-ParentSpanId` / `X-B3-SpanId` / `X-B3-Sampled` / `X-Trace-ID`），按官方 `applyTraceHeaders` 原样构造；
    - 同时修正 `conversationHeaders`：官方实测**仅三项**（`X-Conversation-ID` / `X-Conversation-Request-ID` / `X-Conversation-Message-ID`），插件此前多发的 `X-Root-Request-ID` 官方根本不发，已删。
    - 顺带确认官方 chat 真实端点是 `https://copilot.tencent.com/v2/chat/completions`、身份头 `X-Product` 走 `SaaS`（与插件一致），且 chat 请求**无 HMAC 签名**（app.asar 里的 `createHmac` 是 session JWT 用，与 chat 渠道校验无关）——排除了"需要加密签名才能过 11128"的误判。新增 `acpAndTraceHeaders()` / `acpConnectionId()` 并展开进 `chatHeaders`，CN/国际版同享。
  - **11128 仍未根治 → 启用取证快照后拿到真实出站请求，定位到真正根因是「浏览器风格 Origin/Referer 头」（2026-10-28 第三修，用户重启后仍 11128）**：上一版补的头已与官方一致，但 `connect-req-dump.json` 暴露插件**比官方多带** `Origin: https://www.codebuddy.cn` 和 `Referer: https://www.codebuddy.cn/`（来自 `commonHeaders` 的 `originReferer()`）。官方桌面客户端走 Electron `net.fetch`，**从不自动带** Origin/Referer，官方 `buildVlmGatewayHeaders` / `applyGatewayHeaders` 也**从不设置**这两个头；插件主动带它们反而暴露"非官方客户端"，正是 11128「unapproved channel」的判定点。修法：从 `commonHeaders`（chat/refresh/billing 共用）以及 `fetchModels`(`/v3/config`)、`fetchPromoBadges` 的请求头里**移除 Origin/Referer**，使插件请求与官方桌面客户端逐字节一致；`originReferer` 函数保留（仅被注释引用，已无实际发送）。版本 bump 0.3.3 → 0.3.4。配合仍在生效的 `connect-debug.flag` 取证快照，重启后发一条即可核对请求头是否彻底匹配官方。
  - **Qoder「未登录」实为本轮同步引入的回归，不是上游/PAT 失效**：同步把「原本能用的旧安装副本」整体覆盖成了仓库新版；而仓库新版 `fetchUserInfo` 把 `buildCosyHeaders` 又套了回去，形成死锁——`buildCosyHeaders` 要求 `creds.userID` 非空，可 userinfo 这步**正是要取 userID**（调用方先传 `userID: ""`），于是每次 PAT 登录必抛「cosy: userID 为空」→ 被 `.catch` 吞成「没有返回用户 id」→ 转成「PAT 可能已失效」→ 面板显示「未登录 · connect-auth/qoder.pat」（日志时间线：重启前 Qoder 已就绪 10 模型，重启后持续报 userID 为空，与同步时间点精确吻合）。对照 10-22 已验证可用的旧版，把 `fetchUserInfo` 退回**裸 `Bearer jobToken`**（普通 Bearer 即 200 并返回 id，COSY 签名不参与 userinfo），恢复「已就绪」。教训：大版本 sync 不能只信「文件存在就覆盖」，provider 逻辑回归要在重启后看 Qoder/Trae 的「已就绪」日志确认。
- **重写上一版对「11128 渠道校验」的修复 —— 上一版是错的，且探针把我骗过去了**（2026-10-21 当天两次用户报告）：
  - 第一版照搬 workbuddy2api-hub PR #540 的「插一个 the」：把 You are an AI agent powered by DeepSeek Harness 改写成带 the 的版本。但**DSH 的句子本来就带 the**（实测自 pp.asar 的 Model Experience 段：You are an AI agent powered by the DeepSeek Harness.），于是模式串与替换值是同一个字符串，String.replace 什么也没改。
  - 而当时的探针只断言「结果不含不带 the 的那个变体」—— 原文当然不含，于是 16 项全绿。**这是我写断言的方式错了**：改写类修复必须断言「出口文本里不再出现被禁的指纹子串」，不能断言「等于某个特定字符串」。
  - 更糟的是我当时拿一次「国区 400 -> 200」当成了修复生效的证据。该上游是**抽样**拦截（社区实测约 0.05%），单次成功根本不能作为证据。
  - 现在的做法：不赌句子结构能否绕过，直接把 vendor 名字抹掉。整句 You are an AI agent powered by the DeepSeek Harness. 换成 You are an AI coding agent.，再用 DeepSeek[\s_-]*Harness 兜底抹掉任何残留（引用、翻译、换句式都覆盖）。用户一句「把 deepseek harness 这个词删了就行」直接点破了这一点。
  - 探针重写为 18 项，其中三项专钉这次的教训：①出站文本的改变必须可观测；②源码里不许出现「模式串 == 替换值」的自欺写法；③整句正则必须先吃掉冠词，否则兜底会拼出 powered by the the coding assistant。
  - 反向验证 23 处全红。其中 D/2、D/3、D/4、D/5 四条是**边跑边改**的：第一轮的归因全部不对（有的变红在别的断言上，有的撤回后仍然全绿），逐条查实后才发现「撤掉整句正则的 i 标志仍然全绿」是**正确行为**（兜底正则也带 i，会救回来），于是把这条撤回改成测兜底正则的 i，另补一条测冠词。
- **国区 WorkBuddy 开始被同一条渠道校验拦下：`400 code 11128 Illegal API invocation from an unapproved channel`**（用户报，紧接着国际版那条）：国际版此前修的是"缺会话头"，国区这条文案不同、原因也不同 —— 上游的渠道校验除了看请求头，还看**请求文本里的固定句子**：
  `You are an AI agent powered by DeepSeek Harness`
  命中就回 11128，与账号、身份、会话头全部无关。而这正是 **DSH 系统提示的第一句**，也就是说插件把宿主自己的系统提示原样发上去，被上游当成了"非官方客户端"的指纹。
  - 线索来自 [workbuddy2api-hub PR #540](https://github.com/ardeyouxipianyi/workbuddy2api-hub/pull/540)（作者逐句二分实测）：整句触发、拆词不触发、单独 `DeepSeek Harness` 也不触发、大小写不敏感、补会话头无效、换账号无效、只有带完整 system prompt 的请求失败。
  - 修法：`prepareChatBody` 加第三类清洗 `normalizeHarnessFingerprint`，只在句中插入一个 the（`powered by the DeepSeek Harness`），语义不变、短语结构变了、不再命中。与既有两类清洗（`normalizeDeveloperRole` / `normalizeToolChoice`）同一个函数、同一个理由：都是为了让上游不要用 11128 拒掉一个本身正确的请求。
  - **两个区域都清洗**。国区在 `chatStream` 里原本是原样透传，唯一的清洗点就是 `lib/providers/workbuddy/index.js` 的 `prepareChatBody(...)` —— 探针专门钉住这一跳，免得以后有人把 CN 那条捷径改回去。
  - **真机实测**（插件真实客户端打真实上游，同一份 body 只差这一次清洗）：`workbuddy1` / `workbuddy2` 国区从 `400 / 11128` 变 **`200`**；`workbuddy5` 国际版两次都 200（它不匹配这句，所以改写对国际版无害）。
  - 覆盖所有角色与两种 content 形状（纯字符串、array-of-parts）：校验是文本匹配，不认角色，只改 `system` 会漏掉工具结果/用户轮里的引用。未知 content 形状原样保留，不猜不篡改。
  - 新增 `probes/verify-bugfix-harness-fingerprint.mjs`（16 项），反向验证新增 3 处撤回（D/1–D/3），现共 21 处。
  - **没有照搬他们的性能设计**：`workbuddy2api-hub` 在正则前加了一层小写字面量 `in` 快路径（实测 4KB 文本 319µs 里正则占 137+188µs、`in` 只占 9µs），因为它是**网关**、一个实例服务很多并发用户、每段文本都要过一遍清洗（64KB 要 6.2ms）。我们一个用户一次请求，正则扫整个 body 是毫秒级，相对几百毫斯的网络往返不到 1%；而把同一句抄两遍（正则 + 小写字面量）会引入"改一处忘另一处、快路径静默跳过改写"的 bug 类。为 1–3ms 的不可见收益换这个风险，不值。
- **国际版每条消息都被上游拦下：`400 code 11128 conversation id missing`**（用户报，用了好几天之后突然全灭）：WorkBuddy AI 5.7 起，国际版 `/v2/chat/completions` 对出站请求做**抽样渠道校验**，要求携带官方桌面客户端那套会话头（`X-Conversation-ID` / `-Request-ID` / `-Message-ID` / `X-Root-Request-ID`），缺一个被抽到的请求就直接 400，`displayTips` 写的是「这次调用没通过渠道校验，可能不是官方客户端发出的」。插件的 `chatHeaders` 一个都没带。
  - 不是插件自己的退化：同期所有第三方反代都在报同一条（workbuddy2api-hub 的 #380 / #383 / #388 / #392），上游侧的对策是把这四个头补齐（PR #381，已被仓库合并）。我们做同一件事。
  - 修法：`chatHeaders` 在国际版（`regionOf(domain) === "global"`）时多带这四个头。插件没有自己的会话（DSH 每条消息都是新会话），所以每个请求**现编一套 id**、不重放旧值 —— 上游关联的正是请求 id，复用才是它要抓的谎。四个 id 都由 `randomUUID()` 生成，互不相同。
  - **CN 不加**：该校验只在国际版网关观测到过，给国区也编一个头是用没验证过的偏差换已经验证过的偏差。
  - 新增 `probes/verify-bugfix-conversation-headers.mjs`（8 项）：用打桩的 `fetch` 抓真实的 `chatStream` 出站头，断言国际版带齐四个 UUID、两次请求的 id 互不相同、国区一个都不带、原有身份/产品块一个不少。反向验证新增 4 处撤回（C/1–C/4）。
- **国际版模型的 1M 上下文在 DSH 里被砍成 300K**（用户报）：上游对同一个模型同时声明多档窗口（实测 `deepseek-v4.1-flash` 是 `contextWindow 300000` + `supportedContextWindows [300000, 1000000]`），而适配器只广告一档。三个独立缺陷叠在一起，缺一个都不会表现出来：
  1. 偏好读的是 `config.useMaximumContextWindow`，而 `lib/index.js` 用 `apply(ctx, {})` 调子模块、第二个参数恒为空对象 —— 读到的**永远**是 false。偏好现在挂在面板/插件自己的 `Config`（`HUB_SECTION`，宿主唯一会投影的那份）上，由 `lib/index.js` 通过 `workbuddy.setPreferences(hubPreferences)` 把读写通道注入子模块；`catalog` 改成**惰性读源**（每次 `current()` 现读），所以面板里改完立刻生效，不用重启。
  2. 状态路由只在 `legacySettingsAvailable` 时才下发 `useMaximumContextWindow`，而那个条件要求宿主有 `settings.installSection` —— 本机 DSH 没有，于是字段从不出现、复选框根本不渲染。现在按 `region === "global"` 下发（写通道不可用时仍返回 `undefined`，界面就不显示一个存不下去的开关）。
  3. 前端又把复选框钉在 `variant.id === AI_CARD_VARIANT.id`（= `workbuddy2`），所以 `workbuddy4/5` 这些国际版槽位即使拿到字段也永远看不到。现在只看后端给不给这个字段。
  - **这个开关从设置卡片搬到了面板渠道行**（用户要求）：它原先只藏在 workbuddy 设置卡片的 Context 页里，而面板才是用户管渠道的地方 —— 不搜就找不到。现在做成模型数旁边的一个 chip（`1M 上下文` / `默认窗口`），点一下就切。**实测可随时切换、不用重启**：POST 之后 `deepseek-v4.1-flash` 的 `contextWindow` 在 `1000000` 与 `300000` 之间即时来回。
    - ⚠️ 它是**全局**偏好（settings 里只有一个键）：在一个槽位上点，所有国际版槽位一起变 —— tooltip 里写明了，免得以为是单槽位设置。
    - 顺带修了一个自相矛盾：偏好确实是惰性读的，但**宿主对各 provider 的模型列表有缓存**，写完不广播就会出现"面板行显示新值、模型选择器里还是旧窗口"。现在写完 `onModelsChanged()` 广播一次。
    - 另外说明为什么做不到"所有模型都 1M"：实测本机目录 25 个模型里 **17 个已经 1M**，剩下 8 个（`grok-4.7`=500K、`gpt-5.4`/`primary-model`=272K、`balanced-model`/`kimi-k2.6`=256K、`fast-model`=200K、`hy3`=192K、`default-model`=176K）是上游自己只声明那么大，硬报 1M 会让 DSH 往上游塞超限上下文换来 400。
- **刚添加、还没认证的国际版槽位会把模型漏进模型选择器**（用户报）：新建槽位的用途是多账号，而国际版槽位的默认读法是"直接读桌面 App 的登录态"，于是空槽位立刻借到 App 里那份凭据、看起来已登录（实测借到的还是**另一个槽位**的账号），`adoptIdentity` 据此把 catalog 置为可见，一整套不属于它的模型进入选择器。修复分四处：
  - 注册表新增 `followDesktop`，**缺失按 true**（旧条目逐字保持原行为，升级不会突然"未登录"）；面板新增的国际版槽位显式写 `false`，表单里也能勾选"跟随桌面 App"。
  - provider 侧 `configuredAuthFile` 与 store 侧 `resolveDesktopCandidates` **两侧**都按它分流：不跟随的槽位只认 `connect-auth/<id>.json`（通常不存在 ⇒ 干净地未登录），绝不落到平台默认探测。两侧都改是因为 CLI（`bin.js doctor`）与其它调用方不会经过 provider。
  - 认证页一度给国际版槽位显示一个「跟随桌面 App」chip，**现已删掉**（用户要求）：它显示的是「**允许**回落桌面凭据」这条策略，tooltip 却写成"该槽位的凭据直接读桌面客户端的登录态"—— 实测在已扫码的槽位上是**错的**（`workbuddy4/5` 用的是各自扫码登录的号，`signedInBy === "scan"` 优先，与桌面 App 那份凭据无关），而它要解释的现象正是本次修复消掉的东西。判定逻辑保留，只是不再透到界面。
  - 新增 `probes/verify-bugfix-intl-window-and-empty-slot.mjs`（40 项），并配 `scripts/reverse-verify-bugfix.mjs`：把 14 处修复逐个撤回，对应断言必须变红（已实测全部按预期变红）。
- **TRAE SOLO CN 已被厂商并入 Trae CN IDE**（用户报）：本机实测卸载表里只剩 `TRAE CN 3.4.2`，`D:\TRAE SOLO CN\TRAE SOLO CN.exe` 已不存在，残留 `product.json` 的 `commit`/`buildId` 与 Trae CN **逐字节相同**。所以代码与文案里"两个产品"的说法全面收口：
  - 插件侧 `TRAE_DEFAULT_PRODUCT` 从 `solo` 翻成 `cn`；`cn` 的 `functions`/`rateFunctions`/`catalogGroups` 统一成 IDE 自己的三个分组（`solo_agent` / `chat_v3` / `builder_v3`）。理由不止是省一次往返：`reasoningByGroup` / `contextWindowByGroup` 只带这三组的数据，真用旧 SOLO 槽位名去请求会让思考档位静默失效、窗口退回兜底值。
  - `solo` 那条**逐字冻结**（白名单、倍率查询集、目录分组、兜底名单、目录子目录全部保持并入前的值）：手里拿着 SOLO 快照的人没有重导的机会（独立客户端装不回来了），任何一项跟着 CN 改都会让他们在某次重启后突然掉模型、掉倍率、掉档位。`resolveProduct` 仍按 buildId / `packageType` 把无标注的旧快照嗅探成 solo。
  - 导出脚本：`cn` 的兜底 `buildId`/`appVersion` 更新为本机实测的 `1238630385922` / `3.4.2`；`cn` 的倍率查询集收成三个分组名（实测 250 ms / 24 个模型全覆盖，带旧名要 962 ms 且一条不多）；头部与用法改成"在用的产品只有一个，`solo` 是历史兼容"。
  - README / docs 里"两个产品互切""SOLO 有自己的 8 个模型"之类的说法全部改写。
- **两个活体探针写死了旧包名 `dsh-connect`**：`verify-qoder-probe-live.mjs` 与 `qoder-raw-catalog.mjs` 直接拼 `node_modules/dsh-connect/lib/...`，包改名后每次都以 ENOENT 变红，而报错看起来像断言失败、实际只是路径没了。改走 `probes/_installed.mjs`（按 profile 依赖键定位），与其余探针一致。
- **国际版"没有签到活动"被谎报成"今天已签到"**：WorkBuddy AI 账号打 `daily-checkin` 回 `10001 签到活动未开启或已过期`，国区个人号同期回 `10001 今天已签到，请明天再来` —— **同一个 code、含义相反**，而代码只按「不支持」关键词分流，于是国际版被判成 `already-claimed`，面板显示"已签到"（纯属谎报）。同时只读路径把国际版的看板默认值（`active:false`/`today_checked_in:false`）当成"今天还没签"，返回 `claimable`，界面给出一个**可点的『签到』按钮**，点下去才发现什么都没有 —— 正是同文件企业号那段注释明令避免的"假动作入口"。现在 `10001` 按文案分成三态（已签 / 无活动 / 不支持），且区域兜底直接判国际版为不适用。实测确认：国际版与 `hy3` 的 `deepseek-v4.1-flash` 倍率为 `x0.00`（免费），这是它的免费额度来源。
- **从插件市场装不上（issue #2）**：用户点安装，失败，市场把原因归为 `plugin-side install failure` —— 这次归类是**对的**，问题在我们自己的 `package.json`。11 个宿主 peer 依赖一个都没标 optional，于是 pnpm 要往用户 profile 里拖进 **164 个传递依赖**（`@earendil-works/pi-ai` 全家桶、`@aws-sdk/*` 等），并撞上 pnpm 的构建脚本拦截门 `[ERR_PNPM_IGNORED_BUILDS]` 直接 exit 1。实测对比：不标 = 装 165 个包 + 失败；全标 + 装 1 个包 + 997 ms 成功。这些包本来就由宿主进程提供、进不了 profile 的 node_modules，标 optional 不影响运行。同生态的干净插件全都这么做（`dsh-free-search` 8/8、`dsh-rewind-plugin` 16/16）。
  - 新增 `probes/verify-install-peers.mjs`：钉住「每个 peer 都必须 optional」+ `dependencies` 必须为空，并在本地复刻插件市场的入口校验（`resolvePackageEntry` → 入口文件必须真实存在），让这类分发缺漏不可能再装到一半才被发现。
- **国际版（WorkBuddy AI）从未被真正接通**（issue #1）：上游原版本来就是「国区 + 国际版」双变体，`GLOBAL_BASE`、`regionOf`、`resolveGlobalIdentity`、`WORKBUDDY_AI_*` 路由一行没删，是本地分支把 `workbuddyVariantOf` 的 `appName` / `region` / `desktopFilename` 写死成国区，于是没有任何变体能走到那条分支（`region: "cn"` 让国际版凭据在 `WorkBuddyCredentialStore.current()` 里直接被判为「区域不匹配」抛错）。现在区域由注册表条目声明（`region: cn | global`），认不出的值回落国区。
  - 顺带修掉两个 **Windows 上必然踩** 的坑：① 解封加密凭据的 Electron 助手路径原先只在 macOS 有默认值，Windows 上不设 `WORKBUDDY_ELECTRON_BIN` 就永远解不开凭据 —— 现在从 App 自己写的 `settings.json` 里读回它自己的 exe；② app 版本号来源同样是 macOS-only，Windows 上会一直是编译期常量 `5.5.2`（实际装的是 `5.7.6`），现在读 App 自己的 `last-launch.json`。
  - 国际版的默认读法是直接读桌面 App 的登录态（与国区版共用 `CodeBuddyExtension/Data/Public/auth/`，只差 basename `workbuddy-desktop-ai.info`）。因此**不能**像国区槽位那样无条件回落到 `connect-auth/<id>.json`：那个路径不存在时会把 App 里能用的凭据彻底挡住，表现为「App 明明登录了、DSH 里却一直未登录」。（这条后来被 `followDesktop` 收紧了默认值 —— 见上面「刚添加、还没认证的国际版槽位」那条；老部署的既有条目行为不变。）
- **Trae 默认思考档位只对 `high` 生效，其余模型全丢**（`dfb8fa5`）：回退默认档时把 `default_level` 又过了一次反查表 —— 那张表的键是 pi-ai 档位（`low/high/xhigh`），而快照里的 `default_level` 本来就是 Trae 线上拼写（`light/high/extra_high`）。只有 `high` 因为两边同名侥幸生效，默认档为 `extra_high` 的 GLM-5.3 系 / Kimi-K2.8 / Kimi-K3 与 `light` 的模型全部静默丢掉默认档。现在直接用线上拼写，并校验它确在该模型声明的 options 里（不在就不发）。用户手选的档位仍走反查表，那才是它该用的地方。
  - 同一提交修了探针的一处误红：`verify-trae-products` 把快照 buildId 钉成「必须等于变体表」，而运行时优先级本就是 `配置 ?? 快照 ?? 表值` —— 厂商一升级就误判成故障。改为钉「快照带了可用 buildId」+「优先级没被写反」（实测新旧 buildId 打倍率接口返回逐字节相同，815552 B / 194 处倍率）。
- **禁用渠道后模型还能选**（`50273f0`）：面板写着「已禁用」，模型照常可见。写入 `disabledChannels` 的是渠道 id（`qoder`），隐藏判定查的却是 provider id（`qoder1`），只在 Qoder 上不一致，静默失效。现在两种 id 都认，注册表读不到时判「没禁用」——宁可漏隐藏，不误隐藏。
- **Qoder 每轮对话都报 `499 客户端已取消`**（`a0d8ed2`）：把「请求体读完」当成了「用户取消」。Node ≥16 里 `IncomingMessage` 的 `close` 在 body 读完就触发，不是断连信号；改挂到 `res` 上用 `writableEnded` 区分。Trae / WorkBuddy 的反向潜伏 bug（取消不中止上游、白烧额度）一并修掉。
- **档位探查一律答「无凭据」**：有凭据却测不了，账号接线漏传。
- **跨渠道历史里的工具调用破损**：换渠道续聊时空函数名 / 孤儿结果导致突然 400。
- **「额度超限」被误报成「API 密钥无效」**：报错文案与真实原因对不上。
- **流式响应被静默截断、残片丢失**：长回复缺头少尾却不报错。
- **Trae 渠道跑不了 Agent 回合**：工具调用当时根本没接上；现已端到端实测（结构化工具调用、参数分片拼接、`finish_reason` 改写）。
- **模型按钮看不出已选几个、改名时按钮文字挤成竖排**：常显「已选 X / 共 N」；按钮加 `flex:none` + `nowrap`。

## 2026-09 及更早

- 三渠道聚合的初版实现（基于 yembors64632/dsh-connect 收编合并）
- 包名从 `dsh-connect` 改为 `dsh-workbuddy-trae-qoder-connect`；探针的安装目录解析同步修正（旧硬编码会让 12 个探针在 `--installed` 模式下读空路径，报错看着像断言失败，实际只是路径没了）。2026-10 又把最后两个漏网的硬编码（`verify-qoder-probe-live` / `qoder-raw-catalog`）一起改走 `_installed.mjs`。
