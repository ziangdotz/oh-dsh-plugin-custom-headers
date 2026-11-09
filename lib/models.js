/**
 * pi-ai model descriptors and the header-injecting provider.
 *
 * This module is where a configured route becomes something pi-ai can stream:
 * one `Model` per configured entry, wrapped in one `Provider` whose `stream`
 * and `streamSimple` add the configured headers to the request options right
 * before pi-ai's protocol implementation builds its SDK client.
 *
 * Why the provider boundary and not `profile.headers`: the harness adapter's
 * `requestHeaders()` deletes every deployment header that collides
 * case-insensitively with its own attribution header and then re-adds
 * `user-agent`. Headers handed to the provider arrive *after* that merge, and
 * pi-ai's own contract is that the headers in the request options win
 * ("Merge options headers last so they can override defaults" — see
 * `pi-ai/dist/api/openai-completions.js#createClient`,
 * `pi-ai/dist/api/openai-responses.js#createClient` and
 * `api/anthropic-messages.js#mergeClientHeaders`). Injecting here keeps every
 * protocol implementation, retry, timeout, tool-call and image path official.
 *
 * @module dsh-plugin-custom-headers/models
 */
import { anthropicMessagesApi, createProvider, openAICompletionsApi, openAIResponsesApi, } from './compat.js';
import { mergeHeadersCaseInsensitive } from './headers.js';
/** Wire protocols this plugin can serve: the three pi-ai protocols a hand-declared route uses in practice. */
export const SUPPORTED_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
/** Every pi-ai thinking level a route may declare, in escalation order. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Request modalities a model entry may declare. */
export const MODALITIES = ['text', 'image'];
/** Default context window when a model entry names none; matches `llm-pi-ai`. */
export const DEFAULT_CONTEXT_WINDOW = 262144;
/** Default output cap when a model entry names none; matches `llm-pi-ai`. */
export const DEFAULT_MAX_TOKENS = 32768;
/** Pricing for a gateway model: this plugin never bills, so every rate is zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/**
 * The protocol implementations a route may name.
 *
 * All three are pi-ai's own factories, loaded lazily exactly as the official
 * adapter loads them, so a hand-declared route reaches the same streaming code
 * a catalog route would.
 */
const PROTOCOL_FACTORIES = {
    'openai-completions': openAICompletionsApi,
    'openai-responses': openAIResponsesApi,
    'anthropic-messages': anthropicMessagesApi,
};
/**
 * Whether a value names a protocol this plugin serves.
 * @param value - candidate protocol id.
 * @returns true when the protocol is supported.
 */
export function isSupportedProtocol(value) {
    return typeof value === 'string' && SUPPORTED_PROTOCOLS.includes(value);
}
/**
 * Resolve one model's reasoning capability from its declared efforts.
 *
 * Mirrors `llm-pi-ai`'s rule, which exists because pi-ai's defaulting is
 * asymmetric: a declared level carries its wire spelling, an undeclared level
 * is pinned to `null` (unsupported) except a declared `off` with no value,
 * which stays absent so "not thinking" dispatches as the parameter's absence.
 *
 * @param label - provider route, for diagnostics.
 * @param entry - the configured model entry.
 * @returns the reasoning fields the materialized model carries.
 */
export function resolveModelReasoning(label, entry) {
    const efforts = entry.reasoningEfforts;
    if (efforts === undefined || efforts === false)
        return { reasoning: false };
    if (Object.keys(efforts).length === 0) {
        throw new Error(`dsh-plugin-custom-headers: provider "${label}" model "${entry.id}" has an empty reasoningEfforts; declare the offered levels, set false for a non-reasoning model, or omit the field`);
    }
    const declared = THINKING_LEVELS.flatMap((level) => {
        const wire = efforts[level];
        return wire === undefined ? [] : [[level, wire]];
    });
    for (const [level, wire] of declared) {
        if (wire === null) {
            if (level !== 'off') {
                throw new Error(`dsh-plugin-custom-headers: provider "${label}" model "${entry.id}" reasoningEfforts.${level} needs the wire value dispatch should send; only "off" may leave it empty`);
            }
        }
        else if (wire !== undefined && wire.length === 0) {
            throw new Error(`dsh-plugin-custom-headers: provider "${label}" model "${entry.id}" reasoningEfforts.${level} must not be an empty string`);
        }
    }
    if (!declared.some(([level]) => level !== 'off')) {
        throw new Error(`dsh-plugin-custom-headers: provider "${label}" model "${entry.id}" reasoningEfforts offers no level beyond "off"; declare a thinking level, or set reasoningEfforts to false for a non-reasoning model`);
    }
    const thinkingLevelMap = {};
    for (const level of THINKING_LEVELS) {
        const wire = efforts[level];
        if (wire === undefined)
            thinkingLevelMap[level] = null;
        else if (wire !== null)
            thinkingLevelMap[level] = wire;
    }
    return { reasoning: true, thinkingLevelMap };
}
/**
 * Selectable thinking levels for one model, in pi-ai's order.
 * @param model - the materialized model.
 * @returns the levels this model can actually dispatch.
 */
export function getSupportedThinkingLevels(model) {
    if (!model.reasoning)
        return ['off'];
    return THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null)
            return false;
        if (level === 'xhigh' || level === 'max')
            return mapped !== undefined;
        return true;
    });
}
/**
 * Materialize the models one route serves.
 *
 * A rejected entry is reported instead of thrown, so one bad model in a long
 * list cannot take the whole route down; the route fails only when nothing is
 * left to serve.
 *
 * @param label - provider route, for diagnostics.
 * @param api - the route's wire protocol.
 * @param entries - configured model entries.
 * @param baseURL - the route's endpoint, embedded in each model descriptor.
 * @returns the servable models in configuration order and the rejected entries.
 * @throws Error when no entry can be served.
 */
export function resolveModels(label, api, entries, baseURL) {
    const seen = new Set();
    const models = [];
    const errors = new Map();
    for (const [position, entry] of entries.entries()) {
        const name = typeof entry?.id === 'string' && entry.id.length > 0 ? entry.id : `#${position + 1}`;
        try {
            if (typeof entry?.id !== 'string' || entry.id.length === 0) {
                throw new Error(`dsh-plugin-custom-headers: provider "${label}" has a model with an empty id`);
            }
            if (seen.has(entry.id)) {
                throw new Error(`dsh-plugin-custom-headers: provider "${label}" lists model "${entry.id}" more than once`);
            }
            const contextWindow = entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
            const maxTokens = entry.maxTokens ?? DEFAULT_MAX_TOKENS;
            if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
                throw new Error(`dsh-plugin-custom-headers: provider "${label}" model "${entry.id}" contextWindow must be a positive integer`);
            }
            if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
                throw new Error(`dsh-plugin-custom-headers: provider "${label}" model "${entry.id}" maxTokens must be a positive integer`);
            }
            const input = (entry.input ?? []).length > 0 ? [...(entry.input ?? [])] : ['text'];
            for (const modality of input) {
                if (!MODALITIES.includes(modality)) {
                    throw new Error(`dsh-plugin-custom-headers: provider "${label}" model "${entry.id}" declares input "${modality}"; the supported modalities are ${MODALITIES.join(', ')}`);
                }
            }
            const reasoning = resolveModelReasoning(label, entry);
            seen.add(entry.id);
            models.push({
                id: entry.id,
                name: entry.name !== undefined && entry.name.length > 0 ? entry.name : entry.id,
                api,
                provider: label,
                baseUrl: baseURL,
                input,
                cost: NO_COST,
                contextWindow,
                maxTokens,
                ...reasoning,
            });
        }
        catch (error) {
            errors.set(name, error instanceof Error ? error.message : String(error));
        }
    }
    if (models.length === 0) {
        const detail = [...errors.values()].join('; ');
        throw new Error(`dsh-plugin-custom-headers: provider "${label}" resolves no usable model${detail.length === 0 ? '' : `: ${detail}`}`);
    }
    return { models, errors };
}
/**
 * Attach configured headers to the request options pi-ai is about to dispatch.
 *
 * `options.headers` already holds the credential plane's headers and the
 * harness attribution header by this point, so this is the last merge before
 * the protocol implementation builds its client: the configured value wins,
 * and no case-variant of the same field survives.
 *
 * @param options - pi-ai stream options, when the caller passed any.
 * @param headers - configured deployment headers.
 * @returns options carrying the merged header bag.
 */
export function withConfiguredHeaders(options, headers) {
    if (Object.keys(headers).length === 0)
        return options;
    const current = (options ?? {});
    return { ...(options ?? {}), headers: mergeHeadersCaseInsensitive(current.headers, headers) };
}
/**
 * Build the pi-ai provider for one configured route.
 *
 * The provider delegates every operation to pi-ai's own protocol
 * implementation; only the header bag of `stream`/`streamSimple` is adjusted.
 *
 * @param input - the route facts and the headers to force.
 * @returns a pi-ai `Provider` for the single `Models` collection.
 */
export function createRouteProvider(input) {
    const provider = createProvider({
        id: input.provider,
        name: input.displayName,
        baseUrl: input.baseURL,
        // The harness resolves the credential before pi-ai sees the request and
        // hands it over as a stream option; this method only reports the override
        // back to pi-ai's auth resolution.
        auth: {
            apiKey: {
                name: input.displayName,
                resolve: ({ credential }) => Promise.resolve({
                    auth: credential?.key === undefined ? {} : { apiKey: credential.key },
                    source: input.displayName,
                }),
            },
        },
        models: input.models,
        api: PROTOCOL_FACTORIES[input.api](),
    });
    return {
        ...provider,
        stream: (model, context, options) => provider.stream(model, context, withConfiguredHeaders(options, input.headers)),
        streamSimple: (model, context, options) => provider.streamSimple(model, context, withConfiguredHeaders(options, input.headers)),
    };
}
