/**
 * Browser half of `dsh-plugin-custom-headers`.
 *
 * The Host half registers provider routes; this half gives those routes one
 * page under Settings (`settings.section`, nav label "Custom Headers"). It
 * reads and writes the row's configuration through the host `configForms`
 * service — the same settings document the built-in plugin pages use, so a save
 * takes the supported path through the profile configuration editor and the
 * plugin's own `loader/volatile-update` reconciliation.
 *
 * Deliberate limits of this version:
 *   - provider panels can be added and removed, but a new panel is only a draft
 *     until Save; the Host registers it on the next configuration update;
 *   - the model directory of a route is editable, because a route this plugin
 *     registers has no adapter catalog behind it and its models are exactly
 *     what the configuration says. `获取可用模型` asks the endpoint through the
 *     host's `llm/discoverModels` Remote, and the Host half answers that Remote
 *     for this plugin's namespace — the browser never handles a key;
 *   - `apiKeyEnv` is a credential *reference* name, so no secret ever reaches
 *     the browser;
 *   - the page is bound to the row id this bundle's patch inserts
 *     (`CustomHeaders`). A profile that renames the row stops serving the
 *     settings namespace under that id, and the page hides itself rather than
 *     writing to a namespace it does not own.
 *
 * Registered as a `window.__ModuleLoader__` factory whose id is the package
 * name, which is how the Host's client-module scan composes this bundle into
 * `window.__DSH_BOOT__`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-custom-headers',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** Profile row id inserted by this bundle's `cordis.patch.yml`. */
    const ROW_ID = 'CustomHeaders'
    /** List slot the Settings panel uses for one page per entry. */
    const SETTINGS_SECTION = 'settings.section'
    /** Stable nav id for this plugin's Settings page. */
    const SETTINGS_SECTION_ID = 'custom-headers'
    /** Place after the shipped Models/Plugins/Agent presets pages. */
    const SETTINGS_SECTION_ORDER = 30
    /** Locale namespace owned by this page. */
    const NS = 'CustomHeaders'
    /** Protocols the Host half can serve, in the order the built-in page lists them. */
    const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']
    /**
     * Full names for those protocols, spelled exactly as the built-in provider
     * page spells them, so the select reads like the rest of the product instead
     * of showing wire ids. The stored value stays the protocol id: these labels
     * are for the list only.
     */
    const PROTOCOL_LABELS = {
      'openai-completions': 'OpenAI Chat Completions',
      'openai-responses': 'OpenAI Responses',
      'anthropic-messages': 'Anthropic Messages',
    }
    /** Field names the Fetch layer owns; the Host refuses them, so the page blocks them first. */
    const RESERVED_HEADERS = new Set(['content-length', 'transfer-encoding', 'expect', 'upgrade'])
    /** RFC 9110 field-name token. */
    const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
    /** Thinking levels the Host schema accepts, in display order. */
    const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    /** Input types the Host schema accepts. */
    const MODALITIES = ['text', 'image']
    /** Levels a model offers when reasoning is switched on. */
    const INITIAL_LEVELS = ['off', 'low', 'medium', 'high']
    /** Accepted capacity spellings: a decimal count with an optional K/M suffix. */
    const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i
    /** Decimal suffix scales; `1M` is 1000K, matching how model capacities are quoted. */
    const CAPACITY_SCALE = { k: 1000, m: 1000000 }
    /**
     * Client identities a `User-Agent` header can be switched to.
     *
     * These are the headers the official CLIs send, not arbitrary spoofs:
     * Claude Code publishes `claude-cli/<version> (external, cli)` and Codex
     * publishes `codex_cli_rs/<version> (<os>; <arch>) <terminal>` (see
     * `codex-rs/login/src/auth/default_client.rs#get_codex_user_agent`).
     *
     * Latest published versions checked against the npm registry on
     * 2026-10-19: `@anthropic-ai/claude-code` 2.1.303 and `@openai/codex`
     * 0.163.0. Bump the two `value`s when either CLI releases; the ids and
     * labels stay stable, so opening the page never rewrites saved settings.
     */
    const USER_AGENT_PRESETS = [
      {
        id: 'claude-code-latest',
        labelKey: 'uaPresetClaude',
        value: 'claude-cli/2.1.303 (external, cli)',
      },
      {
        id: 'codex-latest',
        labelKey: 'uaPresetCodex',
        value: 'codex_cli_rs/0.163.0 (Windows 10.0.26100; x86_64) WindowsTerminal',
      },
    ]
    /** The identity a blank `User-Agent` header starts from. */
    const LATEST_CLAUDE_CODE_UA = USER_AGENT_PRESETS[0].value
    /** Select value that keeps a configured User-Agent which is not one of the presets. */
    const CURRENT_UA_OPTION = '__current__'
    /** Browser-local key for the last User-Agent preset the user picked. */
    const PRESET_STORAGE_KEY = 'dsh-plugin-custom-headers:last-user-agent-preset'
    /**
     * Last picked preset id. `undefined` until storage is read, `''` when none
     * was stored (or the stored value is unknown). Kept in memory as well, so a
     * browser that refuses `localStorage` still remembers the choice for this
     * page lifetime.
     */
    let rememberedPresetId

    /**
     * Read the last preset choice from browser storage.
     *
     * Presets are local constants, so remembering a choice is purely local: no
     * endpoint is queried and the default still works offline.
     * @returns {string} a known preset id, or `''` when none is remembered.
     */
    function readRememberedPresetId () {
      try {
        const store = typeof window === 'undefined' ? undefined : window.localStorage
        const stored = store?.getItem(PRESET_STORAGE_KEY)
        return USER_AGENT_PRESETS.some((preset) => preset.id === stored) ? stored : ''
      } catch {
        return ''
      }
    }

    /**
     * The last preset choice, read once per page and then kept in memory.
     * @returns {string} a known preset id, or `''` when none is remembered.
     */
    function rememberedUserAgentPresetId () {
      if (rememberedPresetId === undefined) rememberedPresetId = readRememberedPresetId()
      return rememberedPresetId
    }

    /**
     * Remember a preset choice locally. Storage failures are ignored: the
     * in-memory value still makes the rest of this page behave consistently.
     * @param {string} id - a known preset id.
     */
    function rememberUserAgentPreset (id) {
      rememberedPresetId = id
      try {
        const store = typeof window === 'undefined' ? undefined : window.localStorage
        store?.setItem(PRESET_STORAGE_KEY, id)
      } catch {
        /* A refused store must not break the page. */
      }
    }

    /**
     * The identity a blank `User-Agent` header starts from: the last preset the
     * user picked, or the latest Claude Code identity when nothing is stored.
     * @returns {string} a User-Agent value.
     */
    function defaultUserAgentValue () {
      const remembered = USER_AGENT_PRESETS.find((preset) => preset.id === rememberedUserAgentPresetId())
      return remembered === undefined ? LATEST_CLAUDE_CODE_UA : remembered.value
    }

    /**
     * Whether a header name is the User-Agent field (HTTP names are
     * case-insensitive, so `user-agent` and `USER-AGENT` count too).
     * @param {string} name - the configured header name.
     * @returns {boolean} true for the User-Agent field.
     */
    function isUserAgentHeader (name) {
      return String(name ?? '').trim().toLowerCase() === 'user-agent'
    }

    /**
     * Label for the option that keeps a configured User-Agent no preset matches.
     * Naming the client (rather than a generic "current value") makes it clear
     * that an older Claude Code or Codex version is selected and a newer preset
     * is available.
     * @param {{ value: string }} row - the header row as the page edits it.
     * @param {object} props - the row editor's props, carrying the localized strings.
     * @returns {string} the option label.
     */
    function currentUserAgentLabel (row, props) {
      if (row.value.startsWith('claude-cli/')) return props.presetClaudeCurrent
      if (row.value.startsWith('codex_cli_rs/')) return props.presetCodexCurrent
      return props.presetCurrent
    }

    /**
     * Read a typed capacity so `256K` or `1M` can stand for the token count.
     * @param text - raw field text.
     * @returns the count; `undefined` when blank, `NaN` when unreadable.
     */
    function parseCapacity (text) {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return undefined
      const match = CAPACITY_PATTERN.exec(trimmed)
      if (match === null) return NaN
      const suffix = match[2] === undefined ? '' : match[2].toLowerCase()
      const scale = suffix === '' ? 1 : CAPACITY_SCALE[suffix]
      const scaled = Number(match[1]) * scale
      const rounded = Math.round(scaled)
      return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
    }

    /** Spell a stored count in the shortest form that survives {@link parseCapacity}. */
    function formatCapacity (value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      if (!Number.isInteger(value) || value <= 0) return String(value)
      if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`
      if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`
      return String(value)
    }

    /**
     * Whether the folded part of a model row holds something that blocks a save.
     * Mirrors the capacity and reasoning rules of {@link validateDraft}, so a row
     * the page refuses to save never hides the fields that explain why.
     * @param row - the model row as the page edits it.
     * @returns true when the row should render expanded.
     */
    function modelNeedsAttention (row) {
      const unreadable = (text) => {
        const parsed = parseCapacity(text)
        return typeof parsed === 'number' && !(Number.isFinite(parsed) && parsed > 0)
      }
      if (unreadable(row.contextWindow) || unreadable(row.maxTokens)) return true
      if (row.reasoningEfforts === null) return false
      const open = row.reasoningEfforts.filter((level) => level.level !== 'off')
      return open.length === 0 || open.some((level) => level.value.trim() === '')
    }

    /** A route/provider id: lowercase letters, digits and hyphens. */
    const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/
    /** A credential reference: the POSIX shell identifier the store keys on. */
    const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

    /**
     * The credential reference a route stores its key under.
     *
     * A route that already names one keeps it, so a key typed here lands where
     * the route already reads from; a route that names none gets the
     * conventional `<ROUTE>_API_KEY` name, which the page writes into the draft
     * alongside the key. A declared name outside the reference grammar cannot be
     * resolved by the credential seam, so it is replaced rather than echoed.
     * @param route - route id as the profile spells it.
     * @param declared - the route's configured `apiKeyEnv`, when it has one.
     * @returns the reference to store under and to record in the profile.
     */
    function keyRefOf (route, declared) {
      const named = String(declared ?? '').trim()
      if (CREDENTIAL_REF.test(named)) return named
      const stem = String(route).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      return `${/^[A-Za-z_]/.test(stem) ? stem : `K_${stem}`}_API_KEY`
    }

    /** Simplified Chinese copy. */
    const zh = {
      loading: '正在读取配置…',
      unavailable: '宿主没有为这一行提供配置表单，这里暂时无法编辑。',
      readOnly: '本部署的配置为只读。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saved: '配置已保存；路由应用失败时宿主会记录错误并尝试恢复旧路由。',
      credentialsRetained: '路由已删除，共享密钥已保留。',
      saveConflict: '配置已在其他位置更新。请放弃草稿并重新编辑。',
      keysPartiallySaved: '以下密钥已保存，重试时不会重复写入：{refs}',
      saveFailed: '宿主没有接受这些值，已保留供你修改。',
      dirty: '有未保存的修改。',
      pristine: '没有未保存的修改。',
      displayName: '显示名称',
      api: '协议',
      baseURL: 'Base URL',
      apiKey: 'API Key',
      apiKeyPlaceholder: '粘贴 API Key',
      apiKeyConfigured: '已配置；留空则保持不变',
      apiKeyUnavailable: '宿主没有提供凭据服务，密钥无法在这里保存。',
      apiKeyRejected: '密钥没有保存成功：{message}',
      apiKeyCleanupFailed: '路由已删除，但已保存的 API Key 未能清理：{message}',
      apiKeyCleanupUnavailable: '路由已删除，但当前无法访问凭据库，已保存的 API Key 仍保留在凭据库中。',
      keyReveal: '显示密钥',
      keyHide: '隐藏密钥',
      headers: '请求头',
      headersEmpty: '没有自定义请求头，路由按适配器默认头发出请求。',
      headerName: '名称',
      headerValue: '值',
      addHeader: '添加请求头',
      removeHeader: '删除',
      uaPreset: 'User-Agent 预设',
      uaPresetPlaceholder: '选择预设…',
      uaPresetCurrent: '当前值',
      uaPresetClaudeCurrent: 'Claude Code（当前）',
      uaPresetCodexCurrent: 'Codex（当前）',
      uaPresetClaude: 'Claude Code（最新）',
      uaPresetCodex: 'Codex（最新）',
      uaPresetHint: '选择预设会填入该客户端最新的 User-Agent；仍可手动修改。',
      models: '模型目录',
      modelsInherited: '默认模型目录',
      modelsCustomized: '已自定义模型目录',
      resetModels: '恢复默认模型',
      fetchModels: '获取可用模型',
      fetching: '正在询问提供商…',
      fetchNeedsBaseUrl: '请先填写 Base URL，再获取。',
      fetchEmpty: '该地址没有列出任何模型，请手动添加。',
      fetchTitle: '选择要添加的模型',
      fetchDescription: '以下是该地址提供的可用模型，勾选要添加的模型。',
      fetchSearch: '搜索模型',
      fetchNoMatches: '没有匹配的模型。',
      fetchSelectAll: '全选',
      fetchDeselectAll: '取消全选',
      fetchAdopt: '添加所选',
      cancel: '取消',
      addModel: '添加模型',
      removeModel: '删除模型',
      modelId: '模型 ID',
      modelName: '显示名称',
      modelNamePlaceholder: '留空时使用模型 ID',
      contextWindow: '上下文窗口',
      contextWindowPlaceholder: '使用提供商默认值',
      maxTokens: '最大输出 token 数',
      maxTokensPlaceholder: '使用提供商默认值',
      modelAdvanced: '模型选项',
      modelInputTypes: '输入类型',
      modelInputText: '文本',
      modelInputImage: '图片',
      modelReasoning: '推理等级',
      modelReasoningLevel: '档位',
      modelReasoningValue: 'API 参数值',
      modelReasoningOffValuePlaceholder: '关闭思考',
      modelReasoningAdd: '添加档位',
      modelReasoningRemove: '删除档位',
      switchOn: '开',
      switchOff: '关',
      modelIdRequired: '路由 {provider} 的第 {position} 个模型缺少 ID。',
      modelIdDuplicate: '路由 {provider} 的模型 ID“{id}”重复。',
      modelsRequired: '路由 {provider} 至少需要一个模型。',
      modelContextInvalid: '路由 {provider} 第 {position} 个模型的上下文窗口必须是正数，例如 131072、256K 或 1M。',
      modelMaxTokensInvalid: '路由 {provider} 第 {position} 个模型的最大输出 token 数必须是正数，例如 8192、64K 或 1M。',
      modelReasoningNeedsLevel: '路由 {provider} 第 {position} 个模型至少需要一个 Off 以外的档位；不需要思考请关闭推理等级。',
      modelReasoningValueRequired: '路由 {provider} 第 {position} 个模型的推理档位需要非空的 API 参数值。',
      summary: '{providers} 条路由 · {models} 个模型 · 请求头：{headers}',
      none: '无',
      uaOverride: '覆盖 User-Agent',
      invalidApi: '路由 {provider} 的协议不在本插件支持的范围内。',
      invalidBaseURL: '路由 {provider} 的 Base URL 必须是 http(s) 绝对地址。',
      invalidHeaderName: '路由 {provider} 的请求头名称“{name}”不是合法的 HTTP 字段名。',
      reservedHeader: '路由 {provider} 的请求头“{name}”由 HTTP 层自己管理，不能在这里设置。',
      invalidHeaderValue: '路由 {provider} 的请求头“{name}”的值不能换行。',
      duplicateHeader: '路由 {provider} 重复设置了请求头“{name}”（名称不区分大小写）。',
      addProvider: '添加供应商',
      removeProvider: '删除供应商',
      providerId: '路由 ID',
      providerIdPlaceholder: '例如 my-provider',
      providerIdRequired: '请填写路由 ID。',
      providerIdInvalid: '路由 ID“{id}”只能包含小写字母、数字和连字符，并以字母或数字开头。',
      providerIdDuplicate: '路由 ID“{id}”已存在。',
      providersEmpty: '还没有供应商路由；填写路由 ID 后添加一个。',
      addProviderHint: '新路由保存后才会注册；如果默认模型指向它，请同步修改默认模型。',
      settingsTitle: 'Custom Headers',
      settingsLead: '在 pi-ai 上注册自定义供应商路由（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages），使其最终发出的 HTTP 请求携带部署配置的 User-Agent 及额外请求头。',
      settingsSectionLabel: 'Custom Headers',
    }

    /** English copy, key-for-key with `zh`. */
    const en = {
      loading: 'Reading configuration…',
      unavailable: 'The host serves no configuration form for this row, so it cannot be edited here.',
      readOnly: 'This deployment stores configuration read-only.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saved: 'Configuration saved; the host logs application failures and attempts to restore previous routes.',
      credentialsRetained: 'Route removed; shared credentials were retained.',
      saveConflict: 'Configuration changed elsewhere. Discard the draft and edit again.',
      keysPartiallySaved: 'Keys already stored and excluded from retry: {refs}',
      saveFailed: 'The host did not accept these values; they were left for you to correct.',
      dirty: 'Unsaved changes.',
      pristine: 'No unsaved changes.',
      displayName: 'Display name',
      api: 'Protocol',
      baseURL: 'Base URL',
      apiKey: 'API key',
      apiKeyPlaceholder: 'Paste the API key',
      apiKeyConfigured: 'Configured — leave blank to keep it',
      apiKeyUnavailable: 'The host exposes no credential service, so a key cannot be saved here.',
      apiKeyRejected: 'The key was not stored: {message}',
      apiKeyCleanupFailed: 'The route was removed, but its stored API key was not cleared: {message}',
      apiKeyCleanupUnavailable: 'The route was removed, but the credential store could not be reached, so its stored API key remains.',
      keyReveal: 'Show the key',
      keyHide: 'Hide the key',
      headers: 'Headers',
      headersEmpty: 'No custom headers; the route sends the adapter defaults.',
      headerName: 'Name',
      headerValue: 'Value',
      addHeader: 'Add header',
      removeHeader: 'Remove',
      uaPreset: 'User-Agent preset',
      uaPresetPlaceholder: 'Choose a preset…',
      uaPresetCurrent: 'Current value',
      uaPresetClaudeCurrent: 'Claude Code (current)',
      uaPresetCodexCurrent: 'Codex (current)',
      uaPresetClaude: 'Claude Code (latest)',
      uaPresetCodex: 'Codex (latest)',
      uaPresetHint: 'A preset fills the latest User-Agent for that client; the value stays editable.',
      models: 'Models',
      modelsInherited: 'Default directory',
      modelsCustomized: 'Customized',
      resetModels: 'Restore defaults',
      fetchModels: 'Fetch available models',
      fetching: 'Asking the provider…',
      fetchNeedsBaseUrl: 'Enter a Base URL before fetching.',
      fetchEmpty: 'This endpoint listed no models; add them by hand.',
      fetchTitle: 'Choose models to add',
      fetchDescription: 'These are the models this endpoint offers; tick the ones to add.',
      fetchSearch: 'Search models',
      fetchNoMatches: 'No model matches.',
      fetchSelectAll: 'Select all',
      fetchDeselectAll: 'Deselect all',
      fetchAdopt: 'Add selected',
      cancel: 'Cancel',
      addModel: 'Add model',
      removeModel: 'Remove model',
      modelId: 'Model ID',
      modelName: 'Display name',
      modelNamePlaceholder: 'Falls back to the model ID',
      contextWindow: 'Context window',
      contextWindowPlaceholder: 'Provider default',
      maxTokens: 'Max output tokens',
      maxTokensPlaceholder: 'Provider default',
      modelAdvanced: 'Model options',
      modelInputTypes: 'Input types',
      modelInputText: 'Text',
      modelInputImage: 'Image',
      modelReasoning: 'Reasoning levels',
      modelReasoningLevel: 'Level',
      modelReasoningValue: 'API value',
      modelReasoningOffValuePlaceholder: 'Thinking off',
      modelReasoningAdd: 'Add level',
      modelReasoningRemove: 'Remove level',
      switchOn: 'On',
      switchOff: 'Off',
      modelIdRequired: 'Model {position} of route {provider} needs an ID.',
      modelIdDuplicate: 'Route {provider} repeats model ID "{id}".',
      modelsRequired: 'Route {provider} needs at least one model.',
      modelContextInvalid: 'Context window of model {position} on route {provider} must be a positive number, for example 131072, 256K or 1M.',
      modelMaxTokensInvalid: 'Max output tokens of model {position} on route {provider} must be a positive number, for example 8192, 64K or 1M.',
      modelReasoningNeedsLevel: 'Model {position} of route {provider} needs a level other than Off; turn reasoning off instead.',
      modelReasoningValueRequired: 'A reasoning level of model {position} on route {provider} needs a non-empty API value.',
      summary: '{providers} routes · {models} models · headers: {headers}',
      none: 'none',
      uaOverride: 'Overrides User-Agent',
      invalidApi: 'Route {provider} uses a protocol this plugin does not serve.',
      invalidBaseURL: 'Route {provider} needs an absolute http(s) Base URL.',
      invalidHeaderName: '"{name}" on route {provider} is not a valid HTTP field name.',
      reservedHeader: 'Header "{name}" on route {provider} is owned by the HTTP layer and cannot be set here.',
      invalidHeaderValue: 'Header "{name}" on route {provider} must be a single line.',
      duplicateHeader: 'Route {provider} repeats header "{name}" (names are case-insensitive).',
      addProvider: 'Add provider',
      removeProvider: 'Remove provider',
      providerId: 'Route ID',
      providerIdPlaceholder: 'e.g. my-provider',
      providerIdRequired: 'Enter a route ID.',
      providerIdInvalid: 'Route ID "{id}" may contain only lowercase letters, digits and hyphens, and must start with a letter or digit.',
      providerIdDuplicate: 'Route ID "{id}" already exists.',
      providersEmpty: 'No provider routes yet; enter a route ID below to add one.',
      addProviderHint: 'A new route is registered after saving. If the default model points to it, update that default too.',
      settingsTitle: 'Custom Headers',
      settingsLead: 'Registers custom pi-ai provider routes (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages) whose final HTTP requests carry a deployment-configured User-Agent and extra headers.',
      settingsSectionLabel: 'Custom Headers',
    }

    /**
     * Flatten a configured provider dictionary into the page's edit model. Only
     * fields this page edits are kept: models and the tuning knobs stay exactly
     * as configured because the page writes field paths rather than the whole
     * provider object.
     * @param providers - the configured provider dictionary, when present.
     * @returns route name to editable fields.
     */
    function toDraft (providers) {
      const draft = {}
      for (const [name, source] of Object.entries(providers ?? {})) {
        const entry = source !== null && typeof source === 'object' ? source : {}
        const headers = entry.headers !== null && typeof entry.headers === 'object' ? entry.headers : {}
        draft[name] = {
          // `displayName` is derived, never edited: the route id is the one
          // display identity, and an older profile's friendly label is ignored.
          displayName: name,
          api: typeof entry.api === 'string' ? entry.api : '',
          baseURL: typeof entry.baseURL === 'string' ? entry.baseURL : '',
          apiKeyEnv: typeof entry.apiKeyEnv === 'string' ? entry.apiKeyEnv : '',
          headers: Object.entries(headers).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : String(value) })),
          models: modelRowsOf(entry.models),
        }
      }
      return draft
    }

    /** Copy the edit model so React state stays immutable. */
    function cloneDraft (draft) {
      const copy = {}
      for (const [name, entry] of Object.entries(draft)) {
        copy[name] = {
          displayName: entry.displayName,
          api: entry.api,
          baseURL: entry.baseURL,
          apiKeyEnv: entry.apiKeyEnv,
          headers: entry.headers.map((row) => ({ key: row.key, value: row.value })),
          models: cloneModelRows(entry.models),
        }
      }
      return copy
    }

    /** Turn header rows into the configured dictionary, dropping empty rows. */
    function headersOf (rows) {
      const headers = {}
      for (const row of rows) {
        const name = row.key.trim()
        if (name === '') continue
        headers[name] = row.value
      }
      return headers
    }

    /**
     * One configured model entry as an edit row.
     *
     * The row keeps capacities as typed text so `1M` survives a round trip, and
     * reasoning levels as an ordered list so an unknown level the schema allows
     * is never dropped by an edit that touches another field.
     * @param source - the configured model entry.
     * @returns the edit row.
     */
    function modelRowOf (source) {
      const entry = source !== null && typeof source === 'object' ? source : { id: source }
      const input = Array.isArray(entry.input)
        ? entry.input.filter((modality) => MODALITIES.includes(modality))
        : []
      const efforts = entry.reasoningEfforts
      let levels = null
      if (efforts !== null && typeof efforts === 'object' && !Array.isArray(efforts)) {
        const known = THINKING_LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(efforts, level))
        const unknown = Object.keys(efforts).filter((level) => !THINKING_LEVELS.includes(level))
        levels = [...known, ...unknown].map((level) => ({
          level,
          value: typeof efforts[level] === 'string' ? efforts[level] : '',
        }))
      }
      return {
        id: typeof entry.id === 'string' ? entry.id : String(entry.id ?? ''),
        name: typeof entry.name === 'string' ? entry.name : '',
        contextWindow: formatCapacity(entry.contextWindow),
        maxTokens: formatCapacity(entry.maxTokens),
        input: input.length === 0 ? ['text'] : input,
        reasoningEfforts: levels,
      }
    }

    /** Read a configured `models` array into edit rows, keeping every entry. */
    function modelRowsOf (models) {
      return Array.isArray(models) ? models.map(modelRowOf) : []
    }

    /** Copy model rows so React state stays immutable. */
    function cloneModelRows (rows) {
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        contextWindow: row.contextWindow,
        maxTokens: row.maxTokens,
        input: [...row.input],
        reasoningEfforts: row.reasoningEfforts === null
          ? null
          : row.reasoningEfforts.map((level) => ({ level: level.level, value: level.value })),
      }))
    }

    /**
     * The value one edit row writes, with fields the configuration did not state
     * left out: an empty name, a blank capacity, the default input set and a
     * switched-off reasoning list are all absent rather than written as defaults.
     * @param row - the edit row.
     * @returns the model entry to store.
     */
    function modelEntryOf (row) {
      const id = row.id.trim()
      const name = row.name.trim()
      const contextWindow = parseCapacity(row.contextWindow)
      const maxTokens = parseCapacity(row.maxTokens)
      const input = MODALITIES.filter((modality) => row.input.includes(modality))
      const entry = { id }
      if (name !== '') entry.name = name
      if (contextWindow !== undefined) entry.contextWindow = contextWindow
      if (maxTokens !== undefined) entry.maxTokens = maxTokens
      if (input.length > 0 && !(input.length === 1 && input[0] === 'text')) entry.input = input
      if (row.reasoningEfforts !== null) {
        const efforts = {}
        for (const level of row.reasoningEfforts) {
          efforts[level.level] = level.level === 'off' ? null : level.value.trim()
        }
        entry.reasoningEfforts = efforts
      }
      return entry
    }

    /** Serialize model rows into the comparable form {@link sameModels} uses. */
    function modelKeys (rows) {
      return rows.map((row) => JSON.stringify(modelEntryOf(row)))
    }

    /** Whether two model directories would store the same value. */
    function sameModels (left, right) {
      if (left.length !== right.length) return false
      const before = modelKeys(left)
      const after = modelKeys(right)
      return before.every((key, index) => key === after[index])
    }

    /** Compare two header dictionaries case-insensitively but order-sensitively by name. */
    function sameHeaders (left, right) {
      const leftNames = Object.keys(left)
      const rightNames = Object.keys(right)
      if (leftNames.length !== rightNames.length) return false
      const folded = new Map(leftNames.map((name) => [name.toLowerCase(), name]))
      for (const name of rightNames) {
        const match = folded.get(name.toLowerCase())
        if (match === undefined || left[match] !== right[name]) return false
      }
      return true
    }

    /**
     * The full provider entry a newly added route writes, or an existing entry
     * with the page-owned fields layered over it.
     *
     * Existing routes are normally updated field by field so tuning fields the
     * page does not show survive. Removing a route that the inherited layer also
     * declares forces a whole-dictionary write instead (see `mutationsOf`), and
     * that write must carry those same tuning fields forward: spreading the
     * previous raw entry and overriding only what the page owns does that.
     * @param provider - the route id, also the derived display name.
     * @param entry - the route as the page edits it.
     * @param previous - the raw entry currently configured for this route, if any.
     * @returns the provider configuration to store.
     */
    function routeEntryOf (provider, entry, previous) {
      const value = previous !== undefined && previous !== null && typeof previous === 'object' && !Array.isArray(previous)
        ? { ...previous }
        : {}
      value.api = entry.api
      value.baseURL = entry.baseURL.trim()
      value.models = entry.models.map((row) => modelEntryOf(row))
      value.displayName = provider
      const apiKeyEnv = entry.apiKeyEnv.trim()
      if (apiKeyEnv === '') delete value.apiKeyEnv
      else value.apiKeyEnv = apiKeyEnv
      const headers = headersOf(entry.headers)
      if (Object.keys(headers).length === 0) delete value.headers
      else value.headers = headers
      return value
    }

    /** Report every reason the draft would be refused, as localized sentences. */
    function validateDraft (draft, t) {
      const problems = []
      for (const [provider, entry] of Object.entries(draft)) {
        if (!PROTOCOLS.includes(entry.api)) problems.push(t('invalidApi', { provider }))
        let url
        try {
          url = new URL(entry.baseURL)
        } catch {
          problems.push(t('invalidBaseURL', { provider }))
        }
        if (url !== undefined && url.protocol !== 'http:' && url.protocol !== 'https:') problems.push(t('invalidBaseURL', { provider }))
        const seen = new Set()
        for (const row of entry.headers) {
          const name = row.key.trim()
          if (name === '' && row.value === '') continue
          if (!HEADER_NAME.test(name)) problems.push(t('invalidHeaderName', { provider, name }))
          else if (RESERVED_HEADERS.has(name.toLowerCase())) problems.push(t('reservedHeader', { provider, name }))
          else if (/[\r\n]/.test(row.value)) problems.push(t('invalidHeaderValue', { provider, name }))
          else if (seen.has(name.toLowerCase())) problems.push(t('duplicateHeader', { provider, name }))
          else seen.add(name.toLowerCase())
        }
        if (entry.models.length === 0) problems.push(t('modelsRequired', { provider }))
        const modelIds = new Set()
        entry.models.forEach((model, index) => {
          const position = index + 1
          const id = model.id.trim()
          if (id === '') problems.push(t('modelIdRequired', { provider, position }))
          else if (modelIds.has(id)) problems.push(t('modelIdDuplicate', { provider, id }))
          else modelIds.add(id)
          const contextWindow = parseCapacity(model.contextWindow)
          if (typeof contextWindow === 'number' && !(Number.isFinite(contextWindow) && contextWindow > 0)) {
            problems.push(t('modelContextInvalid', { provider, position }))
          }
          const maxTokens = parseCapacity(model.maxTokens)
          if (typeof maxTokens === 'number' && !(Number.isFinite(maxTokens) && maxTokens > 0)) {
            problems.push(t('modelMaxTokensInvalid', { provider, position }))
          }
          if (model.reasoningEfforts === null) return
          const open = model.reasoningEfforts.filter((level) => level.level !== 'off')
          if (open.length === 0) problems.push(t('modelReasoningNeedsLevel', { provider, position }))
          else if (open.some((level) => level.value.trim() === '')) {
            problems.push(t('modelReasoningValueRequired', { provider, position }))
          }
        })
      }
      return problems
    }

    /**
     * Diff the edit model against the configured routes and return the settings
     * mutations that apply it. Field paths keep everything the page does not
     * show — models and the tuning knobs — untouched.
     *
     * Removing a route is the one case that cannot always be a field edit. The
     * Host's `unset` restores the inherited value of a field (that is what makes
     * "clear a field" mean "fall back to the bundle default"), so unsetting a
     * route id that the bundle patch also declares simply brings that route
     * back after save. A route that exists in the inherited layer is therefore
     * removed by writing the complete `providers` dictionary without it; the
     * page then owns the dictionary, and every remaining entry is carried over
     * with its raw value so tuning fields still survive.
     * @param draft - staged edit model.
     * @param configured - edit model built from the current configuration.
     * @param context - inherited route names, raw current entries, and whether to
     *   normalize a legacy friendly `displayName` while saving.
     * @returns ordered settings operations, empty when nothing changed.
     */
    function mutationsOf (draft, configured, context = {}) {
      const operations = []
      const inherited = context.inheritedProviders ?? new Set()
      const rawProviders = context.rawProviders ?? {}
      // A removed route disappears from the draft entirely, so it cannot be
      // found by walking the draft.
      const removed = Object.keys(configured).filter((provider) => !Object.prototype.hasOwnProperty.call(draft, provider))
      if (removed.some((provider) => inherited.has(provider))) {
        const providers = {}
        for (const [provider, entry] of Object.entries(draft)) {
          const raw = rawProviders[provider]
          providers[provider] = raw === undefined ? routeEntryOf(provider, entry) : routeEntryOf(provider, entry, raw)
        }
        operations.push({ op: 'set', path: ['providers'], value: providers })
        return operations
      }
      for (const provider of removed) {
        operations.push({ op: 'unset', path: ['providers', provider] })
      }
      for (const [provider, entry] of Object.entries(draft)) {
        if (!Object.prototype.hasOwnProperty.call(configured, provider)) {
          operations.push({ op: 'set', path: ['providers', provider], value: routeEntryOf(provider, entry) })
          continue
        }
        const before = configured[provider]
        for (const field of ['api', 'baseURL', 'apiKeyEnv']) {
          const next = entry[field].trim()
          if (next === before[field]) continue
          if (next === '') operations.push({ op: 'unset', path: ['providers', provider, field] })
          else operations.push({ op: 'set', path: ['providers', provider, field], value: next })
        }
        // `displayName` is no longer user-editable. A save rewrites an older
        // friendly value to the route id, but only when the page is saving
        // something else: a pristine open must not look dirty just because the
        // stored label predates this rule.
        if (context.normalizeDisplayName === true) {
          const rawDisplayName = rawProviders[provider]?.displayName
          if (typeof rawDisplayName !== 'string' || rawDisplayName !== provider) {
            operations.push({ op: 'set', path: ['providers', provider, 'displayName'], value: provider })
          }
        }
        const previous = headersOf(before.headers)
        const next = headersOf(entry.headers)
        if (!sameHeaders(previous, next)) operations.push({ op: 'set', path: ['providers', provider, 'headers'], value: next })
        if (!sameModels(entry.models, before.models)) {
          operations.push({
            op: 'set',
            path: ['providers', provider, 'models'],
            value: entry.models.map((row) => modelEntryOf(row)),
          })
        }
      }
      return operations
    }

    /**
     * Page styles.
     *
     * Proportions, rhythm and control heights mirror the built-in Models page
     * (`dsh-client-ui-settings-models`): a 720px content column with a 12px
     * rhythm, 16px/24 page title, 14px/22 intro, 14px/22 body copy, 12px/18
     * section labels with a hairline rule, 36px page buttons, 32px inputs on
     * `--dsw-radius-md`, and 28px row controls. Cards use the same
     * `--dsw-alias-settings-card-*` surface tokens, and the field grid stays at
     * two columns inside that column rather than stretching into four. Only host
     * theme tokens are used, so light and dark themes follow along.
     */
    const CSS = [
      '.dshch{display:flex;flex-direction:column;gap:12px;width:100%;max-width:720px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
      '.dshch-settingsIntro{display:flex;flex-direction:column;gap:8px}',
      '.dshch-settingsTitle{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.dshch-settingsLead{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}',
      '.dshch-settingsSummary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshch-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshch-cards{display:flex;flex-direction:column;gap:8px}',
      '.dshch-card{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}',
      '.dshch-cardHead{display:flex;align-items:center;gap:10px;min-width:0}',
      '.dshch-route{margin:0;min-width:0;overflow:hidden;font-size:14px;font-weight:500;line-height:22px;text-overflow:ellipsis;white-space:nowrap}',
      '.dshch-id{font-family:var(--ds-font-family-code);font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshch-cardHeadActions{position:relative;z-index:2;display:inline-flex;align-items:center;gap:4px;margin-left:auto}',
      '.dshch-cardHeadActions .dshch-iconButton{position:relative;z-index:1;width:28px;height:28px}',
      '.dshch-warn{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);padding:1px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-label);white-space:nowrap}',
      '.dshch-addRoute{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}',
      '.dshch-addToggle{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;height:36px;padding:0 14px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:none;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dshch-addToggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshch-addToggle:disabled{opacity:.4;cursor:default}',
      '.dshch-addActions{display:flex;justify-content:flex-end;gap:8px}',
      '.dshch-addRouteHead{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}',
      '.dshch-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}',
      '.dshch-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dshch-label{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshch-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshch-input,.dshch-select{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dshch-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
      '.dshch-keyInput{position:relative;display:flex;align-items:center}',
      '.dshch-keyInput .dshch-input{padding-right:40px}',
      '.dshch-keyToggle{position:absolute;right:1px;top:1px;bottom:1px;display:inline-flex;align-items:center;justify-content:center;width:32px;padding:0;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dshch-keyToggle:hover:enabled{color:var(--dsw-alias-label-primary)}',
      '.dshch-keyToggle:disabled{cursor:default;opacity:.6}',
      '.dshch-input:disabled,.dshch-select:disabled{opacity:.6;cursor:default;color:var(--dsw-alias-label-tertiary)}',
      '.dshch-input:focus,.dshch-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.dshch-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}',
      '.dshch-select{cursor:pointer}',
      '.dshch-section{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dshch-sectionHead{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}',
      '.dshch-sectionTitle{margin:0;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshch-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshch-headActions{display:inline-flex;flex-wrap:wrap;align-items:center;gap:2px;margin-left:auto}',
      '.dshch-linkButton{box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dshch-linkButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dshch-linkButton:disabled{opacity:.4;cursor:default}',
      '.dshch-headerRow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) 28px;gap:8px;align-items:center}',
      '.dshch-headerValue{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:8px;align-items:center;min-width:0}',
      '.dshch-uaPreset{min-width:0}',
      '.dshch-stack{display:flex;flex-direction:column;gap:8px}',
      '.dshch-model{display:flex;flex-direction:column;padding:6px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg)}',
      '.dshch-modelRow{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto auto;gap:6px;align-items:center}',
      '.dshch-modelAdvanced{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:8px 4px 2px}',
      '.dshch-iconButton{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dshch-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshch-iconButton:disabled{opacity:.4;cursor:default}',
      '.dshch-iconDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}',
      '.dshch-inputTypes{display:flex;flex-direction:column;gap:4px;grid-column:1/-1;min-width:0;margin:0;padding:0;border:none}',
      '.dshch-choices{display:flex;flex-wrap:wrap;align-items:center;gap:16px;min-height:32px}',
      '.dshch-choice{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dshch-choice input{margin:0;accent-color:var(--dsw-alias-state-business-primary)}',
      '.dshch-reasoning{display:flex;flex-direction:column;gap:6px;grid-column:1/-1;min-width:0}',
      '.dshch-reasoningHead{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dshch-reasoningRow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 28px;gap:6px;align-items:center}',
      '.dshch-switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dshch-switch input{margin:0;accent-color:var(--dsw-alias-state-business-primary)}',
      '.dshch-addModel{box-sizing:border-box;display:inline-flex;align-items:center;align-self:flex-start;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dshch-addModel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshch-addModel:disabled{opacity:.4;cursor:default}',
      '.dshch-empty{margin:0;padding:12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);text-align:center}',
      '.dshch-discovery{display:flex;flex-direction:column;gap:8px;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}',
      '.dshch-candidates{display:flex;flex-direction:column;max-height:220px;overflow:auto;margin:0;padding:0;list-style:none}',
      '.dshch-candidate{padding:0 4px;border-radius:var(--dsw-radius-sm)}',
      '.dshch-candidate:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshch-candidate .dshch-choice{min-height:28px;width:100%}',
      '.dshch-footer{display:flex;align-items:center;gap:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dshch-status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshch-actions{display:flex;align-items:center;gap:8px;margin-left:auto}',
      '.dshch-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.dshch-notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label)}',
      '.dshch-problems{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.dshch-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:none;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dshch-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.dshch-button:disabled{opacity:.4;cursor:default}',
      '.dshch-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.dshch-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dshch-button:focus-visible,.dshch-linkButton:focus-visible,.dshch-iconButton:focus-visible,.dshch-addModel:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}',
      '@media (max-width:720px){.dshch-headerValue{grid-template-columns:minmax(0,1fr)}}',
      '@media (max-width:560px){.dshch-grid,.dshch-modelAdvanced{grid-template-columns:minmax(0,1fr)}}',
    ].join('')

    /** A 12px chevron, drawn inline so the page needs no icon package. */
    function IconChevron (props) {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 12 12',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', {
        d: props.open ? 'M3 4.5L6 7.5L9 4.5' : 'M4.5 3L7.5 6L4.5 9',
        stroke: 'currentColor',
        strokeWidth: '1.5',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /** A 14px trash outline, drawn inline. */
    function IconTrash () {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', {
        d: 'M5.5 2.5h5M2.5 4.5h11M4 4.5l.6 8.5h6.8L12 4.5M6.5 7v4M9.5 7v4',
        stroke: 'currentColor',
        strokeWidth: '1.2',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /** A 14px eye outline; `off` adds the reveal-off stroke. */
    function IconEye (props) {
      const contour = 'M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z'
      const pupil = 'M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z'
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', { d: contour }), h('path', { d: props.off === true ? 'M2.5 2.5L13.5 13.5' : pupil }))
    }

    /**
     * One labeled text, secret, or select control.
     *
     * The secret variant mirrors the built-in provider page: a password field
     * that reveals only on request, so a stored key never sits on screen unless
     * the reader asks for it.
     */
    function Field (props) {
      const id = React.useId()
      const [revealed, setRevealed] = React.useState(false)
      const secret = props.secret === true
      const input = h('input', {
        id,
        className: 'dshch-input',
        type: secret && !revealed ? 'password' : 'text',
        autoComplete: secret ? 'new-password' : undefined,
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled,
        readOnly: props.readOnly === true,
        spellCheck: false,
        'aria-label': props.ariaLabel,
        onChange: (event) => { props.onChange(event.target.value) },
      })
      const control = props.options !== undefined
        ? h('select', {
            id,
            className: 'dshch-select',
            value: props.value,
            disabled: props.disabled,
            'aria-label': props.ariaLabel,
            onChange: (event) => { props.onChange(event.target.value) },
          }, props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
        : secret
          ? h('div', { className: 'dshch-keyInput' },
              input,
              props.value === '' ? null : h('button', {
                type: 'button',
                className: 'dshch-keyToggle',
                'aria-label': revealed ? props.hideLabel : props.showLabel,
                'aria-pressed': revealed,
                title: revealed ? props.hideLabel : props.showLabel,
                disabled: props.disabled,
                onClick: () => { setRevealed((current) => !current) },
              }, h(IconEye, { off: revealed })))
          : input
      return h('div', { className: 'dshch-field' },
        h('label', { className: 'dshch-label', htmlFor: id }, props.label),
        control,
        props.hint === undefined ? null : h('p', { className: 'dshch-hint' }, props.hint))
    }

    /** Header name/value rows for one route. */
    function HeaderRows (props) {
      const rows = props.rows
      const edit = (index, field, value) => {
        props.onChange(rows.map((row, position) => position === index ? { ...row, [field]: value } : row))
      }
      /**
       * Rename a row. Naming a blank row `User-Agent` fills the latest Claude
       * Code identity, which is the default this page offers; renaming a row
       * that already has a value never overwrites it, and any other name leaves
       * the value alone.
       * @param index - row position.
       * @param value - the new header name.
       */
      const editKey = (index, value) => {
        const row = rows[index]
        const next = isUserAgentHeader(value) && row.value.trim() === ''
          ? { key: value, value: defaultUserAgentValue() }
          : { ...row, key: value }
        props.onChange(rows.map((current, position) => position === index ? next : current))
      }
      /**
       * Preset picker shown beside a User-Agent value. It reflects the matching
       * preset, or the configured value when no preset matches, and writes only
       * when an actual preset is picked.
       * @param row - the header row as the page edits it.
       * @param index - row position, used for the accessible label.
       * @returns the select control.
       */
      const presetPicker = (row, index) => {
        const preset = USER_AGENT_PRESETS.find((candidate) => candidate.value === row.value)
        const selected = preset !== undefined ? preset.id : row.value.trim() === '' ? '' : CURRENT_UA_OPTION
        return h('select', {
          className: 'dshch-select dshch-uaPreset',
          value: selected,
          disabled: props.disabled,
          'aria-label': `${props.presetLabel} ${String(index + 1)}`,
          title: props.presetHint,
          onChange: (event) => {
            const chosen = USER_AGENT_PRESETS.find((candidate) => candidate.id === event.target.value)
            if (chosen === undefined) return
            rememberUserAgentPreset(chosen.id)
            edit(index, 'value', chosen.value)
          },
        },
        h('option', { key: 'placeholder', value: '', disabled: row.value.trim() !== '' }, props.presetPlaceholder),
        ...USER_AGENT_PRESETS.map((candidate) => h('option', { key: candidate.id, value: candidate.id }, props.t(candidate.labelKey))),
        selected === CURRENT_UA_OPTION
          ? h('option', { key: 'current', value: CURRENT_UA_OPTION }, `${currentUserAgentLabel(row, props)}: ${row.value}`)
          : null)
      }
      /** The editable value control; a User-Agent row places the preset picker beside it. */
      const valueInput = (row, index) => h('input', {
        className: 'dshch-input',
        type: 'text',
        value: row.value,
        disabled: props.disabled,
        spellCheck: false,
        'aria-label': props.valueLabel,
        placeholder: props.valueLabel,
        onChange: (event) => { edit(index, 'value', event.target.value) },
      })
      const rowNodes = rows.map((row, index) => h('div', { className: 'dshch-headerRow', key: index },
        h('input', {
          className: 'dshch-input',
          type: 'text',
          value: row.key,
          disabled: props.disabled,
          spellCheck: false,
          'aria-label': props.nameLabel,
          placeholder: 'User-Agent',
          onChange: (event) => { editKey(index, event.target.value) },
        }),
        isUserAgentHeader(row.key)
          ? h('div', { className: 'dshch-headerValue' }, presetPicker(row, index), valueInput(row, index))
          : valueInput(row, index),
        h('button', {
          type: 'button',
          className: 'dshch-iconButton dshch-iconDanger',
          'aria-label': `${props.removeLabel} ${String(index + 1)}`,
          title: props.removeLabel,
          disabled: props.disabled,
          onClick: () => { props.onChange(rows.filter((_, position) => position !== index)) },
        }, h(IconTrash))))
      return h('section', { className: 'dshch-section' },
        h('div', { className: 'dshch-sectionHead' },
          h('h3', { className: 'dshch-sectionTitle' }, props.label),
          h('span', { className: 'dshch-meta' }, String(rows.length)),
          h('div', { className: 'dshch-headActions' },
            h('button', {
              type: 'button',
              className: 'dshch-linkButton',
              disabled: props.disabled,
              onClick: () => { props.onChange([...rows, { key: '', value: '' }]) },
            }, props.addLabel))),
        rows.length === 0
          ? h('p', { className: 'dshch-hint' }, props.emptyLabel)
          : h('div', { className: 'dshch-stack' }, rowNodes),
        rows.length > 0 && props.hint !== undefined ? h('p', { className: 'dshch-hint' }, props.hint) : null)
    }

    /** Text and image checkboxes for one model; the set is never empty. */
    function ModelInputTypes (props) {
      const { t, input, disabled, position } = props
      return h('fieldset', { className: 'dshch-inputTypes', 'aria-label': `${t('modelInputTypes')} ${String(position)}` },
        h('legend', { className: 'dshch-label' }, t('modelInputTypes')),
        h('div', { className: 'dshch-choices' }, MODALITIES.map((modality) => {
          const checked = input.includes(modality)
          return h('label', { className: 'dshch-choice', key: modality },
            h('input', {
              type: 'checkbox',
              checked,
              disabled: disabled || (checked && input.length === 1),
              onChange: (event) => {
                const next = MODALITIES.filter((candidate) => candidate === modality ? event.target.checked : input.includes(candidate))
                props.onChange(next.length === 0 ? ['text'] : next)
              },
            }),
            h('span', null, modality === 'text' ? t('modelInputText') : t('modelInputImage')))
        })))
    }

    /** The reasoning levels one model offers, behind a switch. */
    function ReasoningEditor (props) {
      const { t, levels, disabled, position } = props
      const on = levels !== null
      const used = on ? levels.map((entry) => entry.level) : []
      const write = (next) => { props.onChange(next) }
      const replaceAt = (index, entry) => levels.map((current, at) => at === index ? entry : current)
      const defaultValue = (level) => level === 'off' ? '' : level
      const addLevel = () => {
        const highest = Math.max(-1, ...used.map((level) => THINKING_LEVELS.indexOf(level)))
        const level = THINKING_LEVELS.find((candidate, index) => index > highest && !used.includes(candidate)) ??
          THINKING_LEVELS.find((candidate) => !used.includes(candidate))
        if (level === undefined) return
        write([...levels, { level, value: defaultValue(level) }])
      }
      return h('div', { className: 'dshch-reasoning', role: 'group', 'aria-label': `${t('modelReasoning')} ${String(position)}` },
        h('div', { className: 'dshch-reasoningHead' },
          h('span', { className: 'dshch-label' }, t('modelReasoning')),
          h('label', { className: 'dshch-switch' },
            h('input', {
              type: 'checkbox',
              checked: on,
              disabled,
              onChange: (event) => {
                write(event.target.checked
                  ? INITIAL_LEVELS.filter((level) => THINKING_LEVELS.includes(level)).map((level) => ({ level, value: defaultValue(level) }))
                  : null)
              },
            }),
            h('span', null, on ? t('switchOn') : t('switchOff')))),
        on
          ? levels.map((entry, index) => {
              const choices = [...THINKING_LEVELS.includes(entry.level) ? [] : [entry.level], ...THINKING_LEVELS.filter((level) => level === entry.level || !used.includes(level))]
              return h('div', { className: 'dshch-reasoningRow', key: `${entry.level}:${index}` },
                h('select', {
                  className: 'dshch-select',
                  value: entry.level,
                  'aria-label': `${t('modelReasoningLevel')} ${String(index + 1)}`,
                  disabled,
                  onChange: (event) => {
                    const to = event.target.value
                    const keep = entry.value !== '' && entry.value !== entry.level && entry.level !== 'off' && to !== 'off'
                    write(replaceAt(index, { level: to, value: keep ? entry.value : defaultValue(to) }))
                  },
                }, choices.map((level) => h('option', { key: level, value: level }, level))),
                h('input', {
                  className: 'dshch-input',
                  type: 'text',
                  value: entry.value,
                  placeholder: entry.level === 'off' ? t('modelReasoningOffValuePlaceholder') : entry.level,
                  'aria-label': `${entry.level} ${t('modelReasoningValue')}`,
                  'aria-invalid': entry.level !== 'off' && entry.value.trim() === '' ? 'true' : undefined,
                  disabled: disabled || entry.level === 'off',
                  spellCheck: false,
                  onChange: (event) => { write(replaceAt(index, { level: entry.level, value: event.target.value })) },
                }),
                h('button', {
                  type: 'button',
                  className: 'dshch-iconButton dshch-iconDanger',
                  'aria-label': `${t('modelReasoningRemove')} ${entry.level}`,
                  title: t('modelReasoningRemove'),
                  disabled,
                  onClick: () => { write(levels.filter((_, at) => at !== index)) },
                }, h(IconTrash)))
            })
          : null,
        on
          ? h('div', null, h('button', {
              type: 'button',
              className: 'dshch-addModel',
              disabled: disabled || used.length >= THINKING_LEVELS.length,
              onClick: addLevel,
            }, t('modelReasoningAdd')))
          : null)
    }

    /**
     * One model of a route: identity, capacities, input types and reasoning levels.
     *
     * The detail starts folded — a directory of identifiers is what this page is
     * for, and three expanded models bury the section they belong to. A row that
     * holds something the page would refuse to save (an unreadable capacity, a
     * reasoning level without its value) opens itself, so a blocked save never
     * points at fields the reader cannot see.
     */
    function ModelRow (props) {
      const { t, row, position, disabled } = props
      const [expanded, setExpanded] = React.useState(false)
      const open = expanded || props.needsAttention === true
      const edit = (patch) => { props.onChange({ ...row, ...patch }) }
      return h('article', { className: 'dshch-model', 'data-model': row.id },
        h('div', { className: 'dshch-modelRow' },
          h('input', {
            className: 'dshch-input',
            type: 'text',
            value: row.id,
            placeholder: t('modelId'),
            'aria-label': `${t('modelId')} ${String(position)}`,
            disabled,
            spellCheck: false,
            onChange: (event) => { edit({ id: event.target.value }) },
          }),
          h('input', {
            className: 'dshch-input',
            type: 'text',
            value: row.name,
            placeholder: t('modelNamePlaceholder'),
            'aria-label': `${t('modelName')} ${String(position)}`,
            disabled,
            spellCheck: false,
            onChange: (event) => { edit({ name: event.target.value }) },
          }),
          h('button', {
            type: 'button',
            className: 'dshch-iconButton',
            'aria-label': `${t('modelAdvanced')} ${String(position)}`,
            'aria-expanded': open,
            title: t('modelAdvanced'),
            disabled,
            onClick: () => { setExpanded((current) => !current) },
          }, h(IconChevron, { open })),
          h('button', {
            type: 'button',
            className: 'dshch-iconButton dshch-iconDanger',
            'aria-label': `${t('removeModel')} ${String(position)}`,
            title: t('removeModel'),
            disabled,
            onClick: props.onRemove,
          }, h(IconTrash))),
        open
          ? h('div', { className: 'dshch-modelAdvanced' },
              h('label', { className: 'dshch-field' },
                h('span', { className: 'dshch-label' }, t('contextWindow')),
                h('input', {
                  className: 'dshch-input',
                  type: 'text',
                  inputMode: 'numeric',
                  value: row.contextWindow,
                  placeholder: t('contextWindowPlaceholder'),
                  'aria-label': `${t('contextWindow')} ${String(position)}`,
                  'aria-invalid': typeof parseCapacity(row.contextWindow) === 'number' && !(parseCapacity(row.contextWindow) > 0) ? 'true' : undefined,
                  disabled,
                  spellCheck: false,
                  onChange: (event) => { edit({ contextWindow: event.target.value }) },
                })),
              h('label', { className: 'dshch-field' },
                h('span', { className: 'dshch-label' }, t('maxTokens')),
                h('input', {
                  className: 'dshch-input',
                  type: 'text',
                  inputMode: 'numeric',
                  value: row.maxTokens,
                  placeholder: t('maxTokensPlaceholder'),
                  'aria-label': `${t('maxTokens')} ${String(position)}`,
                  'aria-invalid': typeof parseCapacity(row.maxTokens) === 'number' && !(parseCapacity(row.maxTokens) > 0) ? 'true' : undefined,
                  disabled,
                  spellCheck: false,
                  onChange: (event) => { edit({ maxTokens: event.target.value }) },
                })),
              h(ModelInputTypes, {
                t,
                position,
                input: row.input,
                disabled,
                onChange: (input) => { edit({ input }) },
              }),
              h(ReasoningEditor, {
                t,
                position,
                levels: row.reasoningEfforts,
                disabled,
                onChange: (levels) => { edit({ reasoningEfforts: levels }) },
              }))
          : null)
    }

    /** One discovered model as an editable row. */
    function candidateRow (candidate) {
      const modalities = Array.isArray(candidate.inputModalities) ? candidate.inputModalities : []
      return {
        id: candidate.id,
        name: typeof candidate.name === 'string' ? candidate.name : '',
        contextWindow: formatCapacity(candidate.contextWindow),
        maxTokens: formatCapacity(candidate.maxTokens),
        input: modalities.includes('image') ? ['text', 'image'] : ['text'],
        reasoningEfforts: null,
      }
    }

    /** The model directory of one route, with fetch and reset. */
    function ModelsEditor (props) {
      const { t, rows, disabled, defaults, inherited, canFetch, discover } = props
      const [panel, setPanel] = React.useState(null)
      const [picked, setPicked] = React.useState([])
      const [query, setQuery] = React.useState('')
      const busy = panel !== null && panel.status === 'busy'
      // A route the configuration base does not describe has no default to
      // restore, so the action stays hidden rather than emptying the directory.
      const resettable = Array.isArray(defaults) && defaults.length > 0 ? defaults : null

      const fetchModels = async () => {
        setPicked([])
        setQuery('')
        setPanel({ status: 'busy' })
        try {
          const result = await discover()
          if (result.kind === 'found') setPanel({ status: 'ready', candidates: result.models })
          else setPanel({ status: 'failed', message: result.message })
        } catch (error) {
          setPanel({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
        }
      }

      const closePanel = () => {
        setPanel(null)
        setPicked([])
        setQuery('')
      }

      const adopt = () => {
        const known = new Set(rows.map((row) => row.id.trim()).filter((id) => id !== ''))
        const additions = panel.candidates
          .filter((candidate) => picked.includes(candidate.id) && !known.has(candidate.id))
          .map(candidateRow)
        if (additions.length > 0) props.onChange([...rows, ...additions])
        closePanel()
      }

      const candidates = panel !== null && panel.status === 'ready' ? panel.candidates : []
      const normalized = query.trim().toLowerCase()
      const visible = normalized === ''
        ? candidates
        : candidates.filter((candidate) => candidate.id.toLowerCase().includes(normalized) ||
            (typeof candidate.name === 'string' && candidate.name.toLowerCase().includes(normalized)))
      const allPicked = visible.length > 0 && visible.every((candidate) => picked.includes(candidate.id))
      const toggleAll = () => {
        setPicked(allPicked ? [] : [...new Set([...picked, ...visible.map((candidate) => candidate.id)])])
      }

      return h('section', { className: 'dshch-section' },
        h('div', { className: 'dshch-sectionHead' },
          h('h3', { className: 'dshch-sectionTitle' }, t('models')),
          h('span', { className: 'dshch-meta' }, inherited ? t('modelsInherited') : t('modelsCustomized')),
          h('div', { className: 'dshch-headActions' },
            resettable === null
              ? null
              : h('button', {
                  type: 'button',
                  className: 'dshch-linkButton',
                  disabled: disabled || busy || sameModels(rows, resettable),
                  onClick: () => { props.onChange(cloneModelRows(resettable)) },
                }, t('resetModels')),
            h('button', {
              type: 'button',
              className: 'dshch-linkButton',
              disabled: disabled || busy || !canFetch,
              title: canFetch ? undefined : t('fetchNeedsBaseUrl'),
              onClick: () => { void fetchModels() },
            }, busy ? t('fetching') : t('fetchModels')))),
        panel !== null && panel.status === 'failed'
          ? h('p', { className: 'dshch-error', role: 'alert' }, panel.message)
          : null,
        panel !== null && panel.status === 'ready'
          ? h('div', { className: 'dshch-discovery' },
              h('div', { className: 'dshch-field' },
                h('span', { className: 'dshch-sectionTitle' }, t('fetchTitle')),
                h('p', { className: 'dshch-hint' }, t('fetchDescription'))),
              candidates.length === 0
                ? h('p', { className: 'dshch-hint' }, t('fetchEmpty'))
                : h('div', { className: 'dshch-field' },
                    h('input', {
                      className: 'dshch-input',
                      type: 'text',
                      value: query,
                      placeholder: t('fetchSearch'),
                      'aria-label': t('fetchSearch'),
                      spellCheck: false,
                      onChange: (event) => { setQuery(event.target.value) },
                    }),
                    h('div', { className: 'dshch-sectionHead' },
                      h('span', { className: 'dshch-meta' }, String(candidates.length)),
                      h('div', { className: 'dshch-headActions' },
                        h('button', { type: 'button', className: 'dshch-linkButton', onClick: toggleAll }, allPicked ? t('fetchDeselectAll') : t('fetchSelectAll')))),
                    visible.length === 0
                      ? h('p', { className: 'dshch-hint' }, t('fetchNoMatches'))
                      : h('ul', { className: 'dshch-candidates' }, visible.map((candidate) => h('li', { className: 'dshch-candidate', key: candidate.id },
                          h('label', { className: 'dshch-choice' },
                            h('input', {
                              type: 'checkbox',
                              checked: picked.includes(candidate.id),
                              onChange: () => {
                                setPicked((current) => current.includes(candidate.id)
                                  ? current.filter((id) => id !== candidate.id)
                                  : [...current, candidate.id])
                              },
                            }),
                            h('code', { className: 'dshch-id' }, candidate.id),
                            typeof candidate.name === 'string' && candidate.name !== '' && candidate.name !== candidate.id
                              ? h('span', { className: 'dshch-hint' }, candidate.name)
                              : null))))),
              h('div', { className: 'dshch-footer' },
                h('div', { className: 'dshch-actions' },
                  h('button', { type: 'button', className: 'dshch-button', onClick: closePanel }, t('cancel')),
                  h('button', {
                    type: 'button',
                    className: 'dshch-button dshch-primary',
                    disabled: picked.length === 0,
                    onClick: adopt,
                  }, t('fetchAdopt')))))
          : null,
        rows.length === 0
          ? h('p', { className: 'dshch-empty' }, t('modelsRequired', { provider: props.provider }))
          : h('div', { className: 'dshch-stack' }, rows.map((row, index) => h(ModelRow, {
              key: `${String(index)}:${row.id}`,
              t,
              row,
              position: index + 1,
              disabled,
              needsAttention: modelNeedsAttention(row),
              onChange: (next) => { props.onChange(rows.map((current, at) => at === index ? next : current)) },
              onRemove: () => { props.onChange(rows.filter((_, at) => at !== index)) },
            }))),
        h('button', {
          type: 'button',
          className: 'dshch-addModel',
          disabled,
          onClick: () => { props.onChange([...rows, { id: '', name: '', contextWindow: '', maxTokens: '', input: ['text'], reasoningEfforts: null }]) },
        }, t('addModel')))
    }

    /** One configured route. */
    function RouteCard (props) {
      const { t, name, entry, disabled, onChange, onRemove } = props
      const overridesUserAgent = entry.headers.some((row) => row.key.trim().toLowerCase() === 'user-agent')
      const remove = (event) => {
        event?.preventDefault?.()
        event?.stopPropagation?.()
        if (typeof onRemove === 'function') onRemove()
        else console.warn(`dsh-plugin-custom-headers: no remove handler for route "${name}".`)
      }
      return h('article', { className: 'dshch-card', 'data-provider': name },
        h('div', { className: 'dshch-cardHead' },
          // The route id is the single identity: the card title and the
          // read-only Display name field both show it, and the protocol is
          // visible in its own field below. The warning marks the one header
          // this plugin may override.
          h('h4', { className: 'dshch-route', title: name }, name),
          h('div', { className: 'dshch-cardHeadActions' },
            overridesUserAgent ? h('span', { className: 'dshch-warn' }, t('uaOverride')) : null,
            h('button', {
              type: 'button',
              className: 'dshch-iconButton dshch-iconDanger',
              'aria-label': `${t('removeProvider')} ${name}`,
              title: t('removeProvider'),
              disabled: props.canRemove === false,
              onPointerDown: (event) => {
                if (event.button === 0) remove(event)
              },
              onClick: remove,
            }, h(IconTrash)))),
        h('div', { className: 'dshch-grid' },
          h(Field, {
            label: t('displayName'),
            ariaLabel: t('displayName'),
            value: name,
            disabled,
            readOnly: true,
            onChange: () => {},
          }),
          h(Field, {
            label: t('api'),
            value: entry.api,
            disabled,
            options: PROTOCOLS.map((protocol) => ({ value: protocol, label: PROTOCOL_LABELS[protocol] ?? protocol })),
            onChange: (value) => { onChange({ ...entry, api: value }) },
          }),
          h(Field, {
            label: t('baseURL'),
            placeholder: 'https://api.example.com/v1',
            value: entry.baseURL,
            disabled,
            onChange: (value) => { onChange({ ...entry, baseURL: value }) },
          }),
          // The stored reference is not shown: the field takes the key itself
          // and the reference follows from the route name (see keyRefOf). The
          // value only travels through the credential seam, never the profile.
          h(Field, {
            label: t('apiKey'),
            secret: true,
            placeholder: props.keyPlaceholder,
            showLabel: t('keyReveal'),
            hideLabel: t('keyHide'),
            value: props.keyValue,
            disabled: disabled || props.keyUnavailable === true,
            onChange: props.onKeyChange,
          })),
        h(HeaderRows, {
          t,
          label: t('headers'),
          nameLabel: t('headerName'),
          valueLabel: t('headerValue'),
          addLabel: t('addHeader'),
          removeLabel: t('removeHeader'),
          emptyLabel: t('headersEmpty'),
          presetLabel: t('uaPreset'),
          presetPlaceholder: t('uaPresetPlaceholder'),
          presetCurrent: t('uaPresetCurrent'),
          presetClaudeCurrent: t('uaPresetClaudeCurrent'),
          presetCodexCurrent: t('uaPresetCodexCurrent'),
          presetHint: t('uaPresetHint'),
          rows: entry.headers,
          disabled,
          onChange: (rows) => { onChange({ ...entry, headers: rows }) },
        }),
        h(ModelsEditor, {
          t,
          provider: name,
          rows: entry.models,
          disabled,
          defaults: props.defaultModels === undefined || props.defaultModels === null ? null : props.defaultModels,
          inherited: props.inherited !== false,
          canFetch: props.isConfigured !== false && entry.baseURL.trim() !== '',
          discover: () => props.discover(name),
          onChange: (rows) => { onChange({ ...entry, models: rows }) },
        }))
    }

    /** The settings page: staged edits over the configured routes. */
    function RoutePage (props) {
      const { t, snapshot, configured, mutate, intro } = props
      const [draft, setDraft] = React.useState(null)
      const [editRevision, setEditRevision] = React.useState(snapshot.revision)
      const [saving, setSaving] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [saved, setSaved] = React.useState(false)
      const [cleanupFailure, setCleanupFailure] = React.useState(null)
      // Typed keys live outside the route draft: they are write-only values for
      // the credential store, never part of the profile the draft is a view of.
      const [keys, setKeys] = React.useState({})
      const [stored, setStored] = React.useState(null)
      const [newProviderId, setNewProviderId] = React.useState('')
      const [newProviderApi, setNewProviderApi] = React.useState(PROTOCOLS[1])
      const [addProblem, setAddProblem] = React.useState(null)
      const [adding, setAdding] = React.useState(false)

      const writable = snapshot.writable === true
      const value = draft ?? configured
      const routes = Object.keys(value)
      // Routes the inherited layer (the bundle patch) also declares cannot be
      // deleted with `unset`: the Host turns that into "restore the inherited
      // value". Deletions of those routes become a whole-dictionary write, which
      // needs the raw entries to carry non-page tuning fields forward.
      const mutationContext = React.useMemo(() => ({
        inheritedProviders: new Set(Object.keys(snapshot.base?.providers ?? {})),
        rawProviders: snapshot.value?.providers ?? {},
      }), [snapshot.base, snapshot.value])
      const problems = draft === null ? [] : validateDraft(draft, t)
      const keyEdits = routes
        .map((name) => ({
          name,
          ref: keyRefOf(name, value[name].apiKeyEnv),
          value: String(keys[name] ?? '').trim(),
        }))
        .filter((edit) => edit.value !== '')
      const dirty = keyEdits.length > 0 || (draft !== null && mutationsOf(draft, configured, mutationContext).length > 0)
      const secrets = props.credentials
      const keyUnavailable = secrets === null || secrets === undefined || secrets.available !== true
      /** The credential states of every route's reference, read from the Host. */
      const referenceSignature = routes.map((name) => keyRefOf(name, value[name].apiKeyEnv)).join('|')
      const refreshStored = async () => {
        if (keyUnavailable) return
        const described = await secrets.describe(routes.map((name) => keyRefOf(name, value[name].apiKeyEnv)))
        if (described !== null) setStored(described)
      }
      React.useEffect(() => {
        void refreshStored()
      }, [referenceSignature, keyUnavailable])

      const beginEditing = () => {
        if (draft !== null) return draft
        setEditRevision(snapshot.revision)
        const next = cloneDraft(configured)
        setDraft(next)
        return next
      }

      const editRoute = (name, next) => {
        const base = beginEditing()
        setSaved(false)
        setFailure(null)
        setCleanupFailure(null)
        setDraft({ ...base, [name]: next })
      }

      /** Add a complete provider panel and leave its fields ready to edit. */
      const addRoute = () => {
        const id = newProviderId.trim()
        if (id === '') {
          setAddProblem(t('providerIdRequired'))
          return
        }
        if (!PROVIDER_ID.test(id)) {
          setAddProblem(t('providerIdInvalid', { id }))
          return
        }
        const base = beginEditing()
        if (Object.prototype.hasOwnProperty.call(base, id)) {
          setAddProblem(t('providerIdDuplicate', { id }))
          return
        }
        setSaved(false)
        setFailure(null)
        setCleanupFailure(null)
        setAddProblem(null)
        setNewProviderId('')
        setAdding(false)
        setDraft({
          ...base,
          [id]: {
            displayName: id,
            api: newProviderApi,
            baseURL: '',
            apiKeyEnv: '',
            headers: [{ key: 'User-Agent', value: defaultUserAgentValue() }],
            models: [{ id: '', name: '', contextWindow: '', maxTokens: '', input: ['text'], reasoningEfforts: null }],
          },
        })
      }

      /** Close the add-provider form and forget its half-typed identity. */
      const cancelAdd = () => {
        setAdding(false)
        setNewProviderId('')
        setNewProviderApi(PROTOCOLS[1])
        setAddProblem(null)
      }

      /**
       * Remove one provider panel from the draft. The save diff removes the
       * route while retaining credentials that may be shared outside this plugin;
       * discarding restores the panel without touching either.
       * @param name - the provider route to remove.
       */
      const removeRoute = (name) => {
        const base = beginEditing()
        const next = { ...base }
        delete next[name]
        setKeys((current) => {
          const copy = { ...current }
          delete copy[name]
          return copy
        })
        setSaved(false)
        setFailure(null)
        setCleanupFailure(null)
        setDraft(next)
      }

      /**
       * Stage a typed key. A route that names no credential reference yet gets
       * the conventional one written into the draft, so the save that stores the
       * key also tells the route where to read it from.
       * @param name - the route the key belongs to.
       * @param typed - the key as typed; blank means "leave the stored one alone".
       */
      const editKey = (name, typed) => {
        setSaved(false)
        setFailure(null)
        setCleanupFailure(null)
        setKeys((current) => ({ ...current, [name]: typed }))
        if (typed.trim() === '') return
        beginEditing()
        const entry = (draft ?? configured)[name]
        const ref = keyRefOf(name, entry.apiKeyEnv)
        if (ref !== entry.apiKeyEnv) editRoute(name, { ...entry, apiKeyEnv: ref })
      }

      const save = async () => {
        if (saving || (draft === null && keyEdits.length === 0) || problems.length > 0 || !writable) return
        const operations = draft === null ? [] : mutationsOf(draft, configured, { ...mutationContext, normalizeDisplayName: true })
        const expectedRevision = draft === null ? snapshot.revision : editRevision
        const assertCurrent = () => {
          const latest = props.getSnapshot?.() ?? snapshot
          if (latest.revision !== expectedRevision) throw new Error(t('saveConflict'))
        }
        const completed = []
        const reportFailure = (message) => setFailure(completed.length === 0 ? message : `${message} ${t('keysPartiallySaved', { refs: completed.join(', ') })}`)
        setSaving(true)
        setFailure(null)
        setCleanupFailure(null)
        try {
          assertCurrent()
          // Keys first: a stored key nothing references is harmless, while a
          // route pointed at a reference with no key behind it cannot call out.
          for (const edit of keyEdits) {
            assertCurrent()
            const message = await secrets.set(edit.ref, edit.value)
            if (message !== undefined) {
              reportFailure(t('apiKeyRejected', { message }))
              return
            }
            completed.push(edit.ref)
            setKeys((current) => {
              if (String(current[edit.name] ?? '').trim() !== edit.value) return current
              const next = { ...current }; delete next[edit.name]; return next
            })
          }
          assertCurrent()
          const accepted = operations.length === 0 ? true : await mutate(operations)
          if (!accepted) {
            reportFailure(t('saveFailed'))
            return
          }
          setKeys({})
          setDraft(null)
          setSaved(true)
          if (draft !== null && Object.keys(configured).some((name) => !Object.prototype.hasOwnProperty.call(draft, name))) setCleanupFailure(t('credentialsRetained'))
          await refreshStored()
        } catch (error) {
          reportFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setSaving(false)
        }
      }

      const discard = () => {
        setDraft(null)
        setKeys({})
        setFailure(null)
        setCleanupFailure(null)
        setSaved(false)
      }

      if (snapshot.status === 'loading') {
        return h('div', { className: 'dshch' }, h('style', null, CSS), intro ?? null, h('p', { className: 'dshch-note' }, t('loading')))
      }
      if (snapshot.status === 'unavailable') {
        return h('div', { className: 'dshch' }, h('style', null, CSS), intro ?? null, h('p', { className: 'dshch-note' }, t('unavailable')))
      }
      return h('div', { className: 'dshch', 'data-custom-headers-page': '' },
        h('style', null, CSS),
        intro ?? null,
        // Page heading and description come from SettingsSection's `intro`; the
        // settings shell contributes only the nav entry and content column.
        writable ? null : h('p', { className: 'dshch-note' }, t('readOnly')),
        routes.length === 0
          ? h('p', { className: 'dshch-hint' }, t('providersEmpty'))
          : h('div', { className: 'dshch-cards' }, routes.map((name) => h(RouteCard, {
            key: name,
            t,
            name,
            entry: value[name],
            disabled: !writable || saving,
            canRemove: writable,
            keyValue: String(keys[name] ?? ''),
            keyUnavailable,
            keyPlaceholder: keyUnavailable
              ? t('apiKeyUnavailable')
              : stored !== null && stored[keyRefOf(name, value[name].apiKeyEnv)]?.configured === true
                ? t('apiKeyConfigured')
                : t('apiKeyPlaceholder'),
            onKeyChange: (typed) => { editKey(name, typed) },
            defaultModels: props.defaults[name] === undefined ? null : props.defaults[name].models,
            inherited: Object.prototype.hasOwnProperty.call(configured, name) ? !props.customized.has(name) : false,
            isConfigured: Object.prototype.hasOwnProperty.call(configured, name),
            discover: props.discover,
            onChange: (next) => { editRoute(name, next) },
            onRemove: () => { removeRoute(name) },
          }))),
        writable
          ? adding
            ? h('section', { className: 'dshch-addRoute' },
              h('div', { className: 'dshch-addRouteHead' },
                h('h3', { className: 'dshch-sectionTitle' }, t('addProvider')),
                h('span', { className: 'dshch-hint' }, t('addProviderHint'))),
              h('div', { className: 'dshch-grid' },
                h(Field, {
                  label: t('providerId'),
                  ariaLabel: t('providerId'),
                  placeholder: t('providerIdPlaceholder'),
                  value: newProviderId,
                  disabled: saving,
                  onChange: (value) => {
                    setNewProviderId(value)
                    setAddProblem(null)
                    setSaved(false)
                  },
                }),
                h(Field, {
                  label: t('api'),
                  ariaLabel: t('api'),
                  value: newProviderApi,
                  disabled: saving,
                  options: PROTOCOLS.map((protocol) => ({ value: protocol, label: PROTOCOL_LABELS[protocol] ?? protocol })),
                  onChange: (value) => { setNewProviderApi(value) },
                })),
              h('div', { className: 'dshch-addActions' },
                h('button', {
                  type: 'button',
                  className: 'dshch-button',
                  disabled: saving,
                  onClick: cancelAdd,
                }, t('cancel')),
                h('button', {
                  type: 'button',
                  className: 'dshch-button dshch-primary',
                  disabled: saving,
                  onClick: addRoute,
                }, t('addProvider'))),
              addProblem === null ? null : h('p', { className: 'dshch-error', role: 'alert' }, addProblem))
            : h('button', {
              type: 'button',
              className: 'dshch-addToggle',
              disabled: saving,
              onClick: () => {
                setAdding(true)
                setAddProblem(null)
                setSaved(false)
              },
            }, `+ ${t('addProvider')}`)
          : null,
        problems.length > 0 ? h('ul', { className: 'dshch-problems' }, problems.map((problem, index) => h('li', { key: index }, problem))) : null,
        failure === null ? null : h('p', { className: 'dshch-error', role: 'alert' }, failure),
        cleanupFailure === null ? null : h('p', { className: 'dshch-notice', role: 'status' }, cleanupFailure),
        h('div', { className: 'dshch-footer' },
          h('p', { className: 'dshch-status' }, saved ? t('saved') : dirty ? t('dirty') : t('pristine')),
          h('div', { className: 'dshch-actions' },
            h('button', {
              type: 'button',
              className: 'dshch-button',
              disabled: saving || (draft === null && keyEdits.length === 0),
              onClick: discard,
            }, t('discard')),
            h('button', {
              type: 'button',
              className: 'dshch-button dshch-primary',
              disabled: !writable || saving || !dirty || problems.length > 0,
              onClick: () => { void save() },
            }, saving ? t('saving') : t('save')))))
    }

    /** The route editor body shared by the Settings page. */
    function HeaderRoutesCard (props) {
      const { t } = props
      const snapshot = props.useForm((value) => value)
      const providers = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value.providers : undefined
      const configured = React.useMemo(() => toDraft(providers), [providers])
      const baseProviders = snapshot.base !== null && typeof snapshot.base === 'object' ? snapshot.base.providers : undefined
      const userProviders = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user.providers : undefined
      const defaults = React.useMemo(() => toDraft(baseProviders), [baseProviders])
      const customized = React.useMemo(() => {
        const names = new Set()
        for (const [name, entry] of Object.entries(userProviders ?? {})) {
          if (entry !== null && typeof entry === 'object' && Array.isArray(entry.models)) names.add(name)
        }
        return names
      }, [userProviders])
      return h(RoutePage, {
        t,
        snapshot,
        configured,
        defaults,
        customized,
        discover: props.discover,
        credentials: props.credentials,
        getSnapshot: props.getSnapshot,
        mutate: props.mutate,
        intro: props.intro,
      })
    }

    /** The one-line route/model/header summary the old row page showed as its description. */
    function summaryLine (configured, t) {
      const routes = Object.values(configured)
      const models = routes.reduce((total, entry) => total + entry.models.length, 0)
      const headers = [...new Set(routes.flatMap((entry) => entry.headers.map((row) => row.key.trim()).filter((name) => name !== '')))]
      return t('summary', {
        providers: routes.length,
        models,
        headers: headers.length === 0 ? t('none') : headers.join(', '),
      })
    }

    /**
     * Settings → section page. The Settings shell contributes only the nav entry
     * and its content column, so this wrapper adds the page heading, the plugin
     * description and the same route/model/header summary the removed Plugins
     * row page used to show, then renders the route editor.
     * @param props - injected form face, credentials, discovery and `t`.
     * @returns the section element.
     */
    function SettingsSection (props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const snapshot = props.useForm((value) => value)
      const providers = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value.providers : undefined
      const configured = React.useMemo(() => toDraft(providers), [providers])
      return h(HeaderRoutesCard, {
        ...props,
        t,
        intro: h('div', { className: 'dshch-settingsIntro' },
          h('h2', { className: 'dshch-settingsTitle' }, t('settingsTitle')),
          h('p', { className: 'dshch-settingsLead' }, t('settingsLead')),
          h('p', { className: 'dshch-settingsSummary' }, summaryLine(configured, t))),
      })
    }

    /** Services this browser plugin needs before it can run. */
    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.llm', 'remote.credentials']

    /**
     * Mount the page while the Host serves this row's settings namespace.
     * @param ctx - the browser plugin context.
     */
    function apply (ctx) {
      // The browser half talks to host services by name. When a DSH release
      // renames one, failing here with a precise list is much easier to port
      // than a blank page or a stack trace inside the host's slot renderer.
      const missing = []
      if (typeof ctx?.effect !== 'function') missing.push('ctx.effect')
      if (typeof ctx?.slots?.register !== 'function') missing.push('slots.register')
      if (typeof ctx?.slots?.inject !== 'function') missing.push('slots.inject')
      if (typeof ctx?.locale?.register !== 'function') missing.push('locale.register')
      for (const method of ['get', 'whileServed']) {
        if (typeof ctx?.configForms?.[method] !== 'function') missing.push(`configForms.${method}`)
      }
      if (missing.length > 0) {
        console.warn(`dsh-plugin-custom-headers: this DSH release no longer provides ${missing.join(', ')}; the Settings page stays hidden. Port client.js (inject/apply) to this DSH release.`)
        return
      }
      // These only power optional features; losing them must not hide the page.
      if (typeof ctx?.configForms?.describe !== 'function') {
        console.warn('dsh-plugin-custom-headers: configForms.describe() is gone; the namespace diagnostic is disabled, but editing still works.')
      }
      if (typeof ctx?.remote?.llm?.discoverModels !== 'function') {
        console.warn('dsh-plugin-custom-headers: remote.llm.discoverModels() is gone; "fetch available models" is disabled, but editing still works.')
      }

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'CustomHeaders: dictionaries')

      let form
      try {
        form = ctx.configForms.get(ROW_ID)
      } catch (error) {
        console.warn(`dsh-plugin-custom-headers: configForms.get("${ROW_ID}") failed; the Settings page stays hidden. ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (form === undefined || form === null) {
        console.warn(`dsh-plugin-custom-headers: the host returned no settings form for row "${ROW_ID}"; the Settings page stays hidden.`)
        return
      }
      const missingFormMethods = ['getSnapshot', 'subscribe', 'mutate'].filter((method) => typeof form?.[method] !== 'function')
      if (missingFormMethods.length > 0) {
        console.warn(`dsh-plugin-custom-headers: the settings form for row "${ROW_ID}" no longer provides ${missingFormMethods.join(', ')}; the Settings page stays hidden. Port client.js to this DSH release.`)
        return
      }
      const formSource = {
        getSnapshot: () => form.getSnapshot(),
        subscribe: (listener) => form.subscribe(listener),
      }
      const face = {
        hooks: { form: formSource },
        getSnapshot: () => form.getSnapshot(),
        mutate: (operations) => form.mutate(operations),
        /**
         * Ask the Host for the models this route's endpoint advertises. The Host
         * half answers `llm/discoverModels` for this namespace, so the key stays
         * behind the credential seam and never reaches the browser.
         * @param provider - the route to interrogate.
         * @returns the candidates, or the reason the endpoint refused.
         */
        /**
         * The credential seam the key field writes through.
         *
         * Keys never touch the profile: the route records a reference and the
         * host store holds the value, so the page can store a real key without
         * a secret ever entering the settings document. Every call reports its
         * outcome instead of throwing, so a store that refuses (read-only
         * deployment, empty value) becomes a message next to the field.
         */
        credentials: {
          available: typeof ctx.remote?.credentials?.describe === 'function' && typeof ctx.remote?.credentials?.set === 'function',
          /**
           * @param refs - reference names to interrogate.
           * @returns reference to state, or null when the host cannot answer.
           */
          describe: async (refs) => {
            if (refs.length === 0) return {}
            try {
              const response = await ctx.remote.credentials.describe(refs)
              if (response === null || typeof response !== 'object' || response.ok !== true) return null
              const value = response.value
              return value !== null && typeof value === 'object' ? value : null
            } catch {
              return null
            }
          },
          /**
           * @param ref - reference to store under.
           * @param value - the key itself.
           * @returns undefined on success, otherwise the reason it was refused.
           */
          set: async (ref, value) => {
            try {
              const response = await ctx.remote.credentials.set(ref, value)
              if (response !== null && typeof response === 'object' && response.ok === true) return undefined
              const message = response?.error?.message
              return typeof message === 'string' ? message : `the credential store refused "${ref}"`
            } catch (error) {
              return error instanceof Error ? error.message : String(error)
            }
          },
          /**
           * Remove the stored value of one reference. Only the provider-managed
           * store is touched; an environment fallback for the same name stays.
           * @param ref - reference to clear.
           * @returns undefined on success, otherwise the reason it was refused.
           */
          unset: async (ref) => {
            if (typeof ctx?.remote?.credentials?.unset !== 'function') {
              return 'this DSH release cannot remove stored credentials'
            }
            try {
              const response = await ctx.remote.credentials.unset(ref)
              // A void result may arrive unwrapped on older hosts.
              if (response === undefined || response === null) return undefined
              if (typeof response === 'object' && response.ok === true) return undefined
              const message = response?.error?.message
              return typeof message === 'string' ? message : `the credential store refused to clear "${ref}"`
            } catch (error) {
              return error instanceof Error ? error.message : String(error)
            }
          },
        },
        discover: async (provider) => {
          if (typeof ctx?.remote?.llm?.discoverModels !== 'function') {
            return { kind: 'refused', message: 'this DSH release no longer provides model discovery; add models by hand' }
          }
          try {
            const response = await ctx.remote.llm.discoverModels(ROW_ID, { provider })
            if (response !== null && typeof response === 'object' && response.ok === true) {
              return { kind: 'found', models: Array.isArray(response.value) ? response.value : [] }
            }
            const message = response?.error?.message
            return { kind: 'refused', message: typeof message === 'string' ? message : `model discovery for "${provider}" failed` }
          } catch (error) {
            return { kind: 'refused', message: error instanceof Error ? error.message : String(error) }
          }
        },
      }

      // The editor is a first-class Settings section (`Settings → Custom Headers`).
      // There is deliberately no `plugins.row.config` registration any more: the
      // Plugins page keeps the row and its switch, but configuration lives only
      // under Settings. `label` is a thunk so the nav re-reads it after a locale
      // switch without re-registering.
      ctx.effect(() => ctx.configForms.whileServed([ROW_ID], () => ctx.slots.inject(SETTINGS_SECTION, () => ctx.slots.register({
        name: SETTINGS_SECTION,
        id: SETTINGS_SECTION_ID,
        order: SETTINGS_SECTION_ORDER,
        label: () => typeof ctx.locale?.bind === 'function'
          ? ctx.locale.bind(NS)('settingsSectionLabel')
          : 'Custom Headers',
        locale: NS,
        inject: () => face,
      }, SettingsSection))), 'CustomHeaders: settings section')

      // One diagnostic when the row id this page is bound to is not served:
      // otherwise a renamed row would silently lose its page. `describe` is
      // optional so a renamed diagnostic API does not hide an otherwise usable
      // page.
      if (typeof ctx?.configForms?.describe === 'function') {
        let warned = false
        const describe = ctx.configForms.describe()
        const check = () => {
          if (warned) return
          const current = describe.getSnapshot().view
          if (current === undefined) return
          if (current.namespaces.some((entry) => entry.ns === ROW_ID)) return
          warned = true
          console.warn(`dsh-plugin-custom-headers: the host serves no settings form for row "${ROW_ID}", so the Settings page stays hidden. Keep the row id "${ROW_ID}" in the profile patch to edit routes here.`)
        }
        ctx.effect(() => {
          const off = describe.subscribe(check)
          describe.ensure()
          check()
          return off
        }, 'CustomHeaders: namespace diagnostic')
      }
    }

    return { inject, apply }
  },
})
