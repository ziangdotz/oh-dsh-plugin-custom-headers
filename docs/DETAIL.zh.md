# dsh-plugin-custom-headers

版本 **v0.1.0**。

为 DSH 注册自定义 pi-ai 供应商路由，让最终 HTTP 请求携带配置的 `User-Agent` 和额外请求头。

## 支持的协议

- OpenAI Chat Completions
- OpenAI Responses
- Anthropic Messages

每条路由可以配置协议、Base URL、请求头和模型目录。流式输出、工具调用、思考、图片、超时、取消和重试由 DSH 官方适配器处理，具体能力取决于模型及上游服务。

## 配置与使用

1. 启用插件，打开 DSH 设置中的 **Custom Headers**。
2. 添加供应商，填写路由 ID、协议和 Base URL。
3. 按需填写 API Key、选择 User-Agent 预设或手动编辑请求头。
4. 配置模型目录，也可点击“获取可用模型”从上游拉取。
5. 点击“保存”，然后在 DSH 模型选择器中选择对应路由的模型。

API Key 由宿主凭据服务保存，配置只记录引用名。已保存的密钥以占位提示显示，留空表示保留已有值。删除供应商时保留已存凭据，避免影响其他插件共享的引用。

## 安装与兼容性

当前验证基线为 DSH **0.2.2-rc.1**、Cordis **4.1.0**、pi-ai **1.3.0**、Schemastery **3.19.0**。插件版本为 **v0.1.0**。

本地源码安装示例，将路径替换为实际项目目录，并在安装后重启 DSH、启用插件。

```powershell
dsh plugin --profile desktop add 'link:C:\path\to\dsh-plugin-custom-headers'
```

当前基线下构建和类型检查通过，87 项自动化回归、18 项兼容检查通过。实机设置页加载和配置读取通过。真实上游调用结果取决于各服务的凭据、网络和模型支持。

## 使用边界

自定义头只作用于本插件注册的路由。插件利用官方适配器的 `profile.piProvider` 接口，在请求选项中合并配置头，从而覆盖默认的 harness User-Agent。DSH 或 pi-ai 升级后需要重新验证该接口和请求头合并行为。

获取模型目录会向配置的上游发送请求。保存设置会重新注册受影响的路由。

更多开发、部署和验证资料见项目 README、CHANGELOG 及 docs 目录。
