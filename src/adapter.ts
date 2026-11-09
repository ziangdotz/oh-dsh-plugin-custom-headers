/**
 * The adapter instance.
 *
 * Everything about streaming, tool calls, reasoning dispatch, image handling,
 * cancellation and idle timeouts is the official `PiAiAdapter`. This module
 * only supplies it with routes the plugin resolved itself, which is what lets
 * the route's provider carry the configured headers at the pi-ai boundary.
 *
 * @module dsh-plugin-custom-headers/adapter
 */

import { PiAiAdapter } from './compat.js'
import type { ResolvedRoute } from './config.js'
import type { AdapterHost } from './host.js'

/**
 * Create the adapter for one route.
 *
 * The `profiles` map is created once and returned by identity on every call,
 * which is what lets `PiAiAdapter` recognize an unchanged configuration and
 * reuse its `Models` collection instead of rebuilding one per request.
 *
 * @param provider - the route name this adapter serves.
 * @param route - the resolved route.
 * @param host - Host services (credentials, attachments, diagnostics).
 * @returns the official pi-ai adapter, configured for this route.
 */
export function createRouteAdapter (provider: string, route: ResolvedRoute, host: AdapterHost): PiAiAdapter {
  const profiles = new Map<string, unknown>([[provider, route]])
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: (name: string, profile: unknown) => host.resolveApiKey(name, profile as ResolvedRoute),
    // This plugin resolves credentials through the harness seam before pi-ai
    // sees the request, so the collection needs no credential store of its own;
    // OAuth-only providers are out of scope and documented as such.
    auth: {},
    resolveAttachments: () => host.resolveAttachments(),
    resolveImageAccess: (attachments: unknown, image: unknown) => host.resolveImageAccess(attachments, image),
    onReplayDegrade: (info: { provider: string, model: string, reason: string }) => host.onReplayDegrade(info),
  })
}
