# DSH 0.2.2-rc.1 适配验证

验证日期为 2026-11-06，插件版本为 0.1.0，变更归入未发布章节。

## 环境和结果

本机官方 CLI `dsh --version` 返回 `0.2.2-rc.1`。安装载荷为 `C:/Tools/DeepSeek Harness/resources/app.asar`。

| 依赖 | 验证版本 |
|---|---|
| DSH、dsh-credentials、dsh-launch-environment、dsh-llm、dsh-llm-pi-ai | 0.2.2-rc.1 |
| Cordis | 4.1.0 |
| Schemastery | 3.19.0 |
| pi-ai | 1.3.0 |

- `tools/vendor-runtime-deps.mjs --force` 提取 108 个包，缺失的可选或其他平台依赖按脚本原有规则跳过。
- `tsc -p tsconfig.json` 构建通过，更新本地安装使用的 lib 产物。
- `tools/run-tests.mjs` 在刷新后的真实运行时依赖下 87/87 通过，包括本机 HTTP mock 的请求头及模型发现回归。
- 沙箱内本机连接返回 EACCES，获准在沙箱外重跑后全部通过。
- `tools/compat-check.mjs` 的 7 peer、1 engine、10 seam 全部 PASS，0 failure、0 warning。

四项 DSH 精确 peer 和 engines.dsh 下限更新为 0.2.2-rc.1，Cordis、Schemastery、pi-ai 的声明同步到本次验证版本。package-lock 根元数据同步更新。

## 安装和实机检查

执行官方命令 `dsh plugin --profile desktop add link:C:\Users\ziangdotz\Desktop\Projects\oh-dsh-plugin-custom-headers`，退出码为 0。

pnpm 提示 link 依赖的 peer 不从目标 node_modules 解析。DSH 宿主使用自己的运行时路由，本次构建、真实依赖回归及重启后的页面加载均通过。

通过应用菜单退出 DSH，再启动当前已安装的桌面程序。进入设置后 Custom Headers 入口可见，页面渲染标题、描述、2 条路由与 6 个模型摘要、供应商卡片、协议、Base URL、请求头和模型列表。页面显示没有未保存的修改，保存按钮禁用。

## 验证范围

本次实机检查覆盖重启后的入口、渲染和现有配置读取。配置保存行为由自动化回归覆盖，本次没有执行实机编辑保存、真实上游补全或目录拉取，也未独立抓取正在运行的 Host 请求。历史 rc.5 的保存验收保留在原报告中。
