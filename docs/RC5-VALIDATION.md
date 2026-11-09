# rc.5 适配验证

日期：2026-11-01。插件版本：0.1.0（未发布变更）。

## 环境与回归

- 安装载荷：C:/Tools/DeepSeek Harness/resources/app.asar。
- DSH、dsh-llm、dsh-llm-pi-ai、dsh-credentials、dsh-launch-environment：0.2.1-rc.5；Cordis 4.0.5、pi-ai 1.1.0、schemastery 3.18.5。
- Node 24.22.1；当前 PATH 中 nvm 的 npm 启动器不可用，因此直接用 Codex 捆绑 Node 调用项目脚本及 TypeScript。
- tools/vendor-runtime-deps.mjs --force：提取 107 个包；安装载荷中缺失的可选/其他平台依赖按工具原有规则跳过，不妨碍本套回归。
- tsc -p tsconfig.json：退出码 0。
- tools/run-tests.mjs：87 tests，87 pass，0 fail。使用刚刷新的 rc.5 真实适配器、pi-ai、SDK 和本机 HTTP mock。
- tools/compat-check.mjs：COMPATIBLE，7 peer + 1 engine + 10 seam 全 PASS，无警告。
- 沙箱禁止本地回环连接（EACCES），回归在获准的沙箱外执行；不连接真实上游。

## 设置页实机验收

使用 Windows computer-use 操作 DeepSeek Harness：

1. 初始插件详情显示“包不可用”，来源仍指向旧的 oh_my_dsh_plugins/dsh-plugin-custom-headers 目录；设置导航没有 Custom Headers。
2. 通过官方 CLI 的 dsh plugin --profile desktop add link:<当前项目绝对路径> 更新依赖链接；未手写 profile 配置。
3. 退出并重新启动 DSH，在插件管理页启用 dsh-plugin-custom-headers。
4. 设置导航出现 Custom Headers；实际页面显示标题、描述、1 条路由 / 1 个模型摘要、供应商卡片、协议、Base URL、凭据已配置占位符、请求头和模型目录。未读取或修改密钥值。
5. 将现有 UA 临时追加 rc5-validation，点击保存；页面提示“已保存，宿主已重新注册受影响的路由。”
6. 恢复原 UA 再次保存，确认同一成功提示、保存按钮禁用、原 UA 已恢复。

## 验收边界

设置页实际渲染与 UA 保存/恢复通过。页面成功提示是保存契约结果，本次没有独立读取 Host 注册日志或抓取正在运行的 Host 请求。真实适配器的 UA 抓包由本地回归覆盖。

未执行真实上游模型目录拉取、真实补全、图片调用、压力测试或长历史 replayState 验收。历史 rc.2/rc.3 网络记录保持原日期与版本，不作为 rc.5 成功证据。
