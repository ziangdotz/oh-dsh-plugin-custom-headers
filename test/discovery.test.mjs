// Model discovery: the listing URL each protocol uses, the two reply shapes an
// endpoint may answer with, and the Host wiring that turns a named route into an
// interrogation of its own endpoint.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startMockServer, jsonResponder, jsonErrorResponder, headerValue, userAgentFields } from './mock-server.mjs'
import { apply, listingUrl, parseListing, probeModels, SETTINGS_NAMESPACE } from '../lib/index.js'

test('each protocol lists at its documented path', () => {
  assert.equal(listingUrl('https://gw.example/v1', 'openai-responses'), 'https://gw.example/v1/models')
  assert.equal(listingUrl('https://gw.example/v1/', 'openai-responses'), 'https://gw.example/v1/models')
  assert.equal(listingUrl('https://gw.example/openai/v1', 'openai-responses'), 'https://gw.example/openai/v1/models')
  assert.equal(listingUrl('https://gw.example/v1', 'openai-completions'), 'https://gw.example/v1/models', 'chat completions lists at the same OpenAI path')
  assert.equal(listingUrl('https://gw.example', 'anthropic-messages'), 'https://gw.example/v1/models?limit=1000')
  assert.equal(listingUrl('https://gw.example/v1', 'anthropic-messages'), 'https://gw.example/v1/models?limit=1000')
  assert.equal(listingUrl('https://gw.example/anthropic/v1/', 'anthropic-messages'), 'https://gw.example/anthropic/v1/models?limit=1000')
})

test('a data array supplies ids and disclosed capacities', () => {
  const models = parseListing({
    data: [
      { id: 'model-a', name: 'Model A', context_window: 1000000, max_output_tokens: 65536 },
      { id: 'model-b', context_length: 131072, top_provider: { max_completion_tokens: 8192 } },
      { name: 'no id at all' },
      { id: '' },
      { id: 'model-a', name: 'duplicate' },
    ],
  })
  assert.deepEqual(models, [
    { id: 'model-a', name: 'Model A', contextWindow: 1000000, maxTokens: 65536 },
    { id: 'model-b', contextWindow: 131072, maxTokens: 8192 },
  ])
})

test('a models map is keyed by the id requests accept', () => {
  const models = parseListing({
    models: {
      'relay/alpha': { id: 'canonical-alpha', limit: { context: 200000, output: 20000 } },
      'relay/beta': { name: 'Beta' },
      'relay/gamma': 'not a model record',
    },
  })
  assert.deepEqual(models, [
    { id: 'relay/alpha', contextWindow: 200000, maxTokens: 20000 },
    { id: 'relay/beta', name: 'Beta' },
  ])
})

test('a reply that is neither shape is refused with a readable reason', () => {
  for (const body of [{}, { data: 'nope' }, { models: [] }]) {
    assert.throws(() => parseListing(body), /neither a "data" array nor a "models" object/)
  }
})

test('an OpenAI-compatible route is probed with its own headers and key', async () => {
  const server = await startMockServer()
  try {
    server.setResponder(jsonResponder({ data: [{ id: 'model-a', context_window: 262144 }] }))
    const models = await probeModels({
      baseURL: `${server.url}/v1`,
      api: 'openai-responses',
      headers: { 'User-Agent': 'claude-cli/2.1.301 (external, cli)', 'X-Deployment': 'tower' },
      apiKey: 'sk-probe',
    })
    assert.deepEqual(models, [{ id: 'model-a', contextWindow: 262144 }])
    assert.equal(server.requests.length, 1)
    const request = server.requests[0]
    assert.equal(request.method, 'GET')
    assert.equal(request.url, '/v1/models')
    assert.deepEqual(userAgentFields(request), [['User-Agent', 'claude-cli/2.1.301 (external, cli)']])
    assert.equal(headerValue(request, 'x-deployment'), 'tower')
    assert.equal(headerValue(request, 'authorization'), 'Bearer sk-probe')
    assert.equal(headerValue(request, 'accept'), 'application/json')
  } finally {
    await server.close()
  }
})

test('an Anthropic route is probed with the version header and x-api-key', async () => {
  const server = await startMockServer()
  try {
    server.setResponder(jsonResponder({ data: [{ id: 'claude-probe' }] }))
    const models = await probeModels({
      baseURL: server.url,
      api: 'anthropic-messages',
      headers: {},
      apiKey: 'sk-ant',
    })
    assert.deepEqual(models, [{ id: 'claude-probe' }])
    const request = server.requests[0]
    assert.equal(request.url, '/v1/models?limit=1000')
    assert.equal(headerValue(request, 'anthropic-version'), '2023-06-01')
    assert.equal(headerValue(request, 'x-api-key'), 'sk-ant')
    assert.equal(headerValue(request, 'authorization'), undefined)
  } finally {
    await server.close()
  }
})

test('a route without a credential is probed unauthenticated', async () => {
  const server = await startMockServer()
  try {
    server.setResponder(jsonResponder({ data: [{ id: 'public-model' }] }))
    await probeModels({ baseURL: server.url, api: 'openai-responses', headers: {} })
    assert.equal(headerValue(server.requests[0], 'authorization'), undefined)
  } finally {
    await server.close()
  }
})

test('a refused or unreadable reply names the endpoint and the status', async () => {
  const server = await startMockServer()
  try {
    server.setResponder(jsonErrorResponder(401, { error: 'nope' }))
    await assert.rejects(
      probeModels({ baseURL: server.url, api: 'openai-responses', headers: {}, apiKey: 'bad' }),
      /answered 401; check the API key behind apiKeyEnv/,
    )

    server.setResponder(jsonResponder('<html>not json</html>'))
    await assert.rejects(
      probeModels({ baseURL: server.url, api: 'openai-responses', headers: {} }),
      /did not answer with JSON/,
    )
  } finally {
    await server.close()
  }
})

test('a base URL that is not an http endpoint is refused before any request', async () => {
  await assert.rejects(
    probeModels({ baseURL: 'not-a-url', api: 'openai-responses', headers: {} }),
    /is not an absolute URL/,
  )
  await assert.rejects(
    probeModels({ baseURL: 'file:///etc/passwd', api: 'openai-responses', headers: {} }),
    /is not an http or https endpoint/,
  )
})

/** A fake context whose LLM service records what the plugin registers. */
function fakeHost (credentials = {}) {
  const discoveries = new Map()
  const ctx = {
    get: (service) => service === 'credentials'
      ? { resolve: async (reference) => credentials[reference] === undefined ? undefined : { value: credentials[reference] } }
      : undefined,
    llm: {
      registerAdapter: () => () => {},
      registerModelDiscovery (settingsNs, discover) {
        discoveries.set(settingsNs, discover)
        return () => { discoveries.delete(settingsNs) }
      },
    },
    on: () => () => {},
    effect: (callback) => { callback(); return () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  return { ctx, discoveries }
}

test('the plugin answers discovery for its own settings namespace', async () => {
  const server = await startMockServer()
  try {
    server.setResponder(jsonResponder({ data: [{ id: 'relay-model', context_window: 131072 }] }))
    const { ctx, discoveries } = fakeHost({ RELAY_KEY: 'sk-stored' })
    apply(ctx, {
      providers: {
        relay: {
          displayName: 'Relay',
          api: 'openai-responses',
          baseURL: `${server.url}/v1`,
          apiKeyEnv: 'RELAY_KEY',
          headers: { 'User-Agent': 'claude-cli/2.1.301 (external, cli)' },
          models: [{ id: 'relay-model', input: ['text'] }],
        },
      },
    })
    assert.deepEqual([...discoveries.keys()], [SETTINGS_NAMESPACE])

    const models = await discoveries.get(SETTINGS_NAMESPACE)({ provider: 'relay' })
    assert.deepEqual(models, [{ id: 'relay-model', contextWindow: 131072 }])
    const request = server.requests[0]
    assert.equal(request.url, '/v1/models')
    assert.deepEqual(userAgentFields(request), [['User-Agent', 'claude-cli/2.1.301 (external, cli)']])
    assert.equal(headerValue(request, 'authorization'), 'Bearer sk-stored')
  } finally {
    await server.close()
  }
})

test('discovery of an unknown route names the route instead of guessing', async () => {
  const { ctx, discoveries } = fakeHost()
  apply(ctx, { providers: {} })
  await assert.rejects(
    discoveries.get(SETTINGS_NAMESPACE)({ provider: 'missing' }),
    /has no provider route "missing"/,
  )
})

test('discovery refuses overrides before resolving any saved credential', async () => {
  const { ctx, discoveries } = fakeHost()
  ctx.get = () => { throw new Error('must not resolve credentials') }
  apply(ctx, { providers: {} })
  for (const override of [{ baseURL: 'https://other.example' }, { api: 'openai-responses' }, { apiKey: 'secret' }]) {
    await assert.rejects(discoveries.get(SETTINGS_NAMESPACE)({ provider: 'relay', ...override }), /overrides are disabled/)
  }
})

test('discovery total timeout covers a stalled response body', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (_url, options) => new Response(new ReadableStream({
    start (controller) {
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true })
    },
  }))
  try {
    // AbortSignal.timeout does not keep Node alive by itself.
    const keepAlive = setInterval(() => {}, 100)
    try {
      await assert.rejects(probeModels({ baseURL: 'https://example.test', api: 'openai-responses', headers: {}, timeoutMs: 20 }), /timed out/)
    } finally { clearInterval(keepAlive) }
  } finally { globalThis.fetch = original }
})

test('discovery cancels rejected and oversized replies and forbids redirects', async () => {
  const original = globalThis.fetch
  try {
    for (const init of [{ status: 401 }, { headers: { 'content-length': '99999999' } }]) {
      let cancelled = false
      globalThis.fetch = async (_url, options) => {
        assert.equal(options.redirect, 'error')
        return new Response(new ReadableStream({ cancel () { cancelled = true } }), init)
      }
      await assert.rejects(probeModels({ baseURL: 'https://example.test', api: 'openai-responses', headers: {} }))
      assert.equal(cancelled, true)
    }
  } finally { globalThis.fetch = original }
})
