# 单台 Windows 主机操作指南

适用场景：**只有一台 Windows 机器**，DSH、插件源码和 profile 都在本机。
不需要私有 npm registry、第二台测试设备或分批发布；核心是**本地 Git tag + 一条 fallback 路由**。

通用迁移策略见 [COMPATIBILITY.md](COMPATIBILITY.md)；多设备分发见 [MULTI-DEVICE.md](MULTI-DEVICE.md)。

---

## 0. 单机版的核心原则

1. **本地 `link:` 安装 + 本地 Git tag**：不需要远程仓库；tag 就是回滚点。
2. **永远保留一条可用的 fallback 路由**：插件坏了，DSH 仍然能聊天、改配置。
3. **先保 DSH 可用，再修插件**：不要在唯一的机器上把默认模型指向一个坏路由。
4. **一次只动一个变量**：不要同时更新 DSH 和插件。
5. `npm run vendor` 只补测试依赖；改完源码要 `npm run build` 并重载插件，才会影响线上插件。

---

## 1. 确认当前安装形态

最新安装验收见 [0.2.2-rc.1 报告](RC1-022-VALIDATION.md)，旧链接修复历史见 [rc.5 报告](RC5-VALIDATION.md)。下表为部署示例，实际路由以设置页为准：

| 项 | 路径 / 值 |
|---|---|
| 插件仓库 | `C:\path\to\dsh-plugin-custom-headers` |
| DSH 安装 | `C:\Tools\DeepSeek Harness` |
| `app.asar` | `C:\Tools\DeepSeek Harness\resources\app.asar` |
| profile | `%USERPROFILE%\.dsh\profiles\desktop` |
| 插件安装 | profile `package.json` 里的 `link:` 依赖 |
| 插件版本 | `v0.1.0`（`package.json` 是唯一来源，安装目录为 junction） |
| 插件路由 | `agentrouter-openai` / `agentrouter-anthropic` |
| fallback 路由 | `aliyunbailian-openai` / `deepseek-v4.1-flash-1017`（官方 `llm-pi-ai`） |

快速确认：

```powershell
cd 'C:\path\to\dsh-plugin-custom-headers'
git status
git tag --list

Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
```

---

## 2. 更新 DSH 前（约 5 分钟）

### 2.1 确保仓库干净

```powershell
cd 'C:\path\to\dsh-plugin-custom-headers'
git status          # 必须没有未提交修改
git tag --list      # 记下当前 tag，例如 v0.1.0
```

### 2.2 备份 profile 配置

```powershell
$backup = Join-Path $env:USERPROFILE ("dsh-backup-" + (Get-Date -Format yyyyMMdd-HHmm))
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" $backup
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" $backup
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\pnpm-lock.yaml" $backup
```

**不要**把 `~/.dsh/.credentials.yaml` 复制到普通目录。Key 继续留在原 credentials 服务里。

### 2.3 确认 fallback 可用

当前 profile 的官方 fallback 是：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: aliyunbailian-openai
    model: deepseek-v4.1-flash-1017
    reasoningEffort: high
```

更新前在 Models 页确认该模型可用。它是单机的“保命通道”。

如果 DSH 有旧版安装器，保留一份；没有的话，至少保证上面的 fallback 可用。
不必复制整个 1 GB 安装目录，除非你愿意用 Windows 还原点做额外保险。

---

## 3. 更新 DSH 后：先把 DSH 保住

如果当前默认模型的 provider（`agentrouter-openai`）报错，先临时切到 fallback：

编辑：

```
%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
```

把 `agent-default-model` 改成：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: aliyunbailian-openai
    model: deepseek-v4.1-flash-1017
    reasoningEffort: high
```

重启 DSH 或等 profile 重新加载。这样插件即使完全不兼容，DSH 仍然可用。

> 也可以在 Models 页临时选择 fallback 模型；修好插件后再切回
> `agentrouter-openai` / `deepseek-v4-flash`。

---

## 4. 三步验证插件

```powershell
cd 'C:\path\to\dsh-plugin-custom-headers'
$env:DSH_ASAR = 'C:\Tools\DeepSeek Harness\resources\app.asar'

npm run compat
npm run vendor -- --force
npm run verify
```

| 命令 | 作用 |
|---|---|
| `npm run compat` | 只读新版 `app.asar`：peer/engine 版本 + `piProvider`、headers 合并顺序、注册接口、客户端槽位 |
| `npm run vendor -- --force` | 从新版 `app.asar` 抽取真实依赖到开发目录；**不安装插件** |
| `npm run verify` | 类型检查 + 87 项测试，包括真实 `PiAiAdapter` 抓包断言 |

如果 `compat` 或 `verify` 失败，**不要切回插件路由**。保持 fallback，按
[COMPATIBILITY.md](COMPATIBILITY.md) 的“症状 → 第一处修改”定位。

---

## 5. 修复并发布本地版本

### 5.1 按失败点修

| 失败点 | 第一处修改 |
|---|---|
| 导入失败 / 导出名变化 | `src/compat.ts` |
| `UNKNOWN_MODEL` / `NO_ADAPTER` | `src/adapter.ts`、`src/models.ts` |
| UA 变回 `deepseek-harness/...` | `src/models.ts` |
| schema 报错 | `src/config.ts` |
| 凭据 / 图片 / replay | `src/host.ts` |
| 模型探测 | `src/discovery.ts` |
| 设置页消失 / 保存失败 | `client.js` |

改完：

```powershell
npm run build
npm run verify
```

### 5.2 更新元数据并打 tag

```powershell
# 修改 package.json 的 peerDependencies / engines.dsh / version
# 修改 CHANGELOG.md
# 当前基线是 v0.1.0，本地修复版按 v0.1.1 递增

npm run verify
npm run pack:check

git add .
git commit -m "feat: support DSH <new-version>"
git tag v0.1.1
```

单机不需要推送远程；本地 tag 就是回滚点。若想多一份异地备份，再推私有仓库或保存
`npm pack` 生成的 `.tgz`。

### 5.3 重载插件

- 本地 `link:` 安装：重启 DSH（或让 plugin manager 重新加载该行），它会读取新的 `lib/`；
- 如果改了 peer/engines 且需要重装：在 plugin manager 里移除
  `dsh-plugin-custom-headers`，再安装本地目录。

### 5.4 切回插件路由

把 `agent-default-model` 改回：

```yaml
provider: agentrouter-openai
model: deepseek-v4-flash
```

然后做一次真实请求，确认：

1. 设置页能打开、保存；
2. 实际 `User-Agent` 是配置值；
3. 日志没有 `UNKNOWN_MODEL` / `NO_ADAPTER` / `MISSING_CREDENTIAL`。

---

## 6. 回滚

### 6.1 回滚插件

```powershell
git checkout v0.1.0
npm run build
```

然后重启 DSH / 重新加载插件。如果 `node_modules` 里的测试依赖已经指向新版，
再针对当前 DSH 跑一次：

```powershell
$env:DSH_ASAR = 'C:\Tools\DeepSeek Harness\resources\app.asar'
npm run vendor -- --force
```

### 6.2 回滚 DSH 本身

使用旧安装器或 Windows 还原点。回退 DSH 后：

- 重新设置 `DSH_ASAR`；
- 重新 `npm run vendor -- --force`；
- 重启 DSH。

插件回滚和 DSH 回滚分开做，不要同时进行。

---

## 7. 单机版流程图

```text
更新前备份 + 记录本地 tag + 确认 fallback
                ↓
            更新 DSH
                ↓
     路由坏了？──是──> 默认模型切 fallback
                │否             │
                ↓               ↓
        npm run compat <────────┘
                ↓
        npm run vendor -- --force
                ↓
        npm run verify
          │失败                 │通过
          ↓                     ↓
   按症状修 → build → verify   更新 peers/version → tag
          │                     ↓
          └──────────────> 重载插件 → 切回插件路由
                                ↓
                          真机请求确认 UA
```

---

## 8. 单机不要做的事

- 不要同时更新 DSH 和插件；先 DSH，后插件。
- 不要在唯一主机上删除旧 tag 或旧 DSH 安装器。
- 不要在默认模型指向插件路由时直接重启，除非已经确认 `compat + verify` 通过。
- 不要把 `npm run vendor` 当成“安装插件”；它只服务测试目录。
- 不要在 `git status` 不干净时更新 DSH。

---

## 9. 相关文件

- 通用升级策略与定位表：[COMPATIBILITY.md](COMPATIBILITY.md)
- 多设备分发：[MULTI-DEVICE.md](MULTI-DEVICE.md)
- 流程图：[dsh-update-flowchart.png](dsh-update-flowchart.png)
- 兼容体检工具：[../tools/compat-check.mjs](../tools/compat-check.mjs)
