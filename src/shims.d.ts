/**
 * Ambient types for the modules this plugin consumes.
 *
 * The installed DSH build ships bundled `lib/index.js` files without their
 * declaration files, and `@earendil-works/pi-ai` ships `dist` without
 * declarations, so the exact contracts are read from that compiled source
 * instead (see README "Sources read"). These declarations describe only
 * the symbols this plugin actually imports; they are intentionally loose at
 * the boundary and precise where this plugin itself depends on a shape.
 */

declare module '@deepseek-ai/schemastery' {
  const z: any
  export default z
}

declare module '@deepseek-ai/dsh-llm-pi-ai' {
  export class PiAiAdapter {
    constructor (config: {
      profiles: () => Map<string, unknown>
      resolveApiKey: (provider: string, profile: unknown) => Promise<string | undefined>
      auth: unknown
      resolveAttachments?: () => unknown
      resolveImageAccess?: (attachments: unknown, image: unknown) => unknown
      onReplayDegrade?: (info: { provider: string, model: string, reason: string }) => void
    })
    readonly config: unknown
    stream (options: unknown): AsyncIterable<unknown>
    [key: string]: unknown
  }
}

declare module '@deepseek-ai/dsh-llm' {
  export class LlmError extends Error {
    constructor (message: string, code: string, options?: { cause?: unknown })
    readonly code: string
  }
  export function assertUsableApiKey (value: string, adapter: string, reference: string): string
  export function resolveRetryPolicy (policy: unknown, label: string): unknown
  export const RetryPolicySchema: any
  export function resolveImageAttachmentAccess (
    attachments: unknown,
    processHostPath: (hostPath: string) => string | undefined,
    ref: unknown,
  ): unknown
  export function ReasoningEffortId (level: string): string
  /** The harness's own identity headers; discovery sends them where a route sets none. */
  export function attributionHeaders (identity?: unknown): Record<string, string>
  /** One draft-provider interrogation request, as the Models page issues it. */
  export interface LlmModelDiscoveryRequest {
    provider?: string
    baseURL?: string
    api?: string
    apiKey?: string
  }
  /** One model an endpoint reports about itself. */
  export interface LlmDiscoveredModel {
    id: string
    name?: string
    contextWindow?: number
    maxTokens?: number
    inputModalities?: readonly ('text' | 'image')[]
  }
}

declare module '@deepseek-ai/dsh-launch-environment' {
  export function launchEnvironmentOf (ctx: unknown): { get (name: string): { value?: string } | undefined }
}

declare module '@earendil-works/pi-ai/models' {
  export function createProvider (input: any): any
}

declare module '@earendil-works/pi-ai/api/openai-completions.lazy' {
  export function openAICompletionsApi (): any
}

declare module '@earendil-works/pi-ai/api/openai-responses.lazy' {
  export function openAIResponsesApi (): any
}

declare module '@earendil-works/pi-ai/api/anthropic-messages.lazy' {
  export function anthropicMessagesApi (): any
}
