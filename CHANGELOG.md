# Changelog

## 未发布

- 修复 P1/P2：删除路由保留共享凭据；探测只允许保存的路由并拒绝重定向；热更新失败恢复旧适配器；草稿 revision 冲突检查；密钥部分保存提示与剩余项重试；探测总超时和响应释放；verify 构建后运行测试。
- 新增回归覆盖路由恢复、探测边界、超时、响应取消、并发编辑和部分保存。

- 插件详情通过 `locale/zh.json` 和 `locale/en.json` 的 `meta.detail` 加载对应中英文说明，跟随 DSH 显示语言选择。详情文档包含在现有 `docs/**/*.md` 打包范围内，版本为 `v0.1.0`。

### 0.2.2-rc.1 适配与安装 — 2026-11-06

- DSH 四项 peer 更新到 `0.2.2-rc.1`，Cordis `~4.1.0`、Schemastery `~3.19.0`、pi-ai `^1.3.0`，engines.dsh 下限同步。
- 当前 app.asar 刷新 108 个真实依赖包，TypeScript 构建通过，87/87 回归及 18 项兼容检查通过。
- 官方 CLI 重新安装 desktop profile 的本地 link，重启后 Custom Headers 页面读取 2 条路由和 6 个模型通过。
- 更新兼容基线和部署文档。详细范围见 [验证报告](docs/RC1-022-VALIDATION.md)。

### rc.5 适配验证 — 2026-11-01

- 四项 DSH peer 和 engines.dsh 下限更新到 `0.2.1-rc.5`；插件版本仍为 `0.1.0`，未发布。
- 从 rc.5 app.asar 刷新 107 个测试依赖包，构建通过，87/87 回归通过；兼容检查 18 项全部 PASS。
- 修复当前 Desktop 的旧目录 link，重启后启用插件；实机设置页读取、UA 编辑保存及恢复通过。
- 本次未执行真实上游补全或模型目录拉取。详细证据和边界见 [rc.5 报告](docs/RC5-VALIDATION.md)。

### Fixed

- 删除供应商后保存又出现：删除由 bundle 默认层也声明的路由时，页面改为整份写入剩余的
  `providers` 字典（其余路由沿用当前原始值，保留 `reasoning`、`retryPolicy` 等页面不展示的
  字段）。宿主的 `unset` 语义是“恢复继承值”，原先的单条 `unset` 会让 bundle 默认路由在保存后
  重新出现。新增浏览器半回归测试（总计 87 项）。

### Changed

- `displayName` 与路由 ID 统一：供应商卡片标题、只读 Display name 字段和 Host 侧解析都使用
  `providers` 的路由 ID；旧配置里的友好名称在下次保存该路由时归一为路由 ID，默认 patch 和
  示例配置同步。新增浏览器半归一与 Host 解析断言（总计 87 项）。
- 项目结构规范化：删除空的 `tests/`，测试统一放在 `test/`；新增
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 说明目录职责、运行时分层、数据流、不变量与修改
  入口；README 的目录树、开发命令和兼容性探针路径同步更新；`tools/compat-check.mjs` 的客户端
  槽位探针改为 `settings.section`；新增 `test:client` / `test:discovery` 脚本。
- 设置页按官方 Models 设置页重做 UI/UX：720px 内容列、16px/24 标题、14px/22 正文、
  12px/18 分组标题、`--dsw-alias-settings-card-*` 卡片 surface、36px 页面按钮、32px 输入框、
  两列字段；供应商改为卡片列表，底部用虚线「添加供应商」按钮展开表单，新增表单复用
  卡片的两列带标签字段布局，保存/放弃右对齐。新增供应商改由折叠表单触发
  （浏览器半 43 项测试继续通过）。
- 配置页改为**仅保留设置页入口**：页面标题与设置导航改为 `Custom Headers`，页面在标题下显示
  插件描述和原配置页的「N 条路由 · N 个模型 · 请求头」摘要；移除 `plugins.row.config` 注册，
  插件管理页不再提供原始配置页。新增设置页注册、标题/描述与“旧入口不再注册”的测试
  （浏览器半 43 项，总计 87 项）。
- 适配当前 DSH Desktop `0.2.1-rc.3`：`peerDependencies`（dsh-llm / dsh-llm-pi-ai /
  dsh-credentials / dsh-launch-environment）与 `engines.dsh` 从 `0.2.1-rc.2` 基线更新到
  `0.2.1-rc.3`。`npm run compat` 全部 PASS（7 peer、1 engine、10 seam），
  `npm run vendor -- --force` + `npm run verify` 在 rc.3 依赖下 87/87 通过；README 增加
  「兼容性状态（当前 DSH Desktop）」一节。
- 删除 Provider 后会清理无人再用的已存 API Key：配置写入成功后，对被删路由声明的
  `apiKeyEnv`，若本插件剩余路由都没有使用同名引用，且凭据来自文件存储（`source: "file"`），
  调用 `credentials.unset` 删除该值；环境变量提供的关键字不会被改动，清理失败只在页面上提示，
  不回滚已完成的配置删除。新增六条浏览器半测试覆盖清理、共用引用、环境变量、配置写入失败、
  清理失败与仅保存密钥六条路径。

## v0.1.0 — 2026-10-22

首个版本。项目内的版本信息（`package.json`、`package-lock.json`、README、
`docs/` 中的 tag 与安装示例、当前 DSH Desktop 安装）统一为 `v0.1.0`，本版即当前
开发基线。

### 开发内容

- **Host 半**（`src/` → `lib/`）：通过官方 `PiAiAdapter` 的 `profile.piProvider`
  接缝注册 pi-ai 供应商路由（`openai-completions`、`openai-responses`、
  `anthropic-messages`），在适配器合并 attribution 头之后注入部署方配置的
  `User-Agent` 与任意请求头；支持逐 provider 注册、热更新（`loader/volatile-update`）、
  冲突隔离与 fiber 卸载清理。
- **配置与校验**：schemastery 配置 schema、路由/模型解析、大小写不敏感请求头合并、
  非法头与逐跳头拒绝。
- **Host 接缝**：credentials（按 `apiKeyEnv` 引用解析）、attachments / 图片上限、
  harness 日志。
- **模型目录探测**：`registerModelDiscovery('CustomHeaders', …)`，按协议请求
  `/models` 或 `/v1/models`，带该路由自己的请求头与凭据。
- **浏览器半**（`client.js`）：设置页注册到 `settings.section` 槽位（标题 `Custom Headers`），支持
  displayName / api / baseURL 编辑、API Key 写入（只落引用名）、请求头增删改、
  User-Agent 预设与离线记忆、模型目录编辑、新增/删除供应商面板、恢复默认模型、
  获取可用模型。
- **文档与工具**：README、`docs/SINGLE-HOST.md`、`docs/MULTI-DEVICE.md`、
  `docs/COMPATIBILITY.md`、`docs/dsh-update-flowchart.png`、profile patch 示例，
  以及 `tools/compat-check.mjs`、`tools/vendor-runtime-deps.mjs`、
  `tools/online-smoke.mjs`、`tools/asar.mjs`。

### 进展

- `npm run build`：TypeScript strict / NodeNext / ES2023，0 error。
- `npm run verify`：79 / 79 通过（Host 半 33 项、模型探测 11 项、浏览器半 35 项），
  使用真实 `PiAiAdapter`、真实 pi-ai 协议实现与本地抓包服务。
- `npm run compat`：针对当前 Desktop 安装的 `app.asar`，peer/engine 与内部接缝
  检查通过。
- 真实网络冒烟（AgentRouter）：`agentrouter-openai / deepseek-v4-flash` 与
  `agentrouter-anthropic / claude-opus-5-5` 均返回 `finish: stop`。
- 已安装到当前 DSH Desktop profile（`link:` 安装，`include:CustomHeaders` 为
  `enabled: true / fiberPhase: active`），安装与插件管理页报告的版本为 `v0.1.0`。

### 说明

- 插件只影响自己注册的路由；其它 provider（含官方 `llm-pi-ai`）仍发送 harness
  的 attribution `User-Agent`。这是对 harness 默认值的覆盖用法，不是受支持的
  官方配置面。
- 依赖基线：DSH `0.2.1-rc.2`、Cordis `4.0.5`、pi-ai `1.1.0`；升级 DSH 后先跑
  `npm run compat` + `npm run verify`。
- profile 行 id 与设置命名空间为 `CustomHeaders`，设置页绑定该 id；改名时同步
  修改 `client.js` 的 `ROW_ID` 与 `src/index.ts` 的 `SETTINGS_NAMESPACE`。
- 已验证与未覆盖的项见 README「验证结果」一节；`test/` 只覆盖插件自身契约，
  不替代浏览器里的实际点击链路与真实上游检查。
