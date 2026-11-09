// Test B: registration, collision handling, live reconciliation and cleanup.
//
// These run `apply()` against a fake LLM service that enforces the same
// unique-provider rule as the real one, so a collision, a bad route or a
// removed provider is observable without touching the live Harness.
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/** A stand-in `llm` service that keeps registrations unique, like the real seam. */
function fakeHost (existing = []) {
  const registered = new Map(existing.map((provider) => [provider, { foreign: true }]))
  const logs = []
  const listeners = new Map()
  const disposers = []
  const discoveries = new Map()
  const ctx = {
    get: () => undefined,
    llm: {
      registerAdapter (providers, adapter) {
        for (const provider of providers) {
          if (registered.has(provider)) {
            const error = new Error(`provider "${provider}" already has an adapter`)
            error.code = 'DUPLICATE_ADAPTER'
            throw error
          }
          registered.set(provider, adapter)
        }
        return () => { for (const provider of providers) registered.delete(provider) }
      },
      registerModelDiscovery (settingsNs, discover) {
        discoveries.set(settingsNs, discover)
        return () => { discoveries.delete(settingsNs) }
      },
    },
    on (event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect (callback) {
      disposers.push(callback())
      return () => {}
    },
    logger: {
      info: (message) => logs.push(`info ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
      error: (message) => logs.push(`error ${message}`),
    },
  }
  return {
    ctx,
    registered,
    logs,
    discoveries,
    /** Deliver a volatile configuration update, as the Loader does. */
    fire (event = 'loader/volatile-update') {
      for (const listener of listeners.get(event) ?? []) listener()
    },
    /** Run the plugin's teardown effects. */
    dispose () {
      for (const dispose of disposers) dispose?.()
    },
    errors: () => logs.filter((line) => line.startsWith('error ')),
  }
}

/** A minimal valid route for one supported protocol. */
function route (api, extra = {}) {
  return {
    api,
    baseURL: api === 'anthropic-messages' ? 'https://example.invalid' : 'https://example.invalid/v1',
    apiKeyEnv: 'SOME_KEY',
    headers: { 'User-Agent': 'claude-cli/2.1.301 (external, cli)' },
    models: [{ id: 'model-a', input: ['text'] }],
    ...extra,
  }
}

/** A never-changing configuration object. */
function configOf (providers) {
  return { providers }
}

test('registers every configured provider once', () => {
  const host = fakeHost()
  apply(host.ctx, configOf({
    'route-chat': route('openai-completions'),
    'route-openai': route('openai-responses'),
    'route-anthropic': route('anthropic-messages'),
  }))

  assert.deepEqual([...host.registered.keys()].sort(), ['route-anthropic', 'route-chat', 'route-openai'])
  assert.equal(host.errors().length, 0, host.logs.join('\n'))
  assert.ok(host.logs.some((line) => line.includes('registered provider "route-openai"')))
})

test('a provider already owned by another adapter is reported, not thrown', () => {
  const host = fakeHost(['taken'])
  apply(host.ctx, configOf({
    taken: route('openai-responses'),
    fresh: route('anthropic-messages'),
  }))

  assert.ok(host.registered.has('taken'), 'the foreign registration is untouched')
  assert.ok(host.registered.has('fresh'), 'the healthy provider still registered')
  const errors = host.errors()
  assert.equal(errors.length, 1, host.logs.join('\n'))
  assert.match(errors[0], /DUPLICATE_ADAPTER/)
  assert.match(errors[0], /"taken"/)
})

test('one misconfigured provider does not prevent the others', () => {
  const host = fakeHost()
  apply(host.ctx, configOf({
    broken: { api: 'chat-completions', baseURL: 'https://example.invalid', models: [{ id: 'x' }] },
    modeless: { api: 'openai-responses', baseURL: 'https://example.invalid/v1', models: [] },
    healthy: route('openai-responses'),
  }))

  assert.deepEqual([...host.registered.keys()], ['healthy'])
  assert.equal(host.errors().length, 2, host.logs.join('\n'))
  assert.match(host.logs.join('\n'), /provider "broken" was not registered: .*cannot serve/)
  assert.match(host.logs.join('\n'), /provider "modeless" was not registered: .*no models/)
})

test('an unusable model entry is skipped and the route still serves the rest', () => {
  const host = fakeHost()
  apply(host.ctx, configOf({
    partial: route('openai-responses', {
      models: [
        { id: 'good', input: ['text', 'image'] },
        { id: 'bad', input: ['audio'] },
      ],
    }),
  }))

  assert.ok(host.registered.has('partial'))
  assert.match(host.logs.join('\n'), /skipped model "bad": .*modalities/)
})

test('teardown unregisters every provider this plugin added', () => {
  const host = fakeHost(['foreign'])
  apply(host.ctx, configOf({ mine: route('openai-responses') }))
  assert.ok(host.registered.has('mine'))
  assert.deepEqual([...host.discoveries.keys()], ['CustomHeaders'], 'model discovery is offered for this plugin\'s page')

  host.dispose()
  assert.deepEqual([...host.registered.keys()], ['foreign'], 'only this plugin\'s routes are removed')
  assert.deepEqual([...host.discoveries.keys()], [], 'the discovery offer is withdrawn with the plugin')
})

test('a volatile update re-registers changed routes and drops removed ones', () => {
  const host = fakeHost()
  let providers = {
    keep: route('openai-responses'),
    remove: route('anthropic-messages'),
  }
  const config = {
    get providers () { return providers },
  }
  apply(host.ctx, config)
  const firstAdapter = host.registered.get('keep')
  assert.deepEqual([...host.registered.keys()].sort(), ['keep', 'remove'])

  // Unchanged configuration is not re-registered.
  host.fire()
  assert.equal(host.registered.get('keep'), firstAdapter, 'an unchanged route keeps its adapter')

  providers = {
    keep: route('openai-responses', { headers: { 'User-Agent': 'changed/2' } }),
    added: route('anthropic-messages'),
  }
  host.fire()
  assert.deepEqual([...host.registered.keys()].sort(), ['added', 'keep'])
  assert.notEqual(host.registered.get('keep'), firstAdapter, 'a changed route gets a fresh adapter')
  assert.ok(host.logs.some((line) => line.includes('provider "remove" is no longer configured')))
  assert.equal(host.errors().length, 0, host.logs.join('\n'))
})

test('a volatile update that breaks everything leaves the previous routes intact', () => {
  const host = fakeHost()
  let providers = { stable: route('openai-responses') }
  apply(host.ctx, { get providers () { return providers } })
  const adapter = host.registered.get('stable')

  providers = { stable: { api: 'openai-responses', baseURL: 'https://example.invalid/v1', models: [] } }
  host.fire()

  // The broken replacement is refused; the working registration is kept.
  assert.equal(host.registered.get('stable'), adapter, 'the previous adapter still serves the route')
  assert.equal(host.errors().length, 1, host.logs.join('\n'))
})

test('failed replacement restores the exact old adapter and can retry', () => {
  const host = fakeHost()
  let providers = { stable: route('openai-responses') }
  apply(host.ctx, { get providers () { return providers } })
  const old = host.registered.get('stable')
  const register = host.ctx.llm.registerAdapter
  let fail = true
  host.ctx.llm.registerAdapter = (names, adapter) => {
    if (fail && adapter !== old) { fail = false; throw new Error('replacement failed') }
    return register(names, adapter)
  }
  providers = { stable: route('openai-responses', { headers: { 'User-Agent': 'new' } }) }
  host.fire()
  assert.equal(host.registered.get('stable'), old)
  assert.match(host.logs.join('\n'), /previous adapter restored/)
  host.fire()
  assert.notEqual(host.registered.get('stable'), old)
  host.dispose()
  assert.equal(host.registered.size, 0)
})
