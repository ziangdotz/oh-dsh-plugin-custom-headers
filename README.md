# Custom Headers

为 DSH 提供可视化供应商路由管理与自定义 HTTP 请求头能力。

本插件由我们自行设计与开发，围绕路由配置、请求头控制、模型目录管理和凭据保存提供完整的使用流程。插件通过宿主接口接入模型调用能力，运行依赖由宿主提供。

- 包名：`dsh-plugin-custom-headers`
- 版本：`0.1.0`
- 许可证：MIT

## 功能

- **自定义请求头**：为每条路由配置 `User-Agent` 及其他请求头，按名称大小写不敏感合并，配置值在最终合并时优先。
- **三种协议**：支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。
- **供应商管理**：在设置页添加、编辑和删除路由，分别配置服务地址、协议、密钥与模型。
- **模型目录**：管理模型 ID、名称、上下文窗口、输出上限、文本/图片输入和推理等级，也可从服务端获取可用模型列表。
- **凭据保护**：密钥通过宿主凭据服务保存，路由配置只记录引用名，页面不回显已存密钥。
- **增量热更新**：仅更新发生变化的路由；替换注册失败时尝试恢复旧适配器，单条路由失败不阻断其他路由。
- **保存反馈**：识别过期编辑草稿；多条密钥部分保存成功时显示完成情况，便于重试。

## 安装与开始使用

### 环境要求

- DSH：`>=0.2.2-rc.1 <0.3.0`；兼容性验证基线为 `0.2.2-rc.1`。
- 本地开发：Node.js 22 或更高版本、npm。
- 插件需要在宿主中运行，不能作为独立服务启动。

### 安装本地目录

通过宿主插件管理工具安装项目目录：

```text
plugin_manager(action: "install_bundle", target: "C:\path\to\oh-dsh-plugin-custom-headers")
```

安装由插件管理工具完成链接与启用。源码安装前应先完成下文的构建步骤；安装或更新后，必要时重启宿主以加载设置页。

### 配置第一条路由

1. 打开 **设置 → Custom Headers**。
2. 添加供应商，填写唯一的路由 ID、协议和服务地址。
3. 填写 API Key，并添加需要发送的请求头。
4. 添加模型，或点击“获取可用模型”后选择需要的条目。
5. 保存配置，再在宿主中选择该路由下的模型使用。

包内默认路由使用示例地址，使用前请替换为自己的服务地址和模型目录。

## 配置示例

以下为插件的 `config` 内容。完整 profile 示例见 [配置模板](examples/profile.patch.example.yml)。

```yaml
providers:
  my-provider:
    displayName: my-provider
    api: openai-responses
    baseURL: https://api.example.com/v1
    apiKeyEnv: MY_PROVIDER_API_KEY
    headers:
      User-Agent: my-client/1.0
      X-Client-Name: custom-headers
    models:
      - id: my-model
        name: My Model
        contextWindow: 262144
        maxTokens: 32768
        input: [text, image]
        reasoningEfforts:
          off: null
          low: low
          medium: medium
          high: high
    reasoning: high
    streamIdleTimeoutMs: 300000
```

| 字段 | 说明 |
|---|---|
| `providers` | 路由集合，键为唯一的路由 ID |
| `displayName` | 与路由 ID 一致，由插件归一化 |
| `api` | `openai-completions`、`openai-responses` 或 `anthropic-messages` |
| `baseURL` | 服务基础地址；OpenAI 系通常包含 `/v1`，请按端点要求填写 |
| `apiKeyEnv` | 凭据引用名，也可匹配启动环境中的同名变量；不填写密钥明文 |
| `headers` | 当前路由的自定义请求头 |
| `models` | 至少一个有效模型，模型 ID 必须与服务端一致 |
| `contextWindow` / `maxTokens` | 上下文窗口与最大输出 token 数，默认分别为 `262144` / `32768` |
| `input` | 输入类型，默认 `[text]`，可加入 `image` |
| `reasoningEfforts` | 推理档位到协议参数的映射；省略表示非推理模型，`off: null` 表示不发送推理参数 |
| `reasoning` | 可选的路由默认推理等级 |
| `streamIdleTimeoutMs` | 可选的流式空闲超时，单位为毫秒 |

### 请求头与凭据

请求头仅作用于本插件注册的路由。名称按大小写不敏感处理，避免生成重复字段；非法名称、换行符及受限制的传输控制头会被拒绝。

在设置页输入真实 API Key 后，插件通过宿主凭据服务写入，并在配置中保存引用名。留空表示保留已有密钥。删除路由时保留凭据，避免影响共享同一引用的配置。

### 保存与模型发现

页面修改先保存在草稿中，点击保存后才写入。检测到配置版本已变化时，保存会被拒绝并提示重新加载；由于宿主未提供条件写入接口，这一检查不能保证跨进程的原子提交。

密钥先于路由配置保存。如果部分密钥写入成功而后续步骤失败，页面会报告已完成的引用名，重试时继续处理剩余内容。配置保存与运行时注册是两个阶段，注册失败需查看宿主日志。

“获取可用模型”使用已保存路由的地址、协议、凭据和请求头，默认超时为 30 秒，不跟随重定向。模型列表取决于端点支持情况；上下文窗口、输出上限及图片能力仍需自行核对。

## 开发与验证

```powershell
npm install
npm run vendor
npm run verify
```

`vendor` 从本机宿主安装包提取测试所需的运行依赖到 `node_modules`，不作为插件代码提交或分发。默认安装位置不适用时，请参考 [兼容性维护指南](docs/COMPATIBILITY.md)。

| 命令 | 用途 |
|---|---|
| `npm run check` | TypeScript 类型检查 |
| `npm run build` | 编译 `src/` 到 `lib/` |
| `npm test` | 运行完整回归测试 |
| `npm run verify` | 依次进行类型检查、构建与完整测试 |
| `npm run test:wire` | 请求与协议适配测试 |
| `npm run test:client` | 设置页逻辑测试 |
| `npm run test:discovery` | 模型发现测试 |
| `npm run compat` | 本机宿主兼容性检查 |
| `npm run pack:check` | 检查打包内容 |

当前回归基线为 **94 项测试通过**，覆盖请求头、配置校验、路由注册与恢复、凭据保存、编辑冲突及模型发现。默认测试使用本地模拟端点，不依赖真实 API Key；测试结果不等同于真实上游服务验收。

## 项目结构

```text
src/                 插件服务端源码：路由、请求头、配置、凭据接入与模型发现
client.js            可视化设置页
lib/                 TypeScript 构建产物，宿主加载入口
locale/              插件元数据的中英文文案
cordis.patch.yml     默认插件配置
examples/            配置模板
test/               回归测试
tools/              构建辅助、兼容检查与测试工具
docs/               架构与部署维护文档
```

## 常见问题

| 问题 | 检查方法 |
|---|---|
| 路由未出现 | 检查插件是否启用、配置是否有效，并查看宿主注册日志 |
| 路由 ID 冲突 | 改用当前 profile 中未占用的 ID |
| 密钥缺失或鉴权失败 | 检查凭据引用、实际密钥及服务端权限 |
| 请求头未生效 | 确认请求使用本插件注册的路由，并检查网关是否改写请求头 |
| 获取模型失败 | 检查已保存地址、密钥、模型列表接口及网络连通性 |
| 设置页未出现 | 重启宿主，并确认插件行 ID 保持为 `CustomHeaders` |
| 保存提示冲突 | 重新加载最新配置，再应用修改 |

插件当前使用 API Key 鉴权，不提供 OAuth 授权流程。模型能力以配置声明为准；服务升级后应复核兼容性并重新运行验证。

## 更多文档

- [架构设计](docs/ARCHITECTURE.md)
- [单机维护](docs/SINGLE-HOST.md)
- [多设备部署](docs/MULTI-DEVICE.md)
- [兼容性维护](docs/COMPATIBILITY.md)
- [更新记录](CHANGELOG.md)

## 许可证

本项目采用 [MIT License](LICENSE)。
