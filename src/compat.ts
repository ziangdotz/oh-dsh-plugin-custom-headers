/**
 * The single import boundary between this plugin and the DSH / pi-ai runtime.
 *
 * Everything the plugin consumes from the host is re-exported here, so a DSH
 * upgrade that renames a module, moves a symbol, or changes a signature is a
 * one-file change: adjust this module first, then let the compiler point at the
 * call sites. The rest of `src/` imports only from `./compat.js`.
 *
 * `checkCompat()` goes one step further and verifies that the loaded values
 * still have the shapes this plugin relies on. It cannot see inside
 * `PiAiAdapter` (which owns the `profile.piProvider` seam), so the static
 * `tools/compat-check.mjs` report and the test suite cover that part.
 *
 * @module dsh-plugin-custom-headers/compat
 */

import z from '@deepseek-ai/schemastery'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  assertUsableApiKey,
  attributionHeaders,
  LlmError,
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
  RetryPolicySchema,
} from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'

export {
  anthropicMessagesApi,
  assertUsableApiKey,
  attributionHeaders,
  createProvider,
  launchEnvironmentOf,
  LlmError,
  openAICompletionsApi,
  openAIResponsesApi,
  PiAiAdapter,
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
  RetryPolicySchema,
  z,
}

export type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'

/** One blocking compatibility problem found at load time. */
export interface CompatFatal {
  point: string
  detail: string
}

/** The shape probe's result. Fatal problems stop route registration. */
export interface CompatReport {
  fatal: CompatFatal[]
  warnings: CompatFatal[]
}

/** Human-readable names for the seams this plugin depends on. */
export const COMPAT_POINTS = [
  'PiAiAdapter class',
  'pi-ai createProvider',
  'pi-ai protocol factories',
  'schemastery Config schema',
  'dsh-llm retry policy',
  'dsh-llm attribution headers',
  'dsh-llm credential validation',
  'dsh-llm image access',
  'launch environment lookup',
] as const

/**
 * Verify that the symbols imported from the host still exist with the shapes
 * this plugin calls. An import that disappeared entirely fails at module load;
 * this catches a value that loaded but is no longer callable.
 * @returns blocking problems and non-blocking warnings.
 */
export function checkCompat (): CompatReport {
  const fatal: CompatFatal[] = []
  const warnings: CompatFatal[] = []
  const functionAt = (target: CompatFatal[], point: string, value: unknown): void => {
    if (typeof value !== 'function') target.push({ point, detail: 'is no longer a function' })
  }

  functionAt(fatal, 'PiAiAdapter class', PiAiAdapter)
  functionAt(fatal, 'pi-ai createProvider', createProvider)
  functionAt(fatal, 'pi-ai openai-completions factory', openAICompletionsApi)
  functionAt(fatal, 'pi-ai openai-responses factory', openAIResponsesApi)
  functionAt(fatal, 'pi-ai anthropic-messages factory', anthropicMessagesApi)
  functionAt(fatal, 'schemastery z.object', z?.object)
  functionAt(fatal, 'dsh-llm resolveRetryPolicy', resolveRetryPolicy)
  if (RetryPolicySchema === undefined || RetryPolicySchema === null) {
    fatal.push({ point: 'dsh-llm RetryPolicySchema', detail: 'is missing' })
  }

  functionAt(warnings, 'dsh-llm attributionHeaders', attributionHeaders)
  functionAt(warnings, 'dsh-llm assertUsableApiKey', assertUsableApiKey)
  functionAt(warnings, 'dsh-llm resolveImageAttachmentAccess', resolveImageAttachmentAccess)
  functionAt(warnings, 'launch environment lookup', launchEnvironmentOf)
  if (typeof LlmError !== 'function') {
    warnings.push({ point: 'dsh-llm LlmError', detail: 'is no longer a constructor' })
  }

  return { fatal, warnings }
}
