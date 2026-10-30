# dsh-workbuddy-trae-qoder-connect

![四个渠道的免费额度，一个模型下拉](assets/social-preview.png)

**WorkBuddy（国区版 + 国际版）、Qoder CN、Trae CN、LobsterAI 的免费额度都能在这里用起来。这一个插件把四类渠道接进 DeepSeek Harness：一个模型下拉、一份对话历史，打开面板顺手把能领的积分领掉。国际版另有限时免费模型（`deepseek-v4.1-flash` 当前 `x0.00`），LobsterAI 连登录态都不用粘贴。**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **English** — WorkBuddy (China and international), Qoder CN, Trae CN and LobsterAI all hand out free quota. This one DSH plugin pools all of them into a single model picker with one shared conversation history, and claims the day's check-in for you when the panel opens. Switch channels mid-conversation without losing context, with live credit multipliers, per-model reasoning effort and image input. LobsterAI reads its own login state from the desktop client's local database, so there is nothing to paste. The international edition has no check-in campaign but does carry limited-time free models (`deepseek-v4.1-flash` at `x0.00`).

---

## 它解决什么

四家的额度散在四个客户端里。想都在 DSH 里用起来，就得装四个插件、开四个面板、维护四套凭据——而且每换一个渠道，对话历史就断一次。同类插件都是单渠道的，这个"散"一直没人收。

| | 四个单渠道插件 | **本插件** |
|---|---|---|
| 免费额度 | 四处分别看 | 一个面板看全部 |
| 模型下拉 | 四块，互不相通 | **一个列表**，按渠道分组，旁标积分倍率 |
| 中途换渠道 | 换插件 / 重开会话 | **直接换**，历史不丢 |
| 每日签到 | 点四次 | **打开面板一次全领** |
| 安装包 | 四个 | **一个** |

四家协议完全不同（OpenAI 方言、私有 agent 协议、带自定义编码的流式响应、SQLite 本地库），插件在中间做翻译，对 DSH 和你来说它们长得一样。

---

## 功能一览

用法按功能分组，下面这张表是入口；每节末尾给完整步骤。

| 功能 | 一句话说明 | 在哪用 |
|---|---|---|
| [统一模型下拉](#1-统一模型下拉) | 四类渠道的模型进一个列表，按渠道分组、旁标积分倍率 | 对话输入框的模型选择器 |
| [中途换渠道](#2-对话中途换渠道) | 换模型/渠道时上下文原样带过去 | 同一个模型选择器 |
| [多渠道 / 多账号管理](#3-渠道与多账号管理) | 渠道就地增删改名，不重启；国际版槽位可选是否跟随桌面登录态 | 「渠道中心」面板 |
| [配凭据](#4-配凭据按渠道) | 每个渠道各自的登录方式；凭据只写 0600 本地文件、界面不回显 | 面板 / 脚本 |
| [一键签到](#5-每日签到) | 打开面板自动领当天可领的，重复打开不重复扣 | 「渠道中心」面板 |
| [额度查看](#6-额度查看) | 每渠道余额、套餐拆分、重置时间 | 「渠道中心」面板 |
| [思考档位](#7-思考档位) | 按模型声明选档，可一键实测补全 | 模型档位 / 面板设置 |
| [渠道停用 / 隐藏](#8-渠道停用与隐藏) | 停用＝模型隐藏 + 不参与签到；隐藏＝仅从面板移除 | 面板 → 渠道 |
| [侧栏入口](#9-面板设置与侧栏入口) | 打开/关闭侧栏「渠道中心」入口 | 面板设置 |
| [工具调用 / 读图 / 长上下文](#10-工具调用-读图-长上下文) | Agent 工具调用、按模型开放读图、默认取最大上下文窗口 | 对话 |

---

## 安装

前置：DSH 桌面版、Node ^22.19 或 ≥24。在 DSH 插件页粘贴仓库地址，重启一次 DSH，再配凭据：

```
https://github.com/JYFHub/dsh-workbuddy-trae-qoder-connect
```

> 装完必须重启一次，浏览器端的面板才会挂载（见下文「适配 WorkBuddy / DSH 最新插件协议」）。

---

## 使用说明（按功能）

### 1. 统一模型下拉

四类渠道的模型进**同一个选择器**，按渠道分组，每个模型旁标着积分倍率，哪个贵一眼可见。Trae CN 的目录最全，独占 `glm-5.3-flash`、`kimi-k2.8-preview`、`qwen3.8-flash` 等；WorkBuddy 国际版带来 `gpt-6-astra`、`grok-4.7`、`deepseek-v4.1-flash`（当前 `x0.00`，白用）这些国区没有的。

- 倍率是上游实时给的，**以模型列表里显示的为准**。
- 模型列表由上游目录决定；点「更新模型」按渠道刷新目录，哪些模型变了会直接告诉你。

### 2. 对话中途换渠道

从 Trae 的模型换到 WorkBuddy 的接着聊，上下文原样带过去，不用重开会话、不用换插件。切换只发生在模型/渠道层，历史不变。

### 3. 渠道与多账号管理

渠道在「渠道中心」面板里就地增删改名，勾选即生效、不用重启。每个渠道的类型与账号数：

| 渠道 | 账号数 | 说明 |
|---|---|---|
| WorkBuddy（国区） | **多账号**（槽位不限） | 槽位名 `workbuddy1`、`workbuddy2`…；也支持企业号 |
| WorkBuddy AI 国际版 | 多账号 | 每个槽位可单独选「跟随桌面客户端登录态」或「只认自己的凭据」 |
| Trae CN | 单账号 | 接 Trae CN IDE 一份目录 |
| Qoder CN | 单账号 | 官方 PAT，或直接用桌面 App 的登录态 |
| LobsterAI | 单账号 | 登录态从桌面客户端本地库自动读，面板上不可改 |

- 新建槽位（如 `workbuddy3`）**重启 DSH 后装载**。
- 国际版（`www.workbuddy.ai`）和国区版是**两个独立客户端**，模型阵容差别很大：国际版有 `gpt-6-astra` / `grok-4.7` / `deepseek-v4.1-flash`，国区有 `deepseek-v3-2-volc` 等。装了哪个就自动读哪个；两个都装就两个渠道并排。
- 「跟随桌面客户端登录态」适合只有一份账号；多账号时默认「只认自己的凭据」，扫码登录互不干扰。国际版凭据是加密存的，插件用客户端自己的 Electron 解封，**不碰钥匙串、不落明文**。

### 4. 配凭据（按渠道）

凭据只写进 **0600 权限的本地文件**（`$DSH_HOME/connect-auth/`），界面从不回显，仓库里没有任何账号数据。

最省事的做法：把下面这段复制给你的 AI 助手，剩下的它全包——生成 WorkBuddy 授权链接发到对话里、你浏览器点开授权、它轮询到成功落盘、导出 Trae 凭据、接上 Qoder 登录态，最后汇报各渠道状态与模型数：

```text
跑 scripts/ 下的脚本配好 dsh-workbuddy-trae-qoder-connect 各渠道的凭据，
WorkBuddy 登录要轮询到成功为止。完成后汇报各渠道状态与模型数，提醒我重启 DSH。
```

想自己跑也行，按渠道：

**WorkBuddy（国区 / 国际版）** — 脚本生成授权链接，浏览器扫码/点开登录，持续轮询到授权成功：

```bash
node scripts/workbuddy-login.mjs workbuddy1              # 持续轮询到授权成功
node scripts/workbuddy-login.mjs workbuddy1 --url-only  # 只输出链接给 AI 转发（不轮询）
node scripts/workbuddy-login.mjs workbuddy1 --port 56825  # 指定 DSH 端口（默认 19387）
```

凭据写 `$DSH_HOME/connect-auth/workbuddy1.json`；环境变量 `WORKBUDDY<N>_AUTH_FILE` 可指向别处。前提：DSH 在运行、该槽位已装载（新槽位先重启一次）。

**Trae CN** — 凭据在客户端加密存储里，导出一次、本地读，重跑脚本即刷新：

```bash
node scripts/export-trae-plain.mjs --app cn     # Trae CN IDE（默认，也是唯一在用的）
node scripts/export-trae-plain.mjs --list       # 看本机数据目录的登录态
node scripts/export-trae-plain.mjs --check      # 体检当前要导的那份，不写文件
node scripts/export-trae-plain.mjs --out DIR    # 自定义输出目录（此时不再镜像到 connect-auth）
```

凭据镜像到 `$DSH_HOME/connect-auth/trae.json`。并入前导出的旧 SOLO 快照（`$DSH_HOME/trae/`）仍然照常可用、不用重导；`--app solo` 只为还没迁移的机器保留。

**Qoder CN** — 二选一：官方 PAT，或桌面 App 登录态（`qoder-session.json`，优先）：

- PAT：把 `pt-…` 存到 `$DSH_HOME/connect-auth/qoder.pat`。
- App 会话：`$DSH_HOME/connect-auth/qoder-session.json`。

**LobsterAI** — **无需任何操作**。插件自动读取桌面客户端本地数据库（`%APPDATA%/LobsterAI/lobsterai.sqlite`）里的登录态与积分，只要在桌面客户端登录过即可。面板上这一行是只读的、没有粘贴框。

### 5. 每日签到

打开「渠道中心」面板时，**自动领当天能领的积分**；重复打开也只领一次、不重复扣分。可在设置里关掉自动签到，改成手动点。

- 签到状态分几种，界面区分显示：「可领取 / 已领 / 已完成 / 需手动 / 不适用 / 未响应」。
- **WorkBuddy AI 国际版没有签到活动**，会显示「不适用」，它的免费额度体现在**限时免费模型**上（`deepseek-v4.1-flash` 当前 `x0.00`）。
- LobsterAI 每日签到领 100 积分。
- 企业号没有签到入口。

### 6. 额度查看

每个渠道剩多少积分、按套餐怎么拆、什么时候重置，面板直接显示：WorkBuddy 显示池化总额 / 各槽位拆分，Trae 显示剩余 / 总额，Qoder 显示「不限量 / 按组织计量 / 剩余」，LobsterAI 显示真实余额（取上游 `totalCreditsRemaining`）外加「今日可领」提示。

### 7. 思考档位

每个模型能选哪些档，**来自上游目录的声明**，不硬造——实测「关思考」在两家上游直接返回 400，就不提供这个选项；而 LobsterAI 的 `off` 是真实档位。

- 没手动选档时，新会话自动用该模型声明的默认档。
- 点「更新模型」，档位连同目录一起刷新。
- 少数老模型上游不声明档位，设置里留了**一键实测**补上（消耗少量额度，结果缓存）。
- 一个值得知道的坑：Qoder 的 `dfmodel` 标着"非专用思考模型"，却声明了 3 个档位。**能不能调档看 `thinking_config` 的声明，别看那个布尔。**

### 8. 渠道停用与隐藏

- **停用渠道**：模型从下拉里隐藏、不参与签到，凭据保留，随时能开回来。
- **隐藏渠道**：只把它从面板列表里移除（不隐藏模型）。
- **模型级勾选**：单个模型可取消勾选，改完即生效、不用重启。

### 9. 面板设置与侧栏入口

「渠道中心」面板提供：自动签到开关、侧栏入口开关、停用/隐藏渠道、模型勾选（「已选 X / 共 N」）、档位实测入口。「更新模型」按钮按渠道独立刷新。

设置页写入 `settings` 的 `dsh-connect` 命名空间，包括 `autoCheckin`（默认 `true`）、`showDockButton`（默认 `true`）、`hiddenChannels`、`disabledChannels`、`disabledModels`、`useMaximumContextWindow`（默认 `true`，上游对同一模型声明多档窗口时取最大那档，关掉则退回默认档）。

### 10. 工具调用 / 读图 / 长上下文

- Agent 工具调用（读文件、跑命令、改代码，Trae 渠道端到端实测过）。
- 读图按模型开放。
- 主力模型普遍 1M 上下文。
- 上游对同一模型声明多档窗口时，插件默认取最大那档，可在面板里关掉。

---

## 背后怎么做的

不关心可以整段跳过，这里只讲三件值得知道的：

**协议翻译。** 每个渠道在本地起一个中转，把各自的私有协议翻成 OpenAI 方言喂给 DSH。Trae 只有 IDE 一个产品了，产品变体表留着一条历史条目，只服务并入前导出的旧快照。

**档位的真值来源。** 上游声明 ∪ 实测。实测用哨兵拒绝法：先证明请求本身能通，再拿一个随机值探"上游到底校不校验这个字段"，确证它会拒绝才逐档扫描——所以不会把"传什么都收"误判成"所有档位都支持"。

**Trae 走本地快照。** Trae 的凭据在客户端加密存储里，目录接口又挑请求头（少给一个就静默返回空壳），所以导出一次、本地读，重跑脚本即刷新。

## 暂不支持

- 插件代码改动需重启 DSH；凭据与产品切换是热生效
- **WorkBuddy AI 国际版没有签到活动**，面板会显示「不适用」（它的免费额度体现在限时免费模型上，如 `deepseek-v4.1-flash` 当前 `x0.00`）
- 少数模型上游只声明一档窗口（如 `kimi-k2.6`），以模型列表里显示的为准
- LobsterAI 的凭据不能在面板里改，只能读桌面客户端的登录态

## 适配 WorkBuddy / DSH 最新插件协议

插件按 DSH NEXT（DeepSeek Harness ≥ 0.2.0）的插件协议实现。若你从旧宿主升级后插件"装上了但面板/侧栏入口出不来"，基本是下面这几条没跟上：

- **客户端立即加载**：`package.json` 的 `dsh.client` 为 `platform: "web"` + `immediately: true`。`immediately` 缺失时浏览器端模块不会在宿主启动时就注册，面板与侧栏「渠道中心」入口都不会挂载——这是升级到 NEXT 后最常见的"无法使用"根因。
- **显示元数据**：Plugin Manager 与设置页从 `locale/en.json`、`locale/zh.json` 的 `meta.title` / `meta.description` 读标题与说明，从 `icon.svg` 读图标（均通过 `exports` 的 `./locale/*.json` 与 `./icon` 暴露，并在 `files` 里随包发布）。缺这些会在插件清单里出现诊断回退，甚至被标记异常。
- **`dsh.client.inject` 只排激活顺序**：现在只列仍存在于宿主的 UI 包——`dsh-client-ui-conversation` / `dsh-client-ui-settings-plugins` / `dsh-client-locale`。旧协议里列过的 `dsh-api-remotes` / `dsh-api-session-controller` / `dsh-client-ui-renderer` / `dsh-client-ui-model-selection` 在新宿主已不存在，留在列表会让客户端加载失败。插件自身**不 `require` 任何宿主 Client 包**——UI 控件自建、主题用宿主 `--dsw-alias-*` 令牌，符合最新协议"不得把宿主 Client 包当模块引入"的硬性要求（引入即无类型检查，抛错会整块白屏）。
- **peer 范围放宽**：`@deepseek-ai/*` 与 `pi-ai` 的 peer 用 `>=` 下限写法（如 `>=0.1.5-rc.1`），显式覆盖预发布分支并兼容 0.2.0+ 宿主；它们全部标 `optional`，由宿主进程提供、不进 profile 的 node_modules。
- **客户端模块契约**：`lib/client.js` 用 `window.__ModuleLoader__.load({ id: 包名, factory })` 注册，工厂返回 `{ inject, apply }`，通过 `ctx.slots.inject` / `ctx.slots.register` 挂到 `conversation.composer.dock`、`settings.plugin.item`、`plugins.bundle.config` 等槽位——这是现行客户端模块系统的标准写法。
- **Host 半侧**：provider / 路由靠 `cordis.patch.yml` 的 `- insert` 注册，row `id`（`dsh-connect`）与 `lib/index.js` 导出的 `name` 逐字一致；该半侧在 NEXT 宿主下日志证实仍正常加载。

部署到 DSH NEXT：提交改动后，在插件页重装（或用 `plugin_manager` 以本地目录 `install_bundle`），**重启 DSH** 让新的 JavaScript 模块重新生成。只是改凭据/产品切换是热生效，改插件代码必须重启。

## 开发与验证

- **27 个确定性验证脚本、418 项断言**，不依赖网络、离线可跑，当前全绿；另有 3 个活体脚本做真实上游单点实测。清单与探针纪律见 [probes/README.md](probes/README.md)
- 每处修复都做过**反向验证**：把修复撤掉，对应断言必须变红（`node scripts/reverse-verify-bugfix.mjs`，当前 23 项全部按预期变红）
- 改完代码用 `node scripts/sync-to-profile.mjs` 同步到 profile 里跑着的那份（`--check` 只报差异）。仓库侧的 `lib/**` 与安装副本之间是硬链接，而编辑器"写新文件再改名"会把链接断开——不同步就会出现「改了但重启后没生效」
- 这三个脚本是**维护者工具**，不随安装包分发（`package.json` 的 `files` 里显式排除）：`probes/`、`docs/`、`assets/` 同理，用户装到的有 `lib/` + `cordis.patch.yml` + `locale/`（en/zh 显示元数据）+ `icon.svg` + 三个面向用户的 CLI（导出 Trae 登录态 / 解 Trae 凭据 / WorkBuddy 扫码登录）
- 历次 bug 修复记在 [CHANGELOG.md](CHANGELOG.md)，不当卖点用
- 设计细节：[docs/CATALOG.md](docs/CATALOG.md) · [docs/TRAE-CN-PRODUCTS.md](docs/TRAE-CN-PRODUCTS.md) · [docs/TRAE-REASONING-EFFORT.md](docs/TRAE-REASONING-EFFORT.md)


## 来源与许可

基于 [chengshenyangtai/dsh-workbuddy-trae-qoder-connect](https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect.git)（MIT），致谢见 [NOTICE](NOTICE)。本插件 MIT 许可。

基于 [yembors64632/dsh-connect](https://github.com/yembors64632/dsh-connect)（MIT），致谢见 [NOTICE](NOTICE)。本插件 MIT 许可。
