/**
 * Configuration schema and route resolution.
 *
 * The schema deliberately mirrors the official `llm-pi-ai` profile vocabulary
 * (`api`, `baseURL`, `apiKeyEnv`, `headers`, `models`, `reasoning`, ...) so a
 * route can be moved between the two plugins without translation, and so the
 * Config renderer in the Harness GUI describes the same fields people already
 * know. Resolution is stricter than the official adapter only where it must
 * be: this plugin has no installed pi-ai catalog behind it, so every model is
 * described by the configuration itself.
 *
 * @module dsh-plugin-custom-headers/config
 */

import { resolveRetryPolicy, RetryPolicySchema, z } from './compat.js'
import { assertValidHeaders, type HeaderRecord } from './headers.js'
import {
  createRouteProvider,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  isSupportedProtocol,
  MODALITIES,
  resolveModels,
  SUPPORTED_PROTOCOLS,
  THINKING_LEVELS,
  type PiChatModel,
  type SupportedProtocol,
  type ThinkingLevel,
} from './models.js'

/** Mark a configuration failure as this plugin's, so `apply` can log it alone. */
export class RouteConfigError extends Error {
  override readonly name = 'RouteConfigError'
}

/** Default idle bound while a provider stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000

/** Default caps for a request-borne image; identical to `llm-pi-ai`. */
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20971520
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4194304
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1048576

/** Configured reasoning efforts: level to wire spelling, or ull to leave it to the protocol. */
const reasoningEfforts = z.dict(
  z.union([z.string(), z.const(null)]),
  z.union([...THINKING_LEVELS]),
)

/** One model entry. */
const modelProfile = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union([...MODALITIES])),
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
})

/** One provider route. `displayName` is accepted for older profiles but resolved as the route id. */
export const providerProfile = z.object({
  displayName: z.string(),
  api: z.string(),
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  headers: z.dict(z.string()),
  models: z.array(modelProfile),
  reasoning: z.union([...THINKING_LEVELS]),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE),
  maxRequestImageBytes: z.number().step(1).min(1),
  requestImagePixelBudget: z.number().step(1).min(1),
  requestImageMaxBytes: z.number().step(1).min(1),
  retryPolicy: RetryPolicySchema,
})

/** Plugin configuration: a dictionary of provider routes, live-updatable as a whole. */
export const Config = z.object({
  providers: z.dict(providerProfile).default({}).volatile(),
})

/** One resolved provider route, in the shape `PiAiAdapter` consumes. */
export interface ResolvedRoute {
  provider: string
  displayName: string
  api: SupportedProtocol
  baseURL: string
  apiKeyEnv?: string
  headers: HeaderRecord
  reasoning?: ThinkingLevel
  streamIdleTimeoutMs: number
  maxRequestImageBytes: number
  requestImagePixelBudget: number
  requestImageMaxBytes: number
  retryPolicy: unknown
  configuredMaxTokens: Map<string, number>
  /** Configured model entries that were rejected, keyed by entry id. */
  modelErrors: Map<string, string>
  models: PiChatModel[]
  /** The pi-ai provider whose request options carry the configured headers. */
  piProvider: unknown
}

/** The raw configuration as the Loader hands it over. */
export type RawConfig = { providers?: unknown } | undefined

/**
 * Read the current provider dictionary out of a (possibly volatile) config.
 * @param config - plugin configuration.
 * @returns the provider dictionary, or an empty object.
 */
export function readProviders (config: RawConfig): Record<string, unknown> {
  const declared = config?.providers
  const value = typeof (declared as { get?: unknown })?.get === 'function'
    ? (declared as { get: () => unknown }).get()
    : declared
  return (value as Record<string, unknown> | undefined) ?? {}
}

/** A stable text form of the provider dictionary, for change detection. */
export function providersFingerprint (providers: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(providers).sort(([left], [right]) => left.localeCompare(right)))
  return JSON.stringify(sorted)
}

/** Read one field as a non-empty string, treating schemastery's `''` default as absent. */
function text (value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read one field as a positive integer with a fallback. */
function positiveInteger (value: unknown, fallback: number, detail: string): number {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RouteConfigError(`dsh-plugin-custom-headers: ${detail} must be a positive integer`)
  }
  return value
}

/**
 * Resolve one provider entry.
 * @param provider - the route name (dictionary key).
 * @param source - the configured entry.
 * @returns the route PiAiAdapter will serve.
 * @throws {RouteConfigError} naming the route and the field at fault.
 */
export function resolveRoute (provider: string, source: unknown): ResolvedRoute {
  if (provider.length === 0) throw new RouteConfigError('dsh-plugin-custom-headers: provider names must be non-empty')
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new RouteConfigError(`dsh-plugin-custom-headers: provider "${provider}" must be a mapping of profile fields`)
  }
  const entry = source as Record<string, unknown>
  const api = entry.api
  if (api === undefined || api === '' || api === null) {
    throw new RouteConfigError(`dsh-plugin-custom-headers: provider "${provider}" needs an "api"; supported protocols are ${SUPPORTED_PROTOCOLS.join(', ')}`)
  }
  if (!isSupportedProtocol(api)) {
    throw new RouteConfigError(`dsh-plugin-custom-headers: provider "${provider}" names api "${String(api)}", which this plugin cannot serve; supported protocols are ${SUPPORTED_PROTOCOLS.join(', ')}`)
  }
  const baseURL = text(entry.baseURL)
  if (baseURL === undefined) {
    throw new RouteConfigError(`dsh-plugin-custom-headers: provider "${provider}" needs a "baseURL"`)
  }
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new RouteConfigError(`dsh-plugin-custom-headers: provider "${provider}" baseURL "${baseURL}" is not an absolute URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new RouteConfigError(`dsh-plugin-custom-headers: provider "${provider}" baseURL must use http or https`)
  }
  // The route id is the single display identity: the settings page shows it in
  // both the card title and the display-name field. Older profiles may still
  // carry a friendly displayName; ignoring it keeps the model picker and auth
  // labels consistent even before the next save rewrites that field.
  const displayName = provider
  const headers = { ...(entry.headers as HeaderRecord | undefined ?? {}) }
  assertValidHeaders(provider, headers)
  const models = Array.isArray(entry.models) ? entry.models : []
  if (models.length === 0) {
    throw new RouteConfigError(`dsh-plugin-custom-headers: provider "${provider}" resolves no models; list every model this route serves in "models"`)
  }
  const reasoning = entry.reasoning
  if (reasoning !== undefined && reasoning !== '' && reasoning !== null && !(THINKING_LEVELS as readonly unknown[]).includes(reasoning)) {
    throw new RouteConfigError(`dsh-plugin-custom-headers: provider "${provider}" reasoning must be one of ${THINKING_LEVELS.join(', ')}`)
  }
  const configuredMaxTokens = new Map<string, number>()
  for (const model of models) {
    const declared = (model as { maxTokens?: unknown })?.maxTokens
    const id = (model as { id?: unknown })?.id
    if (typeof id === 'string' && typeof declared === 'number') configuredMaxTokens.set(id, declared)
  }
  const materialized = resolveModels(provider, api, models as never, baseURL)
  const route: ResolvedRoute = {
    provider,
    displayName,
    api,
    baseURL,
    ...text(entry.apiKeyEnv) === undefined ? {} : { apiKeyEnv: text(entry.apiKeyEnv) as string },
    headers,
    ...reasoning === undefined || reasoning === '' || reasoning === null ? {} : { reasoning: reasoning as ThinkingLevel },
    streamIdleTimeoutMs: positiveInteger(entry.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS, `provider "${provider}" streamIdleTimeoutMs`),
    maxRequestImageBytes: positiveInteger(entry.maxRequestImageBytes, DEFAULT_MAX_REQUEST_IMAGE_BYTES, `provider "${provider}" maxRequestImageBytes`),
    requestImagePixelBudget: positiveInteger(entry.requestImagePixelBudget, DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET, `provider "${provider}" requestImagePixelBudget`),
    requestImageMaxBytes: positiveInteger(entry.requestImageMaxBytes, DEFAULT_REQUEST_IMAGE_MAX_BYTES, `provider "${provider}" requestImageMaxBytes`),
    retryPolicy: resolveRetryPolicy(entry.retryPolicy, `dsh-plugin-custom-headers: provider "${provider}" retryPolicy`),
    configuredMaxTokens,
    modelErrors: materialized.errors,
    models: materialized.models,
    piProvider: undefined,
  }
  route.piProvider = createRouteProvider({
    provider,
    displayName,
    baseURL,
    api,
    models: materialized.models,
    headers,
  })
  return route
}

/**
 * Resolve every configured route.
 * @param providers - the provider dictionary.
 * @returns routes in configuration order.
 * @throws {RouteConfigError} naming the first route that cannot be served.
 */
export function resolveRoutes (providers: Record<string, unknown>): Map<string, ResolvedRoute> {
  const routes = new Map<string, ResolvedRoute>()
  for (const [provider, source] of Object.entries(providers)) routes.set(provider, resolveRoute(provider, source))
  return routes
}

export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS }
