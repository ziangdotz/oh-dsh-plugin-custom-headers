// Test A (wire headers) and part of Test C (streaming, tools, cancellation,
// error propagation) against a local HTTP server, using the real
// `PiAiAdapter`, the real pi-ai protocol implementations and the real SDKs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRouteAdapter, resolveRoute } from '../lib/index.js'
import {
  anthropicMessagesBody,
  headerValue,
  jsonErrorResponder,
  openaiChatCompletionsBody,
  openaiResponsesBody,
  sseResponder,
  startMockServer,
  userAgentFields,
} from './mock-server.mjs'

const TARGET_UA = 'claude-cli/2.1.301 (external, cli)'

const host = {
  resolveApiKey: async () => 'test-key',
  resolveAttachments: () => undefined,
  resolveImageAccess: () => undefined,
  onReplayDegrade: () => {},
}

/** A harness user message. */
function userMessage (text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Drain one adapter stream into its chunks. */
async function drain (adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

/** Concatenated text deltas. */
function textOf (chunks) {
  return chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
}

/** The terminal chunk. */
function finishOf (chunks) {
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.ok(finish, 'stream yielded a finish chunk')
  return finish
}

/** The terminal reason's discriminator (`{ kind }`, or a plain string on older builds). */
function reasonKind (chunks) {
  const reason = finishOf(chunks).reason
  return typeof reason === 'string' ? reason : reason.kind
}

const OPENAI_PROVIDER = 'agentrouter-openai'
const OPENAI_MODEL = 'deepseek-v4-flash'
const ANTHROPIC_PROVIDER = 'agentrouter-anthropic'
const ANTHROPIC_MODEL = 'claude-opus-5-5'
const CHAT_PROVIDER = 'agentrouter-chat-test'
const CHAT_MODEL = 'deepseek-v4-flash'

/** The OpenAI route under test; `baseURL` points at the mock server. */
function openaiRoute (baseURL, headers = { 'User-Agent': TARGET_UA }) {
  return resolveRoute(OPENAI_PROVIDER, {
    api: 'openai-responses',
    baseURL: `${baseURL}/v1`,
    apiKeyEnv: 'AGENTROUTER_OPENAI_API_KEY',
    headers,
    models: [{
      id: OPENAI_MODEL,
      name: OPENAI_MODEL,
      input: ['text', 'image'],
      reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
    }],
  })
}

/** The Anthropic route under test; `baseURL` points at the mock server. */
function anthropicRoute (baseURL, headers = { 'User-Agent': TARGET_UA }) {
  return resolveRoute(ANTHROPIC_PROVIDER, {
    api: 'anthropic-messages',
    baseURL,
    apiKeyEnv: 'AGENTROUTER_ANTHROPIC_API_KEY',
    headers,
    models: [{
      id: ANTHROPIC_MODEL,
      name: ANTHROPIC_MODEL,
      contextWindow: 1000000,
      maxTokens: 128000,
      input: ['text', 'image'],
      reasoningEfforts: { off: null, minimal: 'low', high: 'high', max: 'max' },
    }],
  })
}

/** The OpenAI Chat Completions route under test; `baseURL` points at the mock server. */
function chatRoute (baseURL, headers = { 'User-Agent': TARGET_UA }) {
  return resolveRoute(CHAT_PROVIDER, {
    api: 'openai-completions',
    baseURL: `${baseURL}/v1`,
    apiKeyEnv: 'AGENTROUTER_CHAT_API_KEY',
    headers,
    models: [{
      id: CHAT_MODEL,
      name: CHAT_MODEL,
      contextWindow: 256000,
      maxTokens: 32000,
      input: ['text', 'image'],
    }],
  })
}

test('openai-completions: configured User-Agent reaches the wire exactly', async (t) => {
  const mock = await startMockServer({ responder: sseResponder(openaiChatCompletionsBody({ text: 'Hello' })) })
  t.after(() => mock.close())
  const adapter = createRouteAdapter(CHAT_PROVIDER, chatRoute(mock.url, {
    'User-Agent': TARGET_UA,
    'X-Deployment': 'agentrouter',
  }), host)

  const chunks = await drain(adapter, {
    provider: CHAT_PROVIDER,
    model: CHAT_MODEL,
    messages: [userMessage('hello')],
  })

  assert.equal(mock.requests.length, 1, 'one HTTP request reached the server')
  const request = mock.requests[0]
  assert.match(request.url, /^\/v1\/chat\/completions/, 'the official Chat Completions path is used')
  const agents = userAgentFields(request)
  assert.equal(agents.length, 1, `exactly one user-agent field, saw ${JSON.stringify(agents)}`)
  assert.equal(agents[0][1], TARGET_UA)
  assert.equal(headerValue(request, 'x-deployment'), 'agentrouter')
  assert.equal(headerValue(request, 'authorization'), 'Bearer test-key')
  assert.equal(textOf(chunks), 'Hello')
  assert.equal(reasonKind(chunks), 'stop')
})

test('openai-completions: tool calls survive the header wrapper', async (t) => {
  const mock = await startMockServer({
    responder: sseResponder(openaiChatCompletionsBody({
      toolCall: { name: 'get_weather', id: 'call_1', arguments: '{"city":"Paris"}' },
    })),
  })
  t.after(() => mock.close())
  const adapter = createRouteAdapter(CHAT_PROVIDER, chatRoute(mock.url), host)

  const chunks = await drain(adapter, {
    provider: CHAT_PROVIDER,
    model: CHAT_MODEL,
    messages: [userMessage('weather?')],
    tools: [{ name: 'get_weather', description: 'Weather lookup', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
  })

  const blockEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(blockEnd, 'a tool-call block ended')
  assert.equal(blockEnd.block.name, 'get_weather')
  assert.deepEqual(JSON.parse(blockEnd.block.arguments), { city: 'Paris' })
  assert.equal(reasonKind(chunks), 'tool-calls')
  assert.ok(mock.requests[0].body.includes('get_weather'), 'the tool schema reached the request body')
  assert.equal(userAgentFields(mock.requests[0]).length, 1, 'the configured header survives the tool path')
})

test('thinking effort still reaches the provider body (openai-completions)', async (t) => {
  const mock = await startMockServer({ responder: sseResponder(openaiChatCompletionsBody({ text: 'ok' })) })
  t.after(() => mock.close())
  const route = resolveRoute(CHAT_PROVIDER, {
    api: 'openai-completions',
    baseURL: `${mock.url}/v1`,
    apiKeyEnv: 'AGENTROUTER_CHAT_API_KEY',
    headers: { 'User-Agent': TARGET_UA },
    models: [{ id: CHAT_MODEL, reasoningEfforts: { off: null, high: 'xhigh' } }],
  })
  const adapter = createRouteAdapter(CHAT_PROVIDER, route, host)

  await drain(adapter, {
    provider: CHAT_PROVIDER,
    model: CHAT_MODEL,
    messages: [userMessage('think')],
    reasoningEffort: 'high',
  })

  const body = JSON.parse(mock.requests[0].body)
  assert.equal(body.model, CHAT_MODEL)
  assert.equal(body.reasoning_effort, 'xhigh', 'the configured wire spelling is what goes out')
  assert.equal(userAgentFields(mock.requests[0]).length, 1, 'the configured header was still sent')
})

test('openai-responses: configured User-Agent reaches the wire exactly', async (t) => {
  const mock = await startMockServer()
  t.after(() => mock.close())
  const adapter = createRouteAdapter(OPENAI_PROVIDER, openaiRoute(mock.url, {
    'User-Agent': TARGET_UA,
    'X-Deployment': 'agentrouter',
    'anthropic-beta': 'not-really',
  }), host)

  const chunks = await drain(adapter, {
    provider: OPENAI_PROVIDER,
    model: OPENAI_MODEL,
    messages: [userMessage('hello')],
  })

  assert.equal(mock.requests.length, 1, 'one HTTP request reached the server')
  const request = mock.requests[0]
  assert.match(request.url, /^\/v1\/responses/, 'the official OpenAI Responses path is used')

  const agents = userAgentFields(request)
  assert.equal(agents.length, 1, `exactly one user-agent field, saw ${JSON.stringify(agents)}`)
  assert.equal(agents[0][1], TARGET_UA)
  assert.equal(headerValue(request, 'x-deployment'), 'agentrouter')
  assert.equal(headerValue(request, 'anthropic-beta'), 'not-really')
  assert.equal(textOf(chunks), 'Hello')
  assert.equal(reasonKind(chunks), 'stop')
})

test('anthropic-messages: configured User-Agent reaches the wire exactly', async (t) => {
  const mock = await startMockServer({ responder: sseResponder(anthropicMessagesBody({ text: 'Hello' })) })
  t.after(() => mock.close())
  const adapter = createRouteAdapter(ANTHROPIC_PROVIDER, anthropicRoute(mock.url, {
    'user-agent': TARGET_UA,
    'X-Deployment': 'agentrouter',
  }), host)

  const chunks = await drain(adapter, {
    provider: ANTHROPIC_PROVIDER,
    model: ANTHROPIC_MODEL,
    messages: [userMessage('hello')],
  })

  assert.equal(mock.requests.length, 1)
  const request = mock.requests[0]
  assert.match(request.url, /^\/v1\/messages/, 'the official Anthropic Messages path is used')
  const agents = userAgentFields(request)
  assert.equal(agents.length, 1, `exactly one user-agent field, saw ${JSON.stringify(agents)}`)
  assert.equal(agents[0][1], TARGET_UA)
  assert.equal(headerValue(request, 'x-deployment'), 'agentrouter')
  assert.equal(headerValue(request, 'x-api-key'), 'test-key')
  assert.equal(textOf(chunks), 'Hello')
  assert.equal(reasonKind(chunks), 'stop')
})

test('configured headers win case-insensitively and never duplicate a field', async (t) => {
  const mock = await startMockServer()
  t.after(() => mock.close())
  // The harness sends its own `user-agent`; the configuration spells the same
  // field differently on purpose, plus a second, differently-cased variant.
  const adapter = createRouteAdapter(OPENAI_PROVIDER, openaiRoute(mock.url, {
    'USER-AGENT': TARGET_UA,
    'user-agent': TARGET_UA,
    'X-Custom': 'one',
    'x-custom': 'two',
  }), host)

  await drain(adapter, { provider: OPENAI_PROVIDER, model: OPENAI_MODEL, messages: [userMessage('hi')] })

  const request = mock.requests[0]
  const agents = userAgentFields(request)
  assert.equal(agents.length, 1, 'one user-agent field survives')
  assert.equal(agents[0][1], TARGET_UA)
  const customs = request.rawHeaders.filter(([name]) => name.toLowerCase() === 'x-custom')
  assert.equal(customs.length, 1, 'one x-custom field survives')
  assert.equal(customs[0][1], 'two', 'the last configured value wins')
})

test('without configured headers the harness attribution is preserved', async (t) => {
  const mock = await startMockServer()
  t.after(() => mock.close())
  const adapter = createRouteAdapter(OPENAI_PROVIDER, openaiRoute(mock.url, {}), host)

  await drain(adapter, { provider: OPENAI_PROVIDER, model: OPENAI_MODEL, messages: [userMessage('hi')] })

  const agents = userAgentFields(mock.requests[0])
  assert.equal(agents.length, 1)
  assert.match(agents[0][1], /^deepseek-harness\//, `expected the harness attribution, saw ${agents[0][1]}`)
})

test('openai-responses: tool calls survive the header wrapper', async (t) => {
  const mock = await startMockServer({
    responder: sseResponder(openaiResponsesBody({
      toolCall: { name: 'get_weather', id: 'call_1', arguments: '{"city":"Paris"}' },
      usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
    })),
  })
  t.after(() => mock.close())
  const adapter = createRouteAdapter(OPENAI_PROVIDER, openaiRoute(mock.url), host)

  const chunks = await drain(adapter, {
    provider: OPENAI_PROVIDER,
    model: OPENAI_MODEL,
    messages: [userMessage('weather?')],
    tools: [{ name: 'get_weather', description: 'Weather lookup', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
  })

  const blockEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(blockEnd, 'a tool-call block ended')
  assert.equal(blockEnd.block.name, 'get_weather')
  assert.deepEqual(JSON.parse(blockEnd.block.arguments), { city: 'Paris' })
  assert.equal(reasonKind(chunks), 'tool-calls')
  assert.ok(mock.requests[0].body.includes('get_weather'), 'the tool schema reached the request body')
})

test('anthropic-messages: tool calls survive the header wrapper', async (t) => {
  const mock = await startMockServer({
    responder: sseResponder(anthropicMessagesBody({
      toolCall: { name: 'get_weather', id: 'toolu_1', arguments: '{"city":"Paris"}' },
    })),
  })
  t.after(() => mock.close())
  const adapter = createRouteAdapter(ANTHROPIC_PROVIDER, anthropicRoute(mock.url), host)

  const chunks = await drain(adapter, {
    provider: ANTHROPIC_PROVIDER,
    model: ANTHROPIC_MODEL,
    messages: [userMessage('weather?')],
    tools: [{ name: 'get_weather', description: 'Weather lookup', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
  })

  const blockEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(blockEnd, 'a tool-call block ended')
  assert.equal(blockEnd.block.name, 'get_weather')
  assert.deepEqual(JSON.parse(blockEnd.block.arguments), { city: 'Paris' })
  assert.equal(reasonKind(chunks), 'tool-calls')
})

test('an aborted caller signal stops the stream', async (t) => {
  const mock = await startMockServer({
    responder: (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      // Send a real start and one delta, then hold the connection open. Only
      // the caller's abort can end this stream.
      const frames = openaiResponsesBody({ text: 'partial' })
      for (const frameText of frames.slice(0, 2)) res.write(frameText)
      res.on('close', () => res.end())
    },
  })
  t.after(() => mock.close())
  const adapter = createRouteAdapter(OPENAI_PROVIDER, openaiRoute(mock.url), host)
  const controller = new AbortController()

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: OPENAI_PROVIDER,
    model: OPENAI_MODEL,
    messages: [userMessage('hi')],
    signal: controller.signal,
  })) {
    chunks.push(chunk)
    if (chunk.type === 'block-start') controller.abort()
  }

  // pi-ai reports a caller abort as a terminal error event, which the harness
  // adapter maps to an `aborted` finish rather than a thrown LlmError.
  assert.equal(reasonKind(chunks), 'aborted')
  const finish = finishOf(chunks)
  assert.ok(finish.replayState === undefined || typeof finish.replayState === 'object')
})

test('a provider HTTP error surfaces as an error finish', async (t) => {
  const mock = await startMockServer({
    responder: jsonErrorResponder(401, { error: { message: 'invalid api key', type: 'authentication_error' } }),
  })
  t.after(() => mock.close())
  const adapter = createRouteAdapter(ANTHROPIC_PROVIDER, anthropicRoute(mock.url), host)

  const chunks = await drain(adapter, {
    provider: ANTHROPIC_PROVIDER,
    model: ANTHROPIC_MODEL,
    messages: [userMessage('hi')],
  })

  const finish = finishOf(chunks)
  assert.equal(reasonKind(chunks), 'error')
  assert.equal(finish.reason.failure.code, 'AUTH', 'the provider status maps to the harness AUTH code')
  assert.equal(userAgentFields(mock.requests[0]).length, 1, 'the configured header was still sent')
})

test('model capabilities survive the wrapper (context, modalities, reasoning levels)', async (t) => {
  const mock = await startMockServer()
  t.after(() => mock.close())
  const adapter = createRouteAdapter(ANTHROPIC_PROVIDER, anthropicRoute(mock.url), host)
  const info = await adapter.resolveModel(ANTHROPIC_PROVIDER, ANTHROPIC_MODEL)
  assert.equal(info.provider, ANTHROPIC_PROVIDER)
  assert.equal(info.id, ANTHROPIC_MODEL)
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  assert.equal(info.context.contextWindow, 1000000)
  assert.equal(info.defaultMaxTokens, 128000)
  const efforts = info.reasoning.efforts.map((entry) => entry.id)
  assert.deepEqual(efforts, ['off', 'minimal', 'high', 'max'])
  assert.equal(info.reasoning.defaultEffort, undefined, 'no route-level default effort is configured')
})

test('thinking effort still reaches the provider body (openai-responses)', async (t) => {
  const mock = await startMockServer()
  t.after(() => mock.close())
  const adapter = createRouteAdapter(OPENAI_PROVIDER, openaiRoute(mock.url), host)
  await drain(adapter, {
    provider: OPENAI_PROVIDER,
    model: OPENAI_MODEL,
    messages: [userMessage('think')],
    reasoningEffort: 'high',
  })
  const body = JSON.parse(mock.requests[0].body)
  assert.equal(body.model, OPENAI_MODEL)
  assert.equal(body.reasoning.effort, 'high')
})

test('thinking effort still reaches the provider body (anthropic-messages)', async (t) => {
  const mock = await startMockServer({ responder: sseResponder(anthropicMessagesBody({ text: 'ok' })) })
  t.after(() => mock.close())
  const adapter = createRouteAdapter(ANTHROPIC_PROVIDER, anthropicRoute(mock.url), host)
  await drain(adapter, {
    provider: ANTHROPIC_PROVIDER,
    model: ANTHROPIC_MODEL,
    messages: [userMessage('think')],
    reasoningEffort: 'high',
  })
  const body = JSON.parse(mock.requests[0].body)
  assert.equal(body.model, ANTHROPIC_MODEL)
  assert.equal(body.thinking.type, 'enabled')
  assert.ok(body.thinking.budget_tokens > 0)
})