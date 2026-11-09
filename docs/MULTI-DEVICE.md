# 在多台设备的 DSH 中使用这个插件

这份文档解决两件事：

1. 怎样把**插件本体**分发到多台设备；
2. 每台设备上还有哪些**配置与凭据**必须单独处理。

先记住一个边界：插件包只包含代码、默认 patch、locale、图标和文档。它**不包含**
你在设置页里填的 API Key，也不包含当前 profile 的 `cordis.patch.yml` 覆盖。
这些必须按设备分别配置。

---

## 1. 先选分发方式

| 场景 | 推荐方式 | 安装 spec 示例 |
|---|---|---|
| 1–3 台个人设备，已有私有 Git 仓库 | **私有 Git 仓库 + tag**（首选） | `git+ssh://git@github.com/<you>/dsh-plugin-custom-headers.git#v0.1.0` |
| 团队/设备较多，需要版本与回滚 | **私有 npm registry** | `dsh-plugin-custom-headers@0.1.0` |
| 设备离线、内网文件服务器 | **tarball** | `D:\packages\dsh-plugin-custom-headers-0.1.0.tgz` |
| 只在一台机器上持续开发 | **本地目录 link** | `C:\path\to\dsh-plugin-custom-headers` |

共同前提：每台设备的 DSH 都在插件声明的范围内（`engines.dsh` 为
`>=0.2.2-rc.1 <0.3.0`），否则 `install_bundle` 会拒绝，运行中的 Host 也不会加载。

当前插件版本为 `v0.1.0`，下面示例里的 tag、registry 版本与 tarball 文件名都按它书写；
后续版本按语义化版本递增（补丁 `v0.1.1`、功能 `v0.2.0`、不兼容 `v1.0.0`）。

不要在设备之间同步 `node_modules/`、`.npm-cache/` 或整个 `~/.dsh` profile；
它们和操作系统、DSH 版本、本机路径绑定。

---

## 2. 方案 A：私有 Git 仓库（推荐）

### 2.1 在开发机上准备仓库

```powershell
git init -b main
git add .
git commit -m "chore: release 0.1.0"
git tag v0.1.0
git remote add origin git@github.com:<you>/dsh-plugin-custom-headers.git
git push -u origin main --tags
```

`lib/` 是构建产物，必须一起提交：DSH 安装后直接加载 `lib/index.js`，不会在目标
设备上替你执行 `npm run build`。

### 2.2 每台设备安装

```text
plugin_manager(
  action: "install_bundle",
  target: "git+ssh://git@github.com/<you>/dsh-plugin-custom-headers.git#v0.1.0"
)
```

- 私有仓库优先用 SSH（本机 `ssh-agent` 已解锁），或确认 Git 凭据助手可用；
  `installBundle` 会先跑 `git ls-remote` 做可达性检查，GitHub 检查期间不会弹认证提示。
- 用 tag 而不是浮动分支，设备之间才能确定跑的是同一份代码。
- 安装后确认：`list_plugins` 中该 bundle 的 `enabled` 为 true，设置页能看到两条
  （或你配置的）provider 路由。

### 2.3 升级

DSH 对“已经安装的同一个包”会拒绝直接覆盖，标准流程是先移除再安装新 tag：

```text
plugin_manager(action: "remove_bundle", target: "dsh-plugin-custom-headers")
plugin_manager(
  action: "install_bundle",
  target: "git+ssh://git@github.com/<you>/dsh-plugin-custom-headers.git#v0.1.0"
)
```

升级前先把版本号、`CHANGELOG.md` 和 tag 准备好；每台设备按同一 tag 安装。
回滚就是移除后安装上一个 tag。

---

## 3. 方案 B：私有 npm registry

适合设备多、希望像普通依赖一样升级的场景。

1. 把 `package.json` 的 `"private": true` 去掉（或改为私有 registry 允许的配置）。
2. 建议保留当前包名，发布到**私有 registry**；如果要发到 GitHub Packages 这类
   强制 scope 的 registry，需要把包名改成 `@scope/dsh-plugin-custom-headers`，
   并同步改 `cordis.patch.yml` 里的 `name`、`src/index.ts` 的 `name` 以及 README。
3. 发布：

   ```powershell
   npm run verify
   npm pack --dry-run   # 检查 files 白名单
   npm publish --registry https://npm.example.com
   ```

4. 每台设备配置 registry 与认证（profile 的 `.npmrc` 或环境变量），然后：

   ```text
   plugin_manager(
     action: "install_bundle",
     target: "dsh-plugin-custom-headers@0.1.0"
   )
   ```

   注册表安装会使用精确版本（`saveExact`），升级时同样建议
   `remove_bundle` → `install_bundle` 新版本。

`prepack` 已配置为 `npm run build`，所以 `npm pack` / `npm publish` 会先重新构建
`lib/`；`files` 白名单保证 tarball 不带 `test/`、`tools/` 和 `node_modules/`。

---

## 4. 方案 C：tarball（离线/内网最稳）

在开发机：

```powershell
npm run verify
npm pack
# 得到 dsh-plugin-custom-headers-0.1.0.tgz
```

把 `.tgz` 复制到目标设备（U 盘、内网文件服务器、对象存储均可），然后：

```text
plugin_manager(
  action: "install_bundle",
  target: "D:\\packages\\dsh-plugin-custom-headers-0.1.0.tgz"
)
```

也支持 HTTP(S) 的 tarball URL。tarball 安装同样会把包放进 profile 的
`node_modules`，不依赖目标设备有 Node 构建环境。

---

## 5. 方案 D：本地目录（只适合开发）

```text
plugin_manager(
  action: "install_bundle",
  target: "C:\\Users\\<you>\\Desktop\\Projects\\oh_my_dsh_plugins\\dsh-plugin-custom-headers"
)
```

它保存的是 `link:` 依赖，改代码立即生效（Host 半改完要重新加载插件，浏览器半
由 `client-hmr` 轮询 `client.js`）。但路径因设备而异，不适合作为多设备分发方案。

---

## 6. 每台设备还要做的配置

插件安装只解决“代码在不在”。下面这些是**每台设备独立**的：

### 6.1 provider 路由

路由仍然写在 profile 的 `cordis.patch.yml`，不是写在设置页面里。可以复制
[`examples/profile.patch.example.yml`](../examples/profile.patch.example.yml)
到：

```
~/.dsh/profiles/<profile>/cordis.patch.yml
```

它是对 `CustomHeaders` 行的覆盖：`id` + `name` 匹配后，整段 `config` 替换
bundle 默认值。把 `baseURL`、`apiKeyEnv`、模型 id 换成该设备实际使用的值。

如果多台设备完全一样，这份 patch 可以放进你自己的 dotfiles 仓库；但**不要**把
`~/.dsh/.credentials.yaml` 放进去。

### 6.2 API Key

密钥按设备录入：

- 打开设置页对应路由，填入真实 Key，保存后 profile 只留下 `apiKeyEnv` 引用名；
- 或提前在 credentials 服务 / 启动环境里放好同名引用。

每台设备的 Key 可以不同；插件不要求也不建议共享同一个 Key。

删除 Provider 并保存成功后，若该路由声明的 `apiKeyEnv` 不再被本插件其它路由使用，且值存于
凭据库（`source: "file"`，不是环境变量），页面会一并清除该值；清理失败只提示，不回滚配置删除。
页面看不到其它插件是否也引用同一个环境变量名，共用引用时请自行确认；直接改 profile patch
删除路由不会触发清理，只有从设置页删除并保存才会。

### 6.3 其它本机状态

- `localStorage` 里记住的 User-Agent 预设选择是**每台设备/浏览器**的，不会同步；
- 模型目录、`reasoning`、图片上限等如果写在 profile patch 里，会随 patch 一起
  复制；如果是在设置页改的，要确认该设备的 profile patch 已经保存；
- 目标网关（如 `gateway.example.com`）必须能从该设备访问。

### 6.4 安装后自检

1. `list_plugins`：bundle `enabled: true`，无 `DUPLICATE_ADAPTER`；
2. 设置页：能看到路由与模型，HTTP 请求头里 `User-Agent` 是配置值；
3. 在宿主内跑一次真实补全（或 `npm run online`，但该脚本要能解析到本地凭据）；
4. 检查日志里没有 `MISSING_CREDENTIAL` / `UNKNOWN_MODEL`。

---

## 7. 推荐工作流

1. 开发机：改代码 → `npm run verify` → 更新 `CHANGELOG.md` → bump `version`；
2. `npm pack --dry-run` 确认白名单，`git tag vX.Y.Z` 并 push；
3. 每台设备：`remove_bundle` → `install_bundle` 同一 tag / 同一版本；
4. 只把**代码 + patch 模板**放进 Git；Key、`~/.dsh`、`node_modules` 都不进。

如果以后插件数量变多，再把它们收进一个私有 monorepo，用同一套 tag/registry
流程分发即可。
