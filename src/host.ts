/**
 * The Host services this plugin consumes, and the two credential/image bridges
 * `PiAiAdapter` needs.
 *
 * Kept apart from the plugin entry so the adapter can be constructed in tests
 * with a plain object instead of a Cordis context.
 *
 * @module dsh-plugin-custom-headers/host
 */

import {
  assertUsableApiKey,
  launchEnvironmentOf,
  LlmError,
  resolveImageAttachmentAccess,
  type LlmDiscoveredModel,
  type LlmModelDiscoveryRequest,
} from './compat.js'
import type { ResolvedRoute } from './config.js'

/** The logging surface this plugin uses; every call is best-effort. */
export interface PluginLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
  debug?: (message: string) => void
}

/** The slice of a Cordis plugin context this plugin touches. */
export interface PluginContext {
  get (service: string): any
  on (event: string, listener: (...args: any[]) => void): unknown
  effect (callback: () => (() => void) | void): unknown
  logger: PluginLogger
  llm: {
    registerAdapter (providers: string[], adapter: unknown): (() => void)
    registerModelDiscovery (
      settingsNs: string,
      discover: (request: LlmModelDiscoveryRequest, signal?: AbortSignal) => Promise<readonly LlmDiscoveredModel[]>,
    ): () => void
  }
}

/** What the adapter needs from its host. */
export interface AdapterHost {
  resolveApiKey (provider: string, route: ResolvedRoute): Promise<string | undefined>
  resolveAttachments (): unknown
  resolveImageAccess (attachments: unknown, image: unknown): unknown
  onReplayDegrade (info: { provider: string, model: string, reason: string }): void
}

/** The adapter name used in credential diagnostics. */
const ADAPTER_NAME = 'dsh-plugin-custom-headers'

/**
 * Build the Host services for a live Cordis context.
 *
 * Credential resolution is the same two-step lookup the official adapter uses:
 * the Harness credential seam first (so a key stored through the Models page is
 * found), then the launch environment. This plugin never stores or logs a key.
 *
 * @param ctx - the plugin context.
 * @returns the host bridge handed to `PiAiAdapter`.
 */
export function createCordisHost (ctx: PluginContext): AdapterHost {
  return {
    async resolveApiKey (provider: string, route: ResolvedRoute): Promise<string | undefined> {
      const reference = route.apiKeyEnv
      if (reference === undefined) return undefined
      const credentials = ctx.get('credentials')
      const hit = credentials !== undefined
        ? (await credentials.resolve(reference))?.value
        : launchEnvironmentOf(ctx).get(reference)?.value
      if (typeof hit === 'string' && hit.length > 0) return assertUsableApiKey(hit, ADAPTER_NAME, reference)
      throw new LlmError(
        `dsh-plugin-custom-headers: no credential for provider route "${provider}"; its profile resolves ${reference}, which is not set — store ${reference} through the credentials service (the web Models page writes it) or export it, and remove apiKeyEnv only if this provider should be unauthenticated`,
        'MISSING_CREDENTIAL',
      )
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, image) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath: string) => ctx.get('fs')?.processPathFromHostPath(hostPath),
        image,
      ),
    onReplayDegrade: ({ provider, model, reason }) => {
      safeLog(ctx, 'warn', `dsh-plugin-custom-headers: unusable replay state on assistant history for route "${provider}/${model}"; sending that message as provider-neutral content (${reason})`)
    },
  }
}

/**
 * Log without ever letting logging break mounting.
 * @param ctx - the plugin context.
 * @param level - preferred logger level, falling back to `debug`.
 * @param message - the line to write.
 */
export function safeLog (ctx: { logger?: PluginLogger } | undefined, level: 'info' | 'warn' | 'error', message: string): void {
  const logger = ctx?.logger
  try {
    const write = logger?.[level] ?? logger?.debug
    write?.call(logger, message)
  } catch {
    /* A diagnostics sink must not take the plugin down with it. */
  }
}
