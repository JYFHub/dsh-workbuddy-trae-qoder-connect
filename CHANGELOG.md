# 修复记录

修 bug 是欠账还清，不算卖点，所以单独记在这里。每条都能在 git log 里对上。

## 2026-10

- **国际版"没有签到活动"被谎报成"今天已签到"**：WorkBuddy AI 账号打 `daily-checkin` 回 `10001 签到活动未开启或已过期`，国区个人号同期回 `10001 今天已签到，请明天再来` —— **同一个 code、含义相反**，而代码只按「不支持」关键词分流，于是国际版被判成 `already-claimed`，面板显示"已签到"（纯属谎报）。同时只读路径把国际版的看板默认值（`active:false`/`today_checked_in:false`）当成"今天还没签"，返回 `claimable`，界面给出一个**可点的『签到』按钮**，点下去才发现什么都没有 —— 正是同文件企业号那段注释明令避免的"假动作入口"。现在 `10001` 按文案分成三态（已签 / 无活动 / 不支持），且区域兜底直接判国际版为不适用。实测确认：国际版与 `hy3` 的 `deepseek-v4.1-flash` 倍率为 `x0.00`（免费），这是它的免费额度来源。
- **从插件市场装不上（issue #2）**：用户点安装，失败，市场把原因归为 `plugin-side install failure` —— 这次归类是**对的**，问题在我们自己的 `package.json`。11 个宿主 peer 依赖一个都没标 optional，于是 pnpm 要往用户 profile 里拖进 **164 个传递依赖**（`@earendil-works/pi-ai` 全家桶、`@aws-sdk/*` 等），并撞上 pnpm 的构建脚本拦截门 `[ERR_PNPM_IGNORED_BUILDS]` 直接 exit 1。实测对比：不标 = 装 165 个包 + 失败；全标 + 装 1 个包 + 997 ms 成功。这些包本来就由宿主进程提供、进不了 profile 的 node_modules，标 optional 不影响运行。同生态的干净插件全都这么做（`dsh-free-search` 8/8、`dsh-rewind-plugin` 16/16）。
  - 新增 `probes/verify-install-peers.mjs`：钉住「每个 peer 都必须 optional」+ `dependencies` 必须为空，并在本地复刻插件市场的入口校验（`resolvePackageEntry` → 入口文件必须真实存在），让这类分发缺漏不可能再装到一半才被发现。
- **国际版（WorkBuddy AI）从未被真正接通**（issue #1）：上游原版本来就是「国区 + 国际版」双变体，`GLOBAL_BASE`、`regionOf`、`resolveGlobalIdentity`、`WORKBUDDY_AI_*` 路由一行没删，是本地分支把 `workbuddyVariantOf` 的 `appName` / `region` / `desktopFilename` 写死成国区，于是没有任何变体能走到那条分支（`region: "cn"` 让国际版凭据在 `WorkBuddyCredentialStore.current()` 里直接被判为「区域不匹配」抛错）。现在区域由注册表条目声明（`region: cn | global`），认不出的值回落国区。
  - 顺带修掉两个 **Windows 上必然踩** 的坑：① 解封加密凭据的 Electron 助手路径原先只在 macOS 有默认值，Windows 上不设 `WORKBUDDY_ELECTRON_BIN` 就永远解不开凭据 —— 现在从 App 自己写的 `settings.json` 里读回它自己的 exe；② app 版本号来源同样是 macOS-only，Windows 上会一直是编译期常量 `5.5.2`（实际装的是 `5.7.6`），现在读 App 自己的 `last-launch.json`。
  - 国际版的默认读法是直接读桌面 App 的登录态（与国区版共用 `CodeBuddyExtension/Data/Public/auth/`，只差 basename `workbuddy-desktop-ai.info`）。因此**不能**像国区槽位那样无条件回落到 `connect-auth/<id>.json`：那个路径不存在时会把 App 里能用的凭据彻底挡住，表现为「App 明明登录了，DSH 里却一直未登录」。
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
- 包名从 `dsh-connect` 改为 `dsh-workbuddy-trae-qoder-connect`；探针的安装目录解析同步修正（旧硬编码会让 12 个探针在 `--installed` 模式下读空路径，报错看着像断言失败，实际只是路径没了）
