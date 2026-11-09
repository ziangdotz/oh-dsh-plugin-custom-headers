// Real-network smoke test: drive the shipped configuration through the plugin
// against the live provider, using the credential the Host itself would use.
//
// This is deliberately NOT part of `npm test`: it needs the network and a
// stored credential. It proves the route, protocol, credential and streaming
// path work against the real endpoint. It cannot prove what User-Agent the
// remote server received — no third-party endpoint echoes request headers back
// through an OpenAI/Anthropic-shaped SSE stream. That claim rests on the local
// wire test (`test/adapter-wire.test.mjs`), which reads the bytes the SDK sent.
//
// Usage: node tools/online-smoke.mjs [openai|anthropic]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const workspace = path.dirname(here)
const require = createRequire(pathToFileURL(path.join(workspace, 'package.json')))
const yaml = require('js-yaml')

const { createRouteAdapter, readProviders, resolveRoute } = await import(
  pathToFileURL(path.join(workspace, 'lib', 'index.js')).href
)
const { createUserMessage } = await import('@deepseek-ai/dsh-llm')

/** The stored credentials the Host's credentials service exposes as refs. */
function storedRefs () {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  const doc = yaml.load(fs.readFileSync(file, 'utf8'))
  return doc?.refs ?? {}
}

/** The provider routes from the bundle patch, exactly as installed. */
function shippedProviders () {
  const patch = yaml.load(fs.readFileSync(path.join(workspace, 'cordis.patch.yml'), 'utf8'))
  const config = patch[0].insert[0].config
  return readProviders({ providers: config.providers })
}

/** Resolve one credential without ever printing it. */
function apiKeyFor (reference, refs) {
  const value = refs[reference]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`credential ${reference} is not stored`)
  }
  return value
}

const only = process.argv[2]
const providers = shippedProviders()
const refs = storedRefs()

let failures = 0
for (const [provider, source] of Object.entries(providers)) {
  if (only === 'openai' && !provider.includes('openai')) continue
  if (only === 'anthropic' && !provider.includes('anthropic')) continue
  const route = resolveRoute(provider, source)
  const host = {
    resolveApiKey: async () => apiKeyFor(route.apiKeyEnv, refs),
    resolveAttachments: () => undefined,
    resolveImageAccess: () => undefined,
    onReplayDegrade: ({ reason }) => console.log(`  replay degrade: ${reason}`),
  }
  const adapter = createRouteAdapter(provider, route, host)
  const model = route.models[0].id
  const started = Date.now()
  let text = ''
  let finish
  const usage = {}
  try {
    for await (const chunk of adapter.stream({
      provider,
      model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Reply with exactly this token and nothing else: pong' }],
        source: { kind: 'user' },
      })],
      maxTokens: 32,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') Object.assign(usage, chunk.usage)
      else if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (error) {
    failures += 1
    console.log(`FAIL ${provider} / ${model} (${Date.now() - started}ms)`)
    console.log(`  ${error.code ?? ''} ${error.message}`)
    continue
  }
  const ok = finish?.kind === 'stop' && text.trim().length > 0
  if (!ok) failures += 1
  console.log(`${ok ? 'OK  ' : 'BAD '} ${provider} / ${model} (${Date.now() - started}ms)`)
  console.log(`  headers sent: ${Object.keys(route.headers).join(', ') || '(none)'}`)
  console.log(`  user-agent:   ${route.headers['User-Agent']}`)
  console.log(`  finish:       ${JSON.stringify(finish)}`)
  console.log(`  usage:        in=${usage.inputTokens ?? '?'} out=${usage.outputTokens ?? '?'}`)
  console.log(`  text:         ${JSON.stringify(text.slice(0, 120))}`)
}

process.exitCode = failures === 0 ? 0 : 1
