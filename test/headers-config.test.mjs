// Unit tests for the two pure modules: the case-insensitive header merge and
// configuration resolution. No network, no Harness services.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertValidHeaders,
  mergeHeadersCaseInsensitive,
  providersFingerprint,
  resolveRoute,
  resolveRoute as resolve,
} from '../lib/index.js'
import * as plugin from '../lib/index.js'

test('merge keeps one field per case-insensitive name, last source wins', () => {
  const merged = mergeHeadersCaseInsensitive(
    { 'User-Agent': 'first', Accept: 'application/json' },
    { 'user-agent': 'second' },
    undefined,
    { 'USER-AGENT': 'third' },
  )
  assert.equal(Object.keys(merged).length, 2)
  assert.equal(merged['USER-AGENT'], 'third')
  assert.equal(merged.Accept, 'application/json')
  assert.deepEqual(
    Object.keys(merged).map((name) => name.toLowerCase()).sort(),
    ['accept', 'user-agent'],
  )
})

test('merge drops a value that a later source sets to an empty string', () => {
  const merged = mergeHeadersCaseInsensitive({ 'X-Trace': 'abc' }, { 'x-trace': '' })
  assert.equal(merged['x-trace'], '')
})

test('merge refuses to invent fields from nothing', () => {
  assert.deepEqual(mergeHeadersCaseInsensitive(), {})
  assert.deepEqual(mergeHeadersCaseInsensitive(undefined, undefined), {})
})

test('header validation accepts ordinary deployment headers', () => {
  assert.doesNotThrow(() => assertValidHeaders('route', {
    'User-Agent': 'claude-cli/2.1.301 (external, cli)',
    'HTTP-Referer': 'https://example.com',
    'X-Title': 'Harness',
  }))
  assert.doesNotThrow(() => assertValidHeaders('route', {}))
})

test('header validation rejects values that cannot be sent', () => {
  assert.throws(() => assertValidHeaders('route', { 'X-Retry': 3 }), /must be a string/)
  assert.throws(() => assertValidHeaders('route', { 'Bad\nName': 'x' }), /route/)
  assert.throws(() => assertValidHeaders('route', { 'X-Thing': 'line\nbreak' }), /route/)
  assert.throws(() => assertValidHeaders('route', { 'Content-Length': '5' }), /route/)
  assert.throws(() => assertValidHeaders('route', { 'Transfer-Encoding': 'chunked' }), /route/)
})

test('a route resolves with the documented defaults', () => {
  const route = resolve('route', {
    displayName: 'Friendly legacy label',
    api: 'openai-responses',
    baseURL: 'https://example.invalid/v1',
    apiKeyEnv: 'SOME_KEY',
    models: [{ id: 'model-a' }],
  })
  assert.equal(route.provider, 'route')
  assert.equal(route.displayName, 'route', 'displayName is derived from the route id')
  assert.equal(route.streamIdleTimeoutMs, 300000)
  assert.equal(route.maxRequestImageBytes, 20971520)
  assert.equal(route.requestImagePixelBudget, 4194304)
  assert.equal(route.requestImageMaxBytes, 1048576)
  assert.deepEqual(route.models[0].input, ['text'])
  assert.equal(route.models[0].contextWindow, 262144)
  assert.equal(route.models[0].maxTokens, 32768)
  assert.equal(route.models[0].reasoning, false)
  assert.equal(route.modelErrors.size, 0)
})

test('a route reports the fields it cannot serve, naming the route', () => {
  const cases = [
    [{ baseURL: 'https://example.invalid/v1', models: [{ id: 'a' }] }, /needs an "api"/],
    [{ api: 'chat-completions', baseURL: 'https://example.invalid', models: [{ id: 'a' }] }, /cannot serve/],
    [{ api: 'openai-responses', models: [{ id: 'a' }] }, /needs a "baseURL"/],
    [{ api: 'openai-responses', baseURL: 'not-a-url', models: [{ id: 'a' }] }, /not an absolute URL/],
    [{ api: 'openai-responses', baseURL: 'ftp://example.invalid', models: [{ id: 'a' }] }, /must use http or https/],
    [{ api: 'openai-responses', baseURL: 'https://example.invalid/v1', models: [] }, /no models/],
    [{ api: 'openai-responses', baseURL: 'https://example.invalid/v1' }, /no models/],
    [{ api: 'openai-responses', baseURL: 'https://example.invalid/v1', reasoning: 'extra', models: [{ id: 'a' }] }, /reasoning must be one of/],
    [{ api: 'openai-responses', baseURL: 'https://example.invalid/v1', streamIdleTimeoutMs: -1, models: [{ id: 'a' }] }, /streamIdleTimeoutMs must be a positive integer/],
    [{ api: 'openai-responses', baseURL: 'https://example.invalid/v1', headers: { 'User-Agent': 1 }, models: [{ id: 'a' }] }, /must be a string/],
  ]
  for (const [source, expected] of cases) {
    assert.throws(() => resolve('named-route', source), (error) => {
      assert.match(error.message, expected)
      assert.match(error.message, /named-route/)
      return true
    })
  }
  assert.throws(() => resolve('', { api: 'openai-responses', baseURL: 'https://example.invalid', models: [{ id: 'a' }] }), /non-empty/)
})

test('an unusable model entry is recorded, not fatal', () => {
  const route = resolve('route', {
    api: 'anthropic-messages',
    baseURL: 'https://example.invalid',
    models: [
      { id: 'good', contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'] },
      { id: 'dupe-bad-input', input: ['audio'] },
    ],
  })
  assert.equal(route.models.length, 1)
  assert.equal(route.modelErrors.size, 1)
  assert.match([...route.modelErrors.values()][0], /audio/)
  assert.equal(route.configuredMaxTokens.get('good'), 64000)
})

test('reasoning efforts translate into a thinking-level map', () => {
  const route = resolve('route', {
    api: 'anthropic-messages',
    baseURL: 'https://example.invalid',
    models: [{ id: 'thinker', reasoningEfforts: { off: null, minimal: 'low', high: 'high', max: 'max' } }],
  })
  const model = route.models[0]
  assert.equal(model.reasoning, true)
  // `off: null` is deliberately left out of the map: "do not think" dispatches
  // as the reasoning parameter's absence, and every undeclared level is pinned
  // to null so it is not offered.
  assert.deepEqual(model.thinkingLevelMap, {
    minimal: 'low', low: null, medium: null, high: 'high', xhigh: null, max: 'max',
  })
  assert.deepEqual(plugin.getSupportedThinkingLevels(model), ['off', 'minimal', 'high', 'max'])
})

test('an off-only or empty reasoning declaration is rejected with guidance', () => {
  for (const [efforts, expected] of [
    [{ off: null }, /offers no level beyond "off"/],
    [{}, /empty reasoningEfforts/],
    [{ high: '' }, /must not be an empty string/],
    [{ high: null }, /needs the wire value/],
  ]) {
    assert.throws(() => resolve('route', {
      api: 'openai-responses',
      baseURL: 'https://example.invalid/v1',
      models: [{ id: 'm', reasoningEfforts: efforts }],
    }), expected)
  }
})

test('the fingerprint ignores provider order but notices real changes', () => {
  const a = { one: { api: 'openai-responses' }, two: { api: 'anthropic-messages' } }
  const b = { two: { api: 'anthropic-messages' }, one: { api: 'openai-responses' } }
  assert.equal(providersFingerprint(a), providersFingerprint(b))
  assert.notEqual(
    providersFingerprint(a),
    providersFingerprint({ ...a, one: { api: 'openai-responses', headers: { 'X-A': '1' } } }),
  )
})

test('the exported Config schema preserves a realistic provider dictionary', () => {
  const value = plugin.Config({
    providers: {
      'agentrouter-openai': {
        api: 'openai-responses',
        baseURL: 'https://gateway.example.com/v1',
        apiKeyEnv: 'AGENTROUTER_OPENAI_API_KEY',
        headers: { 'User-Agent': 'claude-cli/2.1.301 (external, cli)' },
        models: [{ id: 'deepseek-v4-flash', input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } }],
      },
    },
  })
  // The dictionary is `.volatile()`, so it stays live-updatable; reading it the
  // same way `apply()` does proves the schema round-trips the configuration.
  const providers = plugin.readProviders(value)
  const entry = providers['agentrouter-openai']
  assert.equal(entry.api, 'openai-responses')
  assert.equal(entry.baseURL, 'https://gateway.example.com/v1')
  assert.equal(entry.apiKeyEnv, 'AGENTROUTER_OPENAI_API_KEY')
  assert.deepEqual(entry.headers, { 'User-Agent': 'claude-cli/2.1.301 (external, cli)' })
  assert.doesNotThrow(() => resolveRoute('agentrouter-openai', entry))
})
