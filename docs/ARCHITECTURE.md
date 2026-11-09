# 项目架构

`dsh-plugin-custom-headers` 是一个 Cordis / DSH 双半插件：Host 半注册 pi-ai 供应商路由并改写发往上游的请求头，浏览器半在设置页提供一个配置界面。

本文描述**当前**目录职责、运行时分层、数据流与修改入口。升级策略、兼容基线和多设备分发分别见
[COMPATIBILITY.md](COMPATIBILITY.md)、[SINGLE-HOST.md](SINGLE-HOST.md)、[MULTI-DEVICE.md](MULTI-DEVICE.md)。

---

## 1. 目录职责

```text
dsh-plugin-custom-headers/
├─ cordis.patch.yml       # bundle 默认 patch：插入 CustomHeaders 行 + 两条默认路由
├─ package.json           # 包元数据、dsh.bundle/dsh.client、exports、peer/engines、scripts
├─ tsconfig.json          # Host 半 TypeScript 构建配置（ES2023 / NodeNext / strict）
├─ client.js              # 浏览器半（单文件，由 DSH client 扫描直接加载，无打包步骤）
├─ icon.svg               # 插件清单图标
├─ locale/{en,zh}.json    # 插件清单标题/描述（设置页标题与描述另有 client 字典）
├─ src/                   # Host 半源码
│  ├─ index.ts            # Cordis 入口：apply/inject/Config，逐路由注册、热更新、清理
│  ├─ config.ts           # Config schema + 路由解析/校验
│  ├─ adapter.ts          # 构造官方 PiAiAdapter（一个 provider 一个实例）
│  ├─ models.ts           # pi-ai model 描述、思考等级、header 注入 provider
│  ├─ headers.ts          # 大小写不敏感请求头合并与合法性校验
│  ├─ discovery.ts        # 模型目录探测（按协议请求 listing）
│  ├─ host.ts             # credentials / attachments / logger 接缝
│  ├─ compat.ts           # 唯一的 DSH / pi-ai 导入边界与运行时形状检查
│  └─ shims.d.ts          # 外部模块的宽松类型声明
├─ lib/                   # tsc 构建产物（安装后实际加载这里；不要手改）
├─ test/                  # 自动化测试（node:test，单进程运行）
├─ tools/                 # 开发/验证工具（不进插件运行时）
├─ docs/                  # 架构、兼容、分发与单机操作文档
└─ examples/              # profile patch 示例
```

没有 `tests/` 目录；测试统一放在 `test/`。`lib/` 是生成物，源码只改 `src/`。

---

## 2. 运行时分层

### 2.1 Bundle patch

[cordis.patch.yml](../cordis.patch.yml) 通过一条 `insert` 把插件行插入 profile：

- 行 id：`CustomHeaders`
- 包名：`dsh-plugin-custom-headers`
- 默认 `providers`：`agentrouter-openai`、`agentrouter-anthropic`

这只是 bundle 默认值。实际部署通常在 profile 的 `cordis.patch.yml` 用同 id 覆盖 `config`，
或通过设置页写回 profile patch。

### 2.2 Host 半（`src/` → `lib/`）

`src/index.ts#apply`：

1. `checkCompat()` 检查 DSH / pi-ai 关键符号；
2. `readProviders()` / `resolveRoutes()` 解析配置；
3. 为每条路由创建 `createRouteAdapter()`（官方 `PiAiAdapter`）并注册到 `ctx.llm`；
4. 监听 `loader/volatile-update`，按内容指纹增量重建；
5. fiber 卸载时注销本插件注册的每个 provider。

请求路径的关键点：

```text
PiAiAdapter（官方）
  → requestHeaders(): 过滤与 attribution 冲突的配置头，写回 harness UA
  → profile.piProvider（本插件构造的 pi-ai provider）
  → stream/streamSimple: mergeHeadersCaseInsensitive(options.headers, 配置 headers)
  → pi-ai 协议实现（openai-completions / openai-responses / anthropic-messages）
  → SDK / undici：线上只有一份 user-agent
```

本插件**不继承、不修改** `PiAiAdapter`；它利用官方 `profile.piProvider` 接缝，只影响自己注册的路由。

### 2.3 浏览器半（`client.js`）

单文件浏览器 bundle，`window.__ModuleLoader__.load` 注册，`require('react')` 之外只通过 Host 服务工作：

- `slots`：注册 `settings.section`，id `custom-headers`，order 30；
- `configForms`：读写 namespace `CustomHeaders` 的表单快照与 mutation；
- `remote.credentials`：`describe` / `set` / `unset`；
- `remote.llm.discoverModels`：请求 Host 探测模型目录。

页面入口是 **设置 → Custom Headers**。`plugins.row.config` 不再注册（旧插件配置页已移除）。

---

## 3. 数据流

### 3.1 读取

```text
settings.section mount
  → configForms.get('CustomHeaders')
  → getSnapshot(): { value, base, user, writable, revision }
  → toDraft(): 只保留页面编辑字段
```

### 3.2 保存

```text
用户编辑 → draft
  → mutationsOf(draft, configured, { inheritedProviders, rawProviders })
  → 先 credentials.set(typed keys)
  → configForms.mutate(operations)
  → configEditor → profile cordis.patch.yml
  → loader/volatile-update
  → Host apply() 重新注册受影响路由
```

特殊规则：

- **删除继承层路由**：`unset providers.<id>` 会被 Host 解释为“恢复继承值”，所以页面改为整份
  `set providers`，写入剩余路由的完整字典；
- **删除路由保留密钥**：credentials 引用可能被其他插件使用，不再自动删除共享存储中的密钥。
- **并发编辑**：记录草稿起始 revision，写密钥前和配置提交前检查最新快照；冲突时保留草稿，提示重新编辑。当前 Host 接口无条件写入版本参数，因此仍不能提供跨进程原子事务。
- **部分成功**：已保存的密钥立即从待写队列移除，失败信息列出已完成引用，重试仅处理剩余项。
- 字段级编辑只写页面拥有的字段，`reasoning`、`retryPolicy`、图片上限等保持原值。

### 3.3 模型探测

```text
浏览器 remote.llm.discoverModels('CustomHeaders', { provider })
  → Host registerModelDiscovery 处理器
  → 从活配置读 baseURL / api / headers
  → credentials.resolve(apiKeyEnv)
  → OpenAI: {baseURL}/models；Anthropic: {root}/v1/models?limit=1000
  → 只返回候选，用户勾选后再写入配置
```

---

## 4. 关键不变量

1. **只覆盖本插件路由**：其它 provider（含官方 `llm-pi-ai`）继续发送 harness attribution UA。
2. **密钥只经引用**：配置里只有 `apiKeyEnv`，值只存在 credentials store。
3. **一个 provider 一个官方适配器实例**：不跨路由共享 adapter，不修改核心。
4. **`providers` 是 volatile 字段**：保存通过 `configForms.mutate`，触发增量重注册。
5. **浏览器半无构建步骤**：`client.js` 直接由 DSH 扫描；不要引入需要打包的 import。
6. **行 id 是契约**：`ROW_ID = 'CustomHeaders'` 必须与 `src/index.ts#SETTINGS_NAMESPACE`、
   profile patch 和 `cordis.patch.yml` 一致。
7. **displayName 是派生值**：Host 解析和设置页都使用路由 ID；旧 profile 的友好名称被忽略，
   保存该路由时归一为路由 ID。卡片标题和只读 Display name 字段都显示路由 ID。
8. **版本基线**：插件 `0.1.0`；当前验证 DSH Desktop `0.2.2-rc.1`。

---

## 5. 测试与工具

### 5.1 测试分布（94 项）

| 范围 | 文件 | 数量 |
|---|---|---:|
| Host 半：真实适配器抓包、注册/热更/清理、配置校验 | `test/adapter-wire.test.mjs`、`test/plugin-registration.test.mjs`、`test/headers-config.test.mjs` | 34 |
| 模型探测 | `test/discovery.test.mjs` | 14 |
| 浏览器半：槽位、编辑→保存、密钥、删除、设置页 | `test/client-bundle.test.mjs` | 46 |

`test/mock-server.mjs` 是记录请求头并回放 SSE 的本地服务，不是测试用例。

### 5.2 命令

```powershell
npm run build        # tsc → lib/
npm run check        # tsc --noEmit
npm test             # 全部 94 项
npm run test:wire    # 真实 PiAiAdapter 抓包
npm run test:client  # 浏览器半
npm run test:discovery
npm run compat       # 只读 app.asar 的版本/接缝体检
npm run vendor -- --force   # 从 app.asar 补真实依赖到 node_modules
npm run verify       # check + 全部测试
npm run online       # 真实网络冒烟（可选，需要凭据/网络）
```

`npm run vendor` 会跳过 `@types/*`：开发类型由 `npm install` 提供，运行时载荷里的
`@types/node` 是元数据占位包。

---

## 6. 修改入口

| 要改什么 | 改哪里 |
|---|---|
| 新增/调整路由字段或校验 | `src/config.ts`、`src/models.ts`，以及 `client.js` 的 `toDraft` / `routeEntryOf` / `ValidateDraft` |
| 请求头合并或保留字 | `src/headers.ts` |
| 模型探测协议 | `src/discovery.ts` |
| Host 服务接缝 | `src/host.ts`、`src/compat.ts` |
| provider 注册/热更 | `src/index.ts`、`src/adapter.ts` |
| 设置页布局/交互 | `client.js`（`SettingsSection`、`RoutePage`、`CSS`） |
| 默认路由/模型 | `cordis.patch.yml`、`examples/profile.patch.example.yml` |
| 升级 DSH | `npm run compat` → `npm run vendor -- --force` → `npm run verify`，再更新 `peerDependencies` / `engines.dsh` / [COMPATIBILITY.md](COMPATIBILITY.md) |

---

## 7. 相关文档

- [README](../README.md) — 功能、安装、配置与验证结果
- [COMPATIBILITY.md](COMPATIBILITY.md) — DSH 升级兼容与迁移 Runbook
- [SINGLE-HOST.md](SINGLE-HOST.md) — 单台 Windows 主机的更新/回滚
- [MULTI-DEVICE.md](MULTI-DEVICE.md) — 多设备分发与按设备配置
- [CHANGELOG.md](../CHANGELOG.md) — 版本与未发布变更
## 可靠性边界

- 路由更新先构造新适配器，注册失败尝试恢复旧实例；恢复失败记录独立错误，下次更新可重试。
- 模型探测只接受保存的 provider，拒绝 endpoint / api / apiKey 覆盖和 HTTP 重定向。
- 探测默认总超时 30 秒，覆盖响应体读取；错误状态和超限响应主动取消。
- `verify` 按 check → build → test 执行，测试使用本次构建产物。
