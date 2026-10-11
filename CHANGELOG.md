# 修复记录

修 bug 是欠账还清，不算卖点，所以单独记在这里。每条都能在 git log 里对上。

## 2026-10

- **国际版模型的 1M 上下文在 DSH 里被砍成 300K**（用户报）：上游对同一个模型同时声明多档窗口（实测 `deepseek-v4.1-flash` 是 `contextWindow 300000` + `supportedContextWindows [300000, 1000000]`），而适配器只广告一档。三个独立缺陷叠在一起，缺一个都不会表现出来：
  1. 偏好读的是 `config.useMaximumContextWindow`，而 `lib/index.js` 用 `apply(ctx, {})` 调子模块、第二个参数恒为空对象 —— 读到的**永远**是 false。偏好现在挂在面板/插件自己的 `Config`（`HUB_SECTION`，宿主唯一会投影的那份）上，由 `lib/index.js` 通过 `workbuddy.setPreferences(hubPreferences)` 把读写通道注入子模块；`catalog` 改成**惰性读源**（每次 `current()` 现读），所以面板里改完立刻生效，不用重启。
  2. 状态路由只在 `legacySettingsAvailable` 时才下发 `useMaximumContextWindow`，而那个条件要求宿主有 `settings.installSection` —— 本机 DSH 没有，于是字段从不出现、复选框根本不渲染。现在按 `region === "global"` 下发（写通道不可用时仍返回 `undefined`，界面就不显示一个存不下去的开关）。
  3. 前端又把复选框钉在 `variant.id === AI_CARD_VARIANT.id`（= `workbuddy2`），所以 `workbuddy4/5` 这些国际版槽位即使拿到字段也永远看不到。现在只看后端给不给这个字段。
- **刚添加、还没认证的国际版槽位会把模型漏进模型选择器**（用户报）：新建槽位的用途是多账号，而国际版槽位的默认读法是"直接读桌面 App 的登录态"，于是空槽位立刻借到 App 里那份凭据、看起来已登录（实测借到的还是**另一个槽位**的账号），`adoptIdentity` 据此把 catalog 置为可见，一整套不属于它的模型进入选择器。修复分四处：
  - 注册表新增 `followDesktop`，**缺失按 true**（旧条目逐字保持原行为，升级不会突然"未登录"）；面板新增的国际版槽位显式写 `false`，表单里也能勾选"跟随桌面 App"。
  - provider 侧 `configuredAuthFile` 与 store 侧 `resolveDesktopCandidates` **两侧**都按它分流：不跟随的槽位只认 `connect-auth/<id>.json`（通常不存在 ⇒ 干净地未登录），绝不落到平台默认探测。两侧都改是因为 CLI（`bin.js doctor`）与其它调用方不会经过 provider。
  - 认证页给国际版槽位显示凭据来源（「跟随桌面 App」/「独立凭据」），让"为什么空槽位显示已登录"一眼可辨。
  - 新增 `probes/verify-bugfix-intl-window-and-empty-slot.mjs`（32 项），并配 `scripts/reverse-verify-bugfix.mjs`：把 10 处修复逐个撤回，对应断言必须变红（已实测全部按预期变红）。
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
