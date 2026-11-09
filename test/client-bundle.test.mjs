// Browser-half contract tests.
//
// The client bundle is plain JavaScript served straight from the package, so
// nothing type-checks it and nothing renders it in CI. These tests exercise the
// parts a wrong API name would break: the module registration the Host's client
// scan expects, the slot key the Plugin Manager matches, and the settings
// mutations a save produces — through a minimal React stand-in, because a real
// renderer would need a browser.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

/** The identities the page's User-Agent presets insert. */
const LATEST_CLAUDE_CODE_UA = 'claude-cli/2.1.303 (external, cli)'
const LATEST_CODEX_UA = 'codex_cli_rs/0.163.0 (Windows 10.0.26100; x86_64) WindowsTerminal'

/** An in-memory stand-in for `window.localStorage`. */
function memoryStorage (initial = {}) {
  const entries = new Map(Object.entries(initial))
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => { entries.set(key, String(value)) },
    removeItem: (key) => { entries.delete(key) },
    stored: (key) => entries.get(key),
  }
}

/** Evaluate `client.js` and return the module registration it hands the loader. */
function loadRegistration (storage) {
  let registration
  const windowObject = { __ModuleLoader__: { load: (value) => { registration = value } } }
  if (storage !== undefined) windowObject.localStorage = storage
  const sandbox = {
    window: windowObject,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    URL,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return registration
}

/**
 * Build a React stand-in plus a tiny renderer.
 *
 * Hook state is keyed by the component's render path, so a re-render of the
 * page sees what the previous render set through `useState`, and the test never
 * needs a DOM.
 */
function createRenderer () {
  const buckets = new Map()
  let bucket = { hooks: [] }
  let cursor = 0
  let ids = 0

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const owner = bucket
      const index = cursor++
      if (!(index in owner.hooks)) owner.hooks[index] = typeof initial === 'function' ? initial() : initial
      return [owner.hooks[index], (next) => {
        owner.hooks[index] = typeof next === 'function' ? next(owner.hooks[index]) : next
      }]
    },
    useMemo: (factory) => factory(),
    /**
     * Run an effect when its dependencies change, like React does after a
     * commit. Cleanups are ignored: the stand-in never unmounts a component, so
     * a test that needs the cleanup path exercises it directly.
     */
    useEffect: (create, dependencies) => {
      const owner = bucket
      const index = cursor++
      const previous = owner.hooks[index]
      const settled = previous !== undefined &&
        dependencies !== undefined &&
        previous.dependencies !== undefined &&
        dependencies.length === previous.dependencies.length &&
        dependencies.every((value, at) => Object.is(value, previous.dependencies[at]))
      if (settled) return
      owner.hooks[index] = { dependencies: dependencies === undefined ? undefined : [...dependencies] }
      create()
    },
    useId: () => `field-${++ids}`,
  }

  const normalize = (node, at) => {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node), at }
    if (Array.isArray(node)) {
      const children = []
      for (const child of node) {
        if (Array.isArray(child)) children.push(...child.map((entry, index) => normalize(entry, `${at}/${index}`)))
        else children.push(normalize(child, `${at}/${children.length}`))
      }
      return children
    }
    if (typeof node.type === 'function') {
      const key = `${at}:${node.type.name}`
      let target = buckets.get(key)
      if (target === undefined) {
        target = { hooks: [] }
        buckets.set(key, target)
      }
      const previous = bucket
      const previousCursor = cursor
      bucket = target
      cursor = 0
      try {
        return normalize(node.type(node.props), at)
      } finally {
        bucket = previous
        cursor = previousCursor
      }
    }
    const flat = []
    for (const child of node.children) {
      if (Array.isArray(child)) flat.push(...child.map((entry, index) => normalize(entry, `${at}/${index}`)))
      else flat.push(normalize(child, `${at}/${flat.length}`))
    }
    return { type: node.type, props: node.props, at, children: flat }
  }

  return {
    React,
    render (component, props) {
      cursor = 0
      return normalize(component(props), '/root')
    },
  }
}

/** Every node matching a predicate, depth first. */
function collect (node, predicate, found = []) {
  if (node === null || node === undefined) return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  if (node.children !== undefined) collect(node.children, predicate, found)
  return found
}

/** Text content of a subtree, joined. */
function textOf (node) {
  if (node === null || node === undefined) return ''
  if (typeof node.text === 'string') return node.text
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/** Provider dictionary shaped like the plugin's shipped patch. */
function providers () {
  return {
    'agentrouter-openai': {
      displayName: 'agentrouter-openai',
      api: 'openai-responses',
      baseURL: 'https://gateway.example.com/v1',
      apiKeyEnv: 'AGENTROUTER_OPENAI_API_KEY',
      headers: { 'User-Agent': 'claude-cli/2.1.301 (external, cli)' },
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'gpt-6.1-sol' }],
    },
    'agentrouter-anthropic': {
      displayName: 'agentrouter-anthropic',
      api: 'anthropic-messages',
      baseURL: 'https://gateway.example.com',
      headers: {},
      models: [{ id: 'claude-opus-5-5' }],
    },
  }
}

/** Translation stand-in that keeps the key and its parameters visible. */
function translator () {
  return (key, params) => params === undefined ? key : `${key}(${JSON.stringify(params)})`
}

/** Run `apply` against a stub context and return the component it registered. */
function mount (storage) {
  const registration = loadRegistration(storage)
  const renderer = createRenderer()
  const module = registration.factory((id) => {
    if (id === 'react') return renderer.React
    throw new Error(`unexpected module request: ${id}`)
  })
  const registrations = []
  const ctx = {
    effect: (callback) => callback(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    configForms: {
      get: () => ({
        getSnapshot: () => ({ status: 'loading', writable: false }),
        subscribe: () => () => {},
        mutate: async () => true,
      }),
      describe: () => ({ getSnapshot: () => ({ view: { namespaces: [] } }), subscribe: () => () => {}, ensure: () => {} }),
      whileServed: (namespaces, register) => register(new Set(namespaces)),
    },
    slots: {
      inject: (ownerKey, callback) => callback(),
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
  }
  module.apply(ctx)
  const page = registrations.find((entry) => entry.options.name === 'settings.section')
  assert.ok(page !== undefined, 'the Settings section registers')
  assert.equal(registrations.length, 1, 'the removed Plugins row page no longer registers')
  return { module, renderer, registrations, options: page.options, Card: page.component }
}

/** Assemble the props the slot renderer supplies to the registered component. */
function slotProps (snapshot, overrides = {}) {
  return {
    t: translator(),
    view: 'page',
    useForm: (selector) => selector(snapshot),
    mutate: async () => true,
    credentials: {
      available: true,
      describe: async () => ({}),
      set: async () => undefined,
    },
    ...overrides,
  }
}

test('the manifest exports the client bundle the host scan looks for', () => {
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(pkg.files.includes('client.js'), 'files lists the client bundle')
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('client.js registers one factory under the package name', () => {
  const registration = loadRegistration()
  assert.ok(registration !== undefined, 'client.js calls __ModuleLoader__.load')
  assert.equal(registration.id, pkg.name)
  assert.equal(typeof registration.factory, 'function')
})

test('the plugin requires the slots, locale, configForms, and remote services', () => {
  const registration = loadRegistration()
  const module = registration.factory((id) => {
    if (id === 'react') return createRenderer().React
    throw new Error(`unexpected module request: ${id}`)
  })
  assert.deepEqual([...module.inject], ['slots', 'locale', 'configForms', 'remote', 'remote.llm', 'remote.credentials'])
  assert.equal(typeof module.apply, 'function')
})

/** Every password field currently rendered, in document order. */
function secretInputs (tree) {
  return collect(tree, (node) => node.type === 'input' && node.props.type === 'password')
}

/** Type a key into one route's key field, as a reader would. */
function typeKey (tree, position, key) {
  const field = secretInputs(tree)[position]
  assert.ok(field !== undefined, `route ${position} has a key field`)
  assert.ok(field.props.disabled !== true, 'the key field accepts input')
  field.props.onChange({ target: { value: key } })
}

test('the editor is registered only as the Custom Headers Settings section', () => {
  const { registrations, renderer } = mount()
  const section = registrations.find((entry) => entry.options.name === 'settings.section')
  assert.ok(section !== undefined, 'the Settings section registers')
  assert.equal(section.options.id, 'custom-headers')
  assert.equal(section.options.order, 30)
  assert.equal(section.options.label(), 'settingsSectionLabel', 'the nav label is localized through the plugin dictionary')
  assert.equal(registrations.filter((entry) => entry.options.name === 'settings.section').length, 1)
  assert.equal(registrations.filter((entry) => entry.options.name === 'plugins.row.config').length, 0,
    'the old Plugins row page is gone')

  assert.ok(source.includes("settingsTitle: 'Custom Headers'"))
  assert.ok(source.includes("settingsSectionLabel: 'Custom Headers'"))
  for (const locale of ['zh', 'en']) {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'locale', `${locale}.json`), 'utf8')).meta
    assert.ok(source.includes(meta.description), `the ${locale} Settings description matches the package description`)
  }

  const tree = renderer.render(section.component, slotProps({
    status: 'ready',
    writable: true,
    value: { providers: providers() },
  }))
  assert.match(textOf(tree), /settingsTitle/)
  assert.match(textOf(tree), /settingsLead/)
  assert.match(textOf(tree), /summary\(\{"providers":2,"models":3,"headers":"User-Agent"\}\)/, 'the old page description is preserved')
  assert.equal(collect(tree, (node) => node.type === 'article' && node.props['data-provider'] === 'agentrouter-openai').length, 1,
    'the same route editor renders inside the Settings page')
})

test('the key field takes the key itself and never shows the stored reference', () => {
  const { Card, renderer } = mount()
  const tree = renderer.render(Card, slotProps({ status: 'ready', writable: true, value: { providers: providers() } }))

  const fields = secretInputs(tree)
  assert.equal(fields.length, 2, 'one write-only key field per route')
  assert.equal(fields[0].props.value, '', 'a stored reference is not echoed into the field')
  assert.equal(fields[0].props.placeholder, 'apiKeyPlaceholder')
  assert.equal(fields[0].props.autoComplete, 'new-password')
  const echoed = collect(tree, (node) => node.type === 'input' && node.props.value === 'AGENTROUTER_OPENAI_API_KEY')
  assert.deepEqual(echoed, [], 'the reference name is not editable on the page')
  assert.equal(collect(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'keyReveal').length, 0,
    'the reveal control only appears once something is typed')
})

test('a typed key stores under the derived reference and records it in the profile', async () => {
  const { Card, renderer } = mount()
  const routes = providers()
  delete routes['agentrouter-openai'].apiKeyEnv
  const mutations = []
  const stored = []
  const props = slotProps({ status: 'ready', writable: true, revision: 4, value: { providers: routes } }, {
    mutate: async (operations) => { mutations.push(operations); return true },
    credentials: {
      available: true,
      describe: async () => ({}),
      set: async (ref, value) => { stored.push([ref, value]); return undefined },
    },
  })

  let tree = renderer.render(Card, props)
  typeKey(tree, 0, 'sk-live-1')
  tree = renderer.render(Card, props)
  const save = collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0]
  assert.equal(save.props.disabled, false, 'a typed key alone enables the save')
  save.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(stored, [['AGENTROUTER_OPENAI_API_KEY', 'sk-live-1']], 'the key goes to the credential store')
  assert.equal(JSON.stringify(mutations), JSON.stringify([[
    { op: 'set', path: ['providers', 'agentrouter-openai', 'apiKeyEnv'], value: 'AGENTROUTER_OPENAI_API_KEY' },
  ]]), 'the profile records only the reference and nothing else')
})

test('a route that already names a reference keeps it and stores only the key', async () => {
  const { Card, renderer } = mount()
  const mutations = []
  const stored = []
  const props = slotProps({ status: 'ready', writable: true, revision: 4, value: { providers: providers() } }, {
    mutate: async (operations) => { mutations.push(operations); return true },
    credentials: {
      available: true,
      describe: async () => ({}),
      set: async (ref, value) => { stored.push([ref, value]); return undefined },
    },
  })

  let tree = renderer.render(Card, props)
  typeKey(tree, 0, 'sk-live-2')
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(stored, [['AGENTROUTER_OPENAI_API_KEY', 'sk-live-2']])
  assert.equal(JSON.stringify(mutations), '[]', 'nothing in the profile changes')
})

test('a configured key turns the placeholder into a keep-it hint', async () => {
  const { Card, renderer } = mount()
  const props = slotProps({ status: 'ready', writable: true, value: { providers: providers() } }, {
    credentials: {
      available: true,
      describe: async (refs) => Object.fromEntries(refs.map((ref) => [ref, { configured: true, writable: true }])),
      set: async () => undefined,
    },
  })

  renderer.render(Card, props)
  await new Promise((resolve) => setImmediate(resolve))
  const tree = renderer.render(Card, props)
  assert.equal(secretInputs(tree)[0].props.placeholder, 'apiKeyConfigured')
})

test('a store that refuses the key reports it and writes no configuration', async () => {
  const { Card, renderer } = mount()
  const mutations = []
  const props = slotProps({ status: 'ready', writable: true, revision: 4, value: { providers: providers() } }, {
    mutate: async (operations) => { mutations.push(operations); return true },
    credentials: {
      available: true,
      describe: async () => ({}),
      set: async () => 'the credential store is read-only',
    },
  })

  let tree = renderer.render(Card, props)
  typeKey(tree, 0, 'sk-live-3')
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  tree = renderer.render(Card, props)

  assert.match(textOf(tree), /apiKeyRejected/, 'the refusal is shown next to the page')
  assert.match(textOf(tree), /the credential store is read-only/)
  assert.equal(JSON.stringify(mutations), '[]', 'a key that was not stored does not half-write the route')
})

test('the old Plugins row configuration page is not contributed', () => {
  const { registrations, options, Card } = mount()
  assert.equal(options.name, 'settings.section')
  assert.equal(registrations.some((entry) => entry.options.name === 'plugins.row.config'), false)
  assert.equal(typeof Card, 'function')
})

test('the page shows every configured route and refuses a pristine save', () => {
  const { Card, renderer } = mount()
  const tree = renderer.render(Card, slotProps({ status: 'ready', writable: true, value: { providers: providers() } }))
  const rendered = textOf(tree)
  assert.match(rendered, /agentrouter-openai/)
  assert.doesNotMatch(rendered, /AgentRouter \(OpenAI Responses\)/, 'the card title is the route id, not a friendly label')
  assert.match(rendered, /Anthropic Messages/, 'the protocol select shows the full protocol name')
  assert.match(rendered, /OpenAI Responses/)
  const displayNameInputs = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'displayName')
  assert.deepEqual(displayNameInputs.map((input) => input.props.value), ['agentrouter-openai', 'agentrouter-anthropic'])
  assert.equal(displayNameInputs[0].props.readOnly, true, 'the display name is derived from the route id')
  const protocolSelect = collect(tree, (node) => node.type === 'select')[0]
  assert.equal(protocolSelect.props.value, 'openai-responses', 'the stored value stays the protocol id')
  assert.deepEqual(protocolSelect.children.map((option) => option.props.value), ['openai-completions', 'openai-responses', 'anthropic-messages'])
  assert.deepEqual(protocolSelect.children.map((option) => textOf(option)), ['OpenAI Chat Completions', 'OpenAI Responses', 'Anthropic Messages'])
  assert.match(rendered, /uaOverride/)

  const modelIds = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'modelId 1')
    .map((input) => input.props.value)
  assert.deepEqual(modelIds, ['deepseek-v4-flash', 'claude-opus-5-5'], 'each route lists its own models')

  const inputs = collect(tree, (node) => node.type === 'input')
  assert.equal(inputs.filter((input) => input.props.value === 'claude-cli/2.1.301 (external, cli)').length, 1, 'the configured User-Agent is editable')

  const save = collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0]
  assert.ok(save !== undefined, 'the page renders its save control')
  assert.equal(save.props.disabled, true, 'a pristine page has nothing to save')
  assert.match(rendered, /pristine/)
})

test('a legacy displayName is rewritten to the route id when another field saves', async () => {
  const { Card, renderer } = mount()
  const base = providers()
  base['agentrouter-openai'].displayName = 'Friendly legacy label'
  const calls = []
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 7,
    value: { providers: base },
    base: { providers: base },
    user: { providers: {} },
  }
  const props = slotProps(snapshot, { mutate: async (operations) => { calls.push(operations); return true } })

  let tree = renderer.render(Card, props)
  assert.doesNotMatch(textOf(tree), /Friendly legacy label/, 'the page never shows the stored friendly label')
  collect(tree, (node) => node.type === 'input' && node.props.value === 'https://gateway.example.com/v1')[0]
    .props.onChange({ target: { value: 'https://gateway.example.com/v2' } })
  tree = renderer.render(Card, props)

  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[
    { op: 'set', path: ['providers', 'agentrouter-openai', 'baseURL'], value: 'https://gateway.example.com/v2' },
    { op: 'set', path: ['providers', 'agentrouter-openai', 'displayName'], value: 'agentrouter-openai' },
  ]])
})

test('editing a header stages one operation that targets only that header bag', async () => {
  const { Card, renderer } = mount()
  const calls = []
  const snapshot = { status: 'ready', writable: true, revision: 4, value: { providers: providers() } }
  const props = slotProps(snapshot, { mutate: async (operations) => { calls.push(operations); return true } })

  let tree = renderer.render(Card, props)
  const input = collect(tree, (node) => node.type === 'input' && node.props.value === 'claude-cli/2.1.301 (external, cli)')[0]
  input.props.onChange({ target: { value: 'claude-cli/9.9.9' } })

  tree = renderer.render(Card, props)
  const save = collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0]
  assert.equal(save.props.disabled, false, 'an edit enables the save control')
  save.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  // The bundle runs in its own VM realm, so compare the plain JSON shape.
  assert.equal(JSON.stringify(calls), JSON.stringify([[{
    op: 'set',
    path: ['providers', 'agentrouter-openai', 'headers'],
    value: { 'User-Agent': 'claude-cli/9.9.9' },
  }]]))

  tree = renderer.render(Card, props)
  assert.match(textOf(tree), /saved/, 'a successful save reports itself')
})

test('a new User-Agent header starts from the latest Claude Code identity', () => {
  const { Card, renderer } = mount()
  const props = slotProps({ status: 'ready', writable: true, value: { providers: providers() } })

  let tree = renderer.render(Card, props)
  const add = collect(tree, (node) => node.type === 'button' && textOf(node) === 'addHeader')
  add[add.length - 1].props.onClick()
  tree = renderer.render(Card, props)
  const names = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headerName')
  names[names.length - 1].props.onChange({ target: { value: 'user-agent' } })

  tree = renderer.render(Card, props)
  const values = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headerValue')
  assert.equal(values[values.length - 1].props.value, LATEST_CLAUDE_CODE_UA, 'a blank User-Agent is filled with the default identity')

  const pickers = collect(tree, (node) => node.type === 'select' && String(node.props['aria-label']).startsWith('uaPreset'))
  const picker = pickers[pickers.length - 1]
  assert.equal(picker.props.value, 'claude-code-latest', 'the picker shows the default preset')
  const options = picker.children.filter((child) => child !== null)
  assert.deepEqual(options.map((option) => option.props.value), ['', 'claude-code-latest', 'codex-latest'])
  assert.match(textOf(picker), /uaPresetClaude/)
  assert.match(textOf(picker), /uaPresetCodex/)
})

test('choosing the Codex preset writes its latest User-Agent and saves it', async () => {
  const { Card, renderer } = mount()
  const calls = []
  const snapshot = { status: 'ready', writable: true, revision: 4, value: { providers: providers() } }
  const props = slotProps(snapshot, { mutate: async (operations) => { calls.push(operations); return true } })

  let tree = renderer.render(Card, props)
  const picker = collect(tree, (node) => node.type === 'select' && node.props['aria-label'] === 'uaPreset 1')[0]
  assert.equal(picker.props.value, '__current__', 'an older Claude Code identity stays the current value')
  const options = picker.children.filter((child) => child !== null)
  assert.deepEqual(options.map((option) => option.props.value), ['', 'claude-code-latest', 'codex-latest', '__current__'])

  picker.props.onChange({ target: { value: 'codex-latest' } })
  tree = renderer.render(Card, props)
  const values = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headerValue')
  assert.equal(values[0].props.value, LATEST_CODEX_UA, 'picking Codex writes its identity into the value field')

  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[{
    op: 'set',
    path: ['providers', 'agentrouter-openai', 'headers'],
    value: { 'User-Agent': LATEST_CODEX_UA },
  }]])
})

test('the last picked User-Agent preset is remembered across page loads', () => {
  const storage = memoryStorage()
  const props = slotProps({ status: 'ready', writable: true, value: { providers: providers() } })

  const first = mount(storage)
  let tree = first.renderer.render(first.Card, props)
  collect(tree, (node) => node.type === 'select' && node.props['aria-label'] === 'uaPreset 1')[0]
    .props.onChange({ target: { value: 'codex-latest' } })
  assert.equal(storage.stored('dsh-plugin-custom-headers:last-user-agent-preset'), 'codex-latest', 'the pick is stored locally, without a network call')

  const second = mount(storage)
  tree = second.renderer.render(second.Card, props)
  const saved = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headerValue')[0]
  assert.equal(saved.props.value, 'claude-cli/2.1.301 (external, cli)', 'memory never rewrites an existing saved value')
  const savedPicker = collect(tree, (node) => node.type === 'select' && node.props['aria-label'] === 'uaPreset 1')[0]
  assert.equal(savedPicker.props.value, '__current__', 'the saved value stays the authoritative selection')

  const add = collect(tree, (node) => node.type === 'button' && textOf(node) === 'addHeader')
  add[add.length - 1].props.onClick()
  tree = second.renderer.render(second.Card, props)
  const names = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headerName')
  names[names.length - 1].props.onChange({ target: { value: 'User-Agent' } })
  tree = second.renderer.render(second.Card, props)
  const values = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headerValue')
  assert.equal(values[values.length - 1].props.value, LATEST_CODEX_UA, 'a fresh page starts from the remembered preset')
})

test('a refused store falls back to the latest Claude Code identity', () => {
  const storage = {
    getItem: () => { throw new Error('storage unavailable') },
    setItem: () => { throw new Error('storage unavailable') },
  }
  const props = slotProps({ status: 'ready', writable: true, value: { providers: providers() } })
  const { Card, renderer } = mount(storage)

  let tree = renderer.render(Card, props)
  const add = collect(tree, (node) => node.type === 'button' && textOf(node) === 'addHeader')
  add[add.length - 1].props.onClick()
  tree = renderer.render(Card, props)
  const names = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headerName')
  names[names.length - 1].props.onChange({ target: { value: 'User-Agent' } })
  tree = renderer.render(Card, props)
  const values = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headerValue')
  assert.equal(values[values.length - 1].props.value, LATEST_CLAUDE_CODE_UA, 'no remembered value means the documented default')

  const picker = collect(tree, (node) => node.type === 'select' && String(node.props['aria-label']).startsWith('uaPreset')).pop()
  assert.doesNotThrow(() => { picker.props.onChange({ target: { value: 'codex-latest' } }) })
  tree = renderer.render(Card, props)
  const afterPick = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headerValue')
  assert.equal(afterPick[afterPick.length - 1].props.value, LATEST_CODEX_UA, 'the in-memory choice still works without a store')
})

test('a refused save keeps the draft and names the failure', async () => {
  const { Card, renderer } = mount()
  const snapshot = { status: 'ready', writable: true, revision: 4, value: { providers: providers() } }
  const props = slotProps(snapshot, { mutate: async () => false })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'input' && node.props.value === 'https://gateway.example.com')[0]
    .props.onChange({ target: { value: 'https://example.test' } })

  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  tree = renderer.render(Card, props)
  assert.match(textOf(tree), /saveFailed/)
  assert.match(textOf(tree), /dirty/, 'the edit is still staged')
})

test('an invalid header name blocks the save and explains why', () => {
  const { Card, renderer } = mount()
  const props = slotProps({ status: 'ready', writable: true, value: { providers: providers() } })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headerName')[0]
    .props.onChange({ target: { value: 'bad name' } })

  tree = renderer.render(Card, props)
  assert.match(textOf(tree), /invalidHeaderName/)
  const save = collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0]
  assert.equal(save.props.disabled, true, 'an invalid draft cannot be saved')
})

test('a duplicate header is reported case-insensitively', () => {
  const { Card, renderer } = mount()
  const props = slotProps({ status: 'ready', writable: true, value: { providers: providers() } })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'addHeader')[0].props.onClick()
  tree = renderer.render(Card, props)
  const rows = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headerName')
  rows[rows.length - 1].props.onChange({ target: { value: 'user-agent' } })

  tree = renderer.render(Card, props)
  assert.match(textOf(tree), /duplicateHeader/)
})

test('a read-only deployment renders the notice and disables saving', () => {
  const { Card, renderer } = mount()
  const tree = renderer.render(Card, slotProps({ status: 'ready', writable: false, value: { providers: providers() } }))
  assert.match(textOf(tree), /readOnly/)
  const save = collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0]
  assert.equal(save.props.disabled, true)
})

test('an unavailable namespace says so instead of rendering an empty form', () => {
  const { Card, renderer } = mount()
  const tree = renderer.render(Card, slotProps({ status: 'unavailable', writable: true }))
  assert.match(textOf(tree), /unavailable/)
})

/** The first input carrying one aria-label, in document order. */
function inputByLabel (tree, label) {
  return collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === label)[0]
}

/** Every model ID input currently rendered, in document order. */
function modelIds (tree) {
  return collect(tree, (node) => node.type === 'input' && String(node.props['aria-label'] ?? '').startsWith('modelId '))
    .map((input) => input.props.value)
}

/** Click the fold control of one model row, as a reader would. */
function toggleModel (tree, position) {
  const button = collect(tree, (node) => node.type === 'button' && node.props?.['aria-label'] === `modelAdvanced ${position}`)[0]
  assert.ok(button !== undefined, `model ${position} has a fold control`)
  assert.ok(!button.props.disabled, 'the fold control is clickable')
  button.props.onClick()
}

test('model detail starts folded and opens on demand', () => {
  const { Card, renderer } = mount()
  const routes = providers()
  routes['agentrouter-openai'].models = [{
    id: 'deepseek-v4-flash',
    contextWindow: 1000000,
    maxTokens: 16000,
    input: ['text', 'image'],
  }]
  let tree = renderer.render(Card, slotProps({ status: 'ready', writable: true, value: { providers: routes } }))

  assert.equal(inputByLabel(tree, 'contextWindow 1'), undefined, 'capacities stay folded')
  assert.equal(collect(tree, (node) => node.props?.className === 'dshch-switch').length, 0, 'reasoning stays folded')
  assert.equal(collect(tree, (node) => node.props?.['aria-label'] === 'modelAdvanced 1')[0].props['aria-expanded'], false)
  assert.deepEqual(modelIds(tree), ['deepseek-v4-flash', 'claude-opus-5-5'], 'every model is listed by identity, folded or not')

  toggleModel(tree, 1)
  tree = renderer.render(Card, slotProps({ status: 'ready', writable: true, value: { providers: routes } }))
  assert.equal(inputByLabel(tree, 'contextWindow 1').props.value, '1M')
  assert.equal(collect(tree, (node) => node.props?.['aria-label'] === 'modelAdvanced 1')[0].props['aria-expanded'], true)
})

test('a row holding an unreadable capacity stays open when it is folded', () => {
  const { Card, renderer } = mount()
  const snapshot = { status: 'ready', writable: true, revision: 4, value: { providers: providers() } }
  const props = slotProps(snapshot)

  let tree = renderer.render(Card, props)
  toggleModel(tree, 1)
  tree = renderer.render(Card, props)
  inputByLabel(tree, 'contextWindow 1').props.onChange({ target: { value: 'lots' } })
  tree = renderer.render(Card, props)

  toggleModel(tree, 1)
  tree = renderer.render(Card, props)
  assert.equal(inputByLabel(tree, 'contextWindow 1').props.value, 'lots', 'the blocked field stays in front of the reader')
  assert.equal(collect(tree, (node) => node.props?.['aria-label'] === 'modelAdvanced 1')[0].props['aria-expanded'], true)
  assert.match(textOf(tree), /modelContextInvalid/)
  const save = collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0]
  assert.equal(save.props.disabled, true)
})

test('a model row shows its capacities in short form and its configured input types', () => {
  const { Card, renderer } = mount()
  const routes = providers()
  routes['agentrouter-openai'].models = [{
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    contextWindow: 1000000,
    maxTokens: 16000,
    input: ['text', 'image'],
  }]
  let tree = renderer.render(Card, slotProps({ status: 'ready', writable: true, value: { providers: routes } }))
  toggleModel(tree, 1)
  tree = renderer.render(Card, slotProps({ status: 'ready', writable: true, value: { providers: routes } }))

  assert.equal(inputByLabel(tree, 'contextWindow 1').props.value, '1M')
  assert.equal(inputByLabel(tree, 'maxTokens 1').props.value, '16K')
  const checkboxes = collect(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkboxes.filter((checkbox) => checkbox.props.checked).length, 2, 'text and image are on in the opened row')
  assert.match(textOf(tree), /modelsInherited/, 'the configuration layer owns the default directory')
})

test('editing a capacity stages one models operation for that route only', async () => {
  const { Card, renderer } = mount()
  const calls = []
  const snapshot = { status: 'ready', writable: true, revision: 4, value: { providers: providers() } }
  const props = slotProps(snapshot, { mutate: async (operations) => { calls.push(operations); return true } })

  let tree = renderer.render(Card, props)
  toggleModel(tree, 1)
  tree = renderer.render(Card, props)
  inputByLabel(tree, 'contextWindow 1').props.onChange({ target: { value: '262144' } })
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(JSON.stringify(calls), JSON.stringify([[{
    op: 'set',
    path: ['providers', 'agentrouter-openai', 'models'],
    value: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 262144 },
      { id: 'gpt-6.1-sol' },
    ],
  }]]))
})

test('adding a model writes only what the row states', async () => {
  const { Card, renderer } = mount()
  const calls = []
  const snapshot = { status: 'ready', writable: true, revision: 4, value: { providers: providers() } }
  const props = slotProps(snapshot, { mutate: async (operations) => { calls.push(operations); return true } })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'addModel')[0].props.onClick()
  tree = renderer.render(Card, props)
  assert.match(textOf(tree), /modelIdRequired/, 'an empty row cannot be saved')
  inputByLabel(tree, 'modelId 3').props.onChange({ target: { value: 'new-model' } })

  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  const saved = JSON.parse(JSON.stringify(calls))[0][0]
  assert.deepEqual(saved.path, ['providers', 'agentrouter-openai', 'models'])
  assert.deepEqual(saved.value[2], { id: 'new-model' }, 'blank name, capacity, input set and reasoning are omitted')
})

test('switching reasoning on stages the default level table', async () => {
  const { Card, renderer } = mount()
  const calls = []
  const snapshot = { status: 'ready', writable: true, revision: 4, value: { providers: providers() } }
  const props = slotProps(snapshot, { mutate: async (operations) => { calls.push(operations); return true } })

  let tree = renderer.render(Card, props)
  toggleModel(tree, 1)
  tree = renderer.render(Card, props)
  const switches = collect(tree, (node) => node.props?.className === 'dshch-switch')
  collect(switches[0], (node) => node.type === 'input')[0].props.onChange({ target: { checked: true } })

  tree = renderer.render(Card, props)
  assert.match(textOf(tree), /modelReasoningAdd/, 'the level rows appear once reasoning is on')
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  const saved = JSON.parse(JSON.stringify(calls))[0][0]
  assert.deepEqual(saved.value[0].reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high' })
})

test('fetching models lists the endpoint catalog and adds only what is picked', async () => {
  const { Card, renderer } = mount()
  const calls = []
  const snapshot = { status: 'ready', writable: true, revision: 4, value: { providers: providers() } }
  const props = slotProps(snapshot, {
    mutate: async (operations) => { calls.push(operations); return true },
    discover: async () => ({
      kind: 'found',
      models: [
        { id: 'gpt-6.1-sol' },
        { id: 'new-model', name: 'New Model', contextWindow: 200000, maxTokens: 8192 },
      ],
    }),
  })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'fetchModels')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  tree = renderer.render(Card, props)

  assert.match(textOf(tree), /fetchTitle/)
  const candidates = collect(tree, (node) => node.props?.className === 'dshch-candidate')
  assert.equal(candidates.length, 2, 'both candidates are offered, including the configured one')
  collect(candidates[1], (node) => node.type === 'input')[0].props.onChange({ target: {} })

  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'fetchAdopt')[0].props.onClick()
  tree = renderer.render(Card, props)
  assert.deepEqual(modelIds(tree), ['deepseek-v4-flash', 'gpt-6.1-sol', 'new-model', 'claude-opus-5-5'])

  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const saved = JSON.parse(JSON.stringify(calls))[0][0]
  assert.deepEqual(saved.value[2], { id: 'new-model', name: 'New Model', contextWindow: 200000, maxTokens: 8192 })
})

test('a refused fetch reports the provider message', async () => {
  const { Card, renderer } = mount()
  const props = slotProps({ status: 'ready', writable: true, value: { providers: providers() } }, {
    discover: async () => ({ kind: 'refused', message: 'https://gateway.example.com/v1/models answered 401' }),
  })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'fetchModels')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  tree = renderer.render(Card, props)
  assert.match(textOf(tree), /answered 401/)
})

test('restoring defaults stages the configured default directory', async () => {
  const { Card, renderer } = mount()
  const calls = []
  const base = providers()
  const edited = providers()
  edited['agentrouter-openai'].models = [{ id: 'custom-model' }]
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 7,
    value: { providers: edited },
    base: { providers: base },
    user: { providers: { 'agentrouter-openai': { models: [{ id: 'custom-model' }] } } },
  }
  const props = slotProps(snapshot, { mutate: async (operations) => { calls.push(operations); return true } })

  let tree = renderer.render(Card, props)
  assert.match(textOf(tree), /modelsCustomized/, 'the user layer owns this route\'s directory')
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'resetModels')[0].props.onClick()
  tree = renderer.render(Card, props)
  assert.deepEqual(modelIds(tree).slice(0, 2), ['deepseek-v4-flash', 'gpt-6.1-sol'])

  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const saved = JSON.parse(JSON.stringify(calls))[0][0]
  assert.deepEqual(saved.value, [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'gpt-6.1-sol' },
  ])
})

test('a duplicate model ID is reported before the save', () => {
  const { Card, renderer } = mount()
  const props = slotProps({ status: 'ready', writable: true, value: { providers: providers() } })

  let tree = renderer.render(Card, props)
  inputByLabel(tree, 'modelId 2').props.onChange({ target: { value: 'deepseek-v4-flash' } })
  tree = renderer.render(Card, props)
  assert.match(textOf(tree), /modelIdDuplicate/)
  const save = collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0]
  assert.equal(save.props.disabled, true)
})


test('adding a provider writes one complete provider entry', async () => {
  const { Card, renderer } = mount()
  const calls = []
  const snapshot = { status: 'ready', writable: true, revision: 5, value: { providers: providers() } }
  const props = slotProps(snapshot, { mutate: async (operations) => { calls.push(operations); return true } })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === '+ addProvider')[0].props.onClick()
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'providerId')[0]
    .props.onChange({ target: { value: 'new-provider' } })
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'addProvider')[0].props.onClick()
  tree = renderer.render(Card, props)
  assert.equal(collect(tree, (node) => node.type === 'article' && node.props['data-provider'] === 'new-provider').length, 1)

  const urls = collect(tree, (node) => node.type === 'input' && node.props.placeholder === 'https://api.example.com/v1')
  urls[urls.length - 1].props.onChange({ target: { value: 'https://new.example.com/v1' } })
  tree = renderer.render(Card, props)
  const modelIds = collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'modelId 1')
  modelIds[modelIds.length - 1].props.onChange({ target: { value: 'new-model' } })
  tree = renderer.render(Card, props)

  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[{
    op: 'set',
    path: ['providers', 'new-provider'],
    value: {
      api: 'openai-responses',
      baseURL: 'https://new.example.com/v1',
      displayName: 'new-provider',
      headers: { 'User-Agent': LATEST_CLAUDE_CODE_UA },
      models: [{ id: 'new-model' }],
    },
  }]])
})

test('a duplicate route id is refused before a panel is added', () => {
  const { Card, renderer } = mount()
  const props = slotProps({ status: 'ready', writable: true, value: { providers: providers() } })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === '+ addProvider')[0].props.onClick()
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'providerId')[0]
    .props.onChange({ target: { value: 'agentrouter-openai' } })
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'addProvider')[0].props.onClick()
  tree = renderer.render(Card, props)

  assert.match(textOf(tree), /providerIdDuplicate/)
  assert.equal(collect(tree, (node) => node.type === 'article' && node.props['data-provider'] === 'agentrouter-openai').length, 1)
})

test('removing a provider stages one unset for that route', async () => {
  const { Card, renderer } = mount()
  const calls = []
  const snapshot = { status: 'ready', writable: true, revision: 5, value: { providers: providers() } }
  const props = slotProps(snapshot, { mutate: async (operations) => { calls.push(operations); return true } })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'removeProvider agentrouter-openai')[0]
    .props.onClick()
  tree = renderer.render(Card, props)
  assert.equal(collect(tree, (node) => node.type === 'article' && node.props['data-provider'] === 'agentrouter-openai').length, 0)

  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[{
    op: 'unset',
    path: ['providers', 'agentrouter-openai'],
  }]])
})

test('removing an inherited provider writes the whole provider dictionary without it', async () => {
  const { Card, renderer } = mount()
  const calls = []
  const base = providers()
  base['agentrouter-openai'].reasoning = 'high'
  base['agentrouter-openai'].streamIdleTimeoutMs = 90000
  const value = JSON.parse(JSON.stringify(base))
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 6,
    value: { providers: value },
    base: { providers: base },
    user: { providers: {} },
  }
  const props = slotProps(snapshot, { mutate: async (operations) => { calls.push(operations); return true } })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'removeProvider agentrouter-anthropic')[0]
    .props.onClick()
  tree = renderer.render(Card, props)
  assert.equal(collect(tree, (node) => node.type === 'article' && node.props['data-provider'] === 'agentrouter-anthropic').length, 0)

  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  // An `unset` here would be turned back into the inherited route by the Host's
  // settings layer ("unset restores the inherited value"), which is the bug this
  // test pins: the deletion has to replace the dictionary instead.
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[{
    op: 'set',
    path: ['providers'],
    value: {
      'agentrouter-openai': {
        displayName: 'agentrouter-openai',
        api: 'openai-responses',
        baseURL: 'https://gateway.example.com/v1',
        apiKeyEnv: 'AGENTROUTER_OPENAI_API_KEY',
        headers: { 'User-Agent': 'claude-cli/2.1.301 (external, cli)' },
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'gpt-6.1-sol' }],
        reasoning: 'high',
        streamIdleTimeoutMs: 90000,
      },
    },
  }]])
})

test('removing a provider retains credentials possibly shared outside the plugin', async () => {
  const { Card, renderer } = mount()
  const base = providers()
  base['agentrouter-anthropic'].apiKeyEnv = 'AGENTROUTER_ANTHROPIC_API_KEY'
  const value = JSON.parse(JSON.stringify(base))
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 7,
    value: { providers: value },
    base: { providers: base },
    user: { providers: {} },
  }
  const events = []
  const props = slotProps(snapshot, {
    mutate: async () => { events.push('config'); return true },
    credentials: {
      available: true,
      describe: async (refs) => Object.fromEntries(refs.map((ref) => [ref, { configured: true, source: 'file', writable: true }])),
      set: async () => undefined,
      unset: async (ref) => { events.push(`clear:${ref}`); return undefined },
    },
  })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'removeProvider agentrouter-anthropic')[0]
    .props.onClick()
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  // References can be shared outside this plugin; removal must never unset them.
  assert.deepEqual(events, ['config'])
  assert.match(textOf(renderer.render(Card, props)), /saved/)
})

test('a reference a surviving route still names keeps its stored key', async () => {
  const { Card, renderer } = mount()
  const base = providers()
  base['agentrouter-openai'].apiKeyEnv = 'SHARED_PROVIDER_KEY'
  base['agentrouter-anthropic'].apiKeyEnv = 'SHARED_PROVIDER_KEY'
  const value = JSON.parse(JSON.stringify(base))
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 8,
    value: { providers: value },
    base: { providers: base },
    user: { providers: {} },
  }
  const cleared = []
  const props = slotProps(snapshot, {
    mutate: async () => true,
    credentials: {
      available: true,
      describe: async (refs) => Object.fromEntries(refs.map((ref) => [ref, { configured: true, source: 'file', writable: true }])),
      set: async () => undefined,
      unset: async (ref) => { cleared.push(ref); return undefined },
    },
  })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'removeProvider agentrouter-anthropic')[0]
    .props.onClick()
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(cleared, [], 'the surviving route still uses this reference')
})

test('an environment-provided key is left alone when its route is removed', async () => {
  const { Card, renderer } = mount()
  const base = providers()
  base['agentrouter-anthropic'].apiKeyEnv = 'AGENTROUTER_ANTHROPIC_API_KEY'
  const value = JSON.parse(JSON.stringify(base))
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 9,
    value: { providers: value },
    base: { providers: base },
    user: { providers: {} },
  }
  const cleared = []
  const props = slotProps(snapshot, {
    mutate: async () => true,
    credentials: {
      available: true,
      describe: async (refs) => Object.fromEntries(refs.map((ref) => [ref, { configured: true, source: 'env', writable: true }])),
      set: async () => undefined,
      unset: async (ref) => { cleared.push(ref); return undefined },
    },
  })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'removeProvider agentrouter-anthropic')[0]
    .props.onClick()
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(cleared, [], 'the key comes from the environment, not the credential store')
})

test('route removal reports that shared credentials are retained', async () => {
  const { Card, renderer } = mount()
  const base = providers()
  base['agentrouter-anthropic'].apiKeyEnv = 'AGENTROUTER_ANTHROPIC_API_KEY'
  const value = JSON.parse(JSON.stringify(base))
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 10,
    value: { providers: value },
    base: { providers: base },
    user: { providers: {} },
  }
  const props = slotProps(snapshot, {
    mutate: async () => true,
    credentials: {
      available: true,
      describe: async (refs) => Object.fromEntries(refs.map((ref) => [ref, { configured: true, source: 'file', writable: true }])),
      set: async () => undefined,
      unset: async () => 'the credential store is read-only',
    },
  })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'removeProvider agentrouter-anthropic')[0]
    .props.onClick()
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  const text = textOf(renderer.render(Card, props))
  assert.match(text, /credentialsRetained/)
  assert.match(text, /saved/, 'the route removal itself still succeeded')
})

test('a refused config write keeps the stored key', async () => {
  const { Card, renderer } = mount()
  const base = providers()
  base['agentrouter-anthropic'].apiKeyEnv = 'AGENTROUTER_ANTHROPIC_API_KEY'
  const value = JSON.parse(JSON.stringify(base))
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 11,
    value: { providers: value },
    base: { providers: base },
    user: { providers: {} },
  }
  const cleared = []
  const props = slotProps(snapshot, {
    mutate: async () => false,
    credentials: {
      available: true,
      describe: async (refs) => Object.fromEntries(refs.map((ref) => [ref, { configured: true, source: 'file', writable: true }])),
      set: async () => undefined,
      unset: async (ref) => { cleared.push(ref); return undefined },
    },
  })

  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'removeProvider agentrouter-anthropic')[0]
    .props.onClick()
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(cleared, [], 'the route still exists, so its key must survive')
  assert.match(textOf(renderer.render(Card, props)), /saveFailed/)
})

test('saving only a new key never clears any stored key', async () => {
  const { Card, renderer } = mount()
  const cleared = []
  const stored = []
  const props = slotProps({ status: 'ready', writable: true, revision: 12, value: { providers: providers() } }, {
    mutate: async () => true,
    credentials: {
      available: true,
      describe: async (refs) => Object.fromEntries(refs.map((ref) => [ref, { configured: true, source: 'file', writable: true }])),
      set: async (ref, value) => { stored.push([ref, value]); return undefined },
      unset: async (ref) => { cleared.push(ref); return undefined },
    },
  })

  let tree = renderer.render(Card, props)
  typeKey(tree, 0, 'sk-live-3')
  tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(stored, [['AGENTROUTER_OPENAI_API_KEY', 'sk-live-3']])
  assert.deepEqual(cleared, [], 'no route was removed, so no key may be cleared')
})

test('an empty provider dictionary still renders the add button and form', () => {
  const { Card, renderer } = mount()
  const props = slotProps({ status: 'ready', writable: true, value: { providers: {} } })
  let tree = renderer.render(Card, props)
  assert.match(textOf(tree), /providersEmpty/)
  const toggle = collect(tree, (node) => node.type === 'button' && textOf(node) === '+ addProvider')[0]
  assert.ok(toggle !== undefined, 'the add-provider button is the only control until opened')
  assert.equal(collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'providerId').length, 0)

  toggle.props.onClick()
  tree = renderer.render(Card, props)
  assert.equal(collect(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'providerId').length, 1)
  assert.equal(collect(tree, (node) => node.type === 'button' && textOf(node) === 'addProvider').length, 1)
})

test('external revision changes refuse a stale draft before credentials or configuration writes', async () => {
  const { Card, renderer } = mount()
  const snapshot = { status: 'ready', writable: true, revision: 1, value: { providers: providers() } }
  let latest = snapshot
  let writes = 0
  const props = slotProps(snapshot, {
    getSnapshot: () => latest,
    mutate: async () => { writes++; return true },
  })
  let tree = renderer.render(Card, props)
  collect(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'removeProvider agentrouter-anthropic')[0].props.onClick()
  latest = { ...snapshot, revision: 2 }
  tree = renderer.render(Card, props)
  await collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  assert.equal(writes, 0)
  assert.match(textOf(renderer.render(Card, props)), /saveConflict/)
})

test('partially stored keys are reported and retry only stores the remaining keys', async () => {
  const { Card, renderer } = mount()
  const snapshot = { status: 'ready', writable: true, revision: 1, value: { providers: providers() } }
  const writes = []
  let refused = true
  let mutations = 0
  const props = slotProps(snapshot, {
    mutate: async () => { mutations++; return true },
    credentials: {
      available: true,
      describe: async () => ({}),
      set: async (ref) => {
        writes.push(ref)
        if (ref.includes('ANTHROPIC') && refused) return 'store refused'
      },
    },
  })
  let tree = renderer.render(Card, props)
  typeKey(tree, 0, 'first-secret')
  tree = renderer.render(Card, props)
  typeKey(tree, 1, 'second-secret')
  tree = renderer.render(Card, props)
  await collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  tree = renderer.render(Card, props)
  assert.match(textOf(tree), /keysPartiallySaved/)
  assert.doesNotMatch(textOf(tree), /first-secret/)
  assert.equal(mutations, 0)
  refused = false
  await collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(writes, ['AGENTROUTER_OPENAI_API_KEY', 'AGENTROUTER_ANTHROPIC_API_KEY', 'AGENTROUTER_ANTHROPIC_API_KEY'])
  assert.match(textOf(renderer.render(Card, props)), /saved/)
})

test('a configuration update during credential storage blocks configuration mutation', async () => {
  const { Card, renderer } = mount()
  const snapshot = { status: 'ready', writable: true, revision: 1, value: { providers: providers() } }
  let latest = snapshot
  let mutations = 0
  const props = slotProps(snapshot, {
    getSnapshot: () => latest,
    mutate: async () => { mutations++; return true },
    credentials: { available: true, describe: async () => ({}), set: async () => { latest = { ...snapshot, revision: 2 } } },
  })
  let tree = renderer.render(Card, props)
  typeKey(tree, 0, 'stored-secret')
  tree = renderer.render(Card, props)
  await collect(tree, (node) => node.type === 'button' && textOf(node) === 'save')[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(mutations, 0)
  const text = textOf(renderer.render(Card, props))
  assert.match(text, /saveConflict/)
  assert.match(text, /keysPartiallySaved/)
})
