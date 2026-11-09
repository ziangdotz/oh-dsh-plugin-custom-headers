/**
 * Model discovery for this plugin's routes.
 *
 * The Models page asks the Host's `llm/discoverModels` Remote about an endpoint,
 * and the `llm` service answers by delegating to whichever discovery handler was
 * registered for that endpoint's settings namespace. This module is that handler
 * for `custom-headers`: it turns a named route into its stored endpoint, resolves
 * the route's credential reference through the same seam the adapter uses, and
 * reads the endpoint's own model listing.
 *
 * It never sees a secret from the browser: the request only names a route, and
 * the key comes from the Host's credentials service.
 *
 * @module dsh-plugin-custom-headers/discovery
 */
import { attributionHeaders, LlmError } from './compat.js';
/** Stable API version Anthropic's model listing requires. */
const ANTHROPIC_VERSION = '2023-06-01';
/** Largest page Anthropic's listing serves; discovery reads one page. */
const ANTHROPIC_LISTING_LIMIT = 1000;
/** Replies larger than this are refused rather than parsed. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/**
 * Join the configured endpoint with the protocol's listing path.
 *
 * The base is treated as a prefix so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its segments. OpenAI-compatible
 * gateways list at `{base}/models`. Anthropic lists at `{root}/v1/models`,
 * where the root is the base without a trailing `/v1` — gateways publish both
 * spellings of the same root — and only this listing normalizes it; requests
 * still use the configured `baseURL` unchanged.
 *
 * @param baseURL - the route's configured endpoint.
 * @param api - the route's wire protocol.
 * @returns the listing URL to interrogate.
 */
export function listingUrl(baseURL, api) {
    const base = baseURL.replace(/\/+$/, '');
    if (api !== 'anthropic-messages')
        return `${base}/models`;
    const root = base.endsWith('/v1') ? base.slice(0, -3) : base;
    return `${root}/v1/models?limit=${String(ANTHROPIC_LISTING_LIMIT)}`;
}
/** One positive integer candidate, or `undefined` when none is usable. */
function capacity(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0)
            return candidate;
    }
    return undefined;
}
/** One non-empty string candidate, or `undefined` when none is usable. */
function label(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0)
            return candidate;
    }
    return undefined;
}
/**
 * Read one model-listing reply.
 *
 * Two shapes are accepted: the standard OpenAI `data` array, and a `models`
 * object used by gateways whose property keys are the ids requests accept.
 * Entries without a usable id are skipped rather than failing the whole
 * interrogation — one malformed row must not hide an endpoint's catalog.
 *
 * @param body - parsed JSON reply.
 * @returns the advertised models in reply order, deduplicated by id.
 * @throws {LlmError} when the reply is neither accepted shape.
 */
export function parseListing(body) {
    const listing = body;
    const listed = [];
    if (Array.isArray(listing?.data)) {
        for (const raw of listing.data) {
            if (raw !== null && typeof raw === 'object' && !Array.isArray(raw))
                listed.push({ raw: raw });
        }
    }
    else if (listing?.models !== null && typeof listing?.models === 'object' && !Array.isArray(listing.models)) {
        for (const [key, raw] of Object.entries(listing.models)) {
            if (raw !== null && typeof raw === 'object' && !Array.isArray(raw))
                listed.push({ key, raw: raw });
        }
    }
    else {
        throw new LlmError('the endpoint\'s model listing has neither a "data" array nor a "models" object; enter this route\'s models by hand', 'DISCOVERY_FAILED');
    }
    const models = [];
    const seen = new Set();
    for (const { key, raw } of listed) {
        const id = label(key, raw.id);
        if (id === undefined || seen.has(id))
            continue;
        seen.add(id);
        const name = label(raw.name, raw.display_name, raw.displayName);
        const contextWindow = capacity(raw.contextWindow, raw.context_window, raw.context_length, raw.max_input_tokens, raw.limit?.context);
        const maxTokens = capacity(raw.maxOutputTokens, raw.max_output_tokens, raw.maxTokens, raw.max_tokens, raw.limit?.output, raw.top_provider?.max_completion_tokens);
        models.push({
            id,
            ...name === undefined ? {} : { name },
            ...contextWindow === undefined ? {} : { contextWindow },
            ...maxTokens === undefined ? {} : { maxTokens },
        });
    }
    return models;
}
/**
 * Read a reply body, refusing one that outgrows the ceiling. The declared
 * length is checked first so an honest server is turned away without
 * transferring anything; the accumulated total is what actually enforces the
 * bound, because a server that under-declares tells us nothing up front.
 */
async function readBounded(response, url) {
    const oversized = () => new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED');
    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => { });
        throw oversized();
    }
    if (response.body === null)
        return '';
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > MAX_RESPONSE_BYTES)
                throw oversized();
            chunks.push(value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
}
/**
 * Interrogate one configured endpoint for the models it advertises.
 *
 * The route's own headers are sent, because a relay keyed on `User-Agent` would
 * otherwise answer differently to discovery than to a real request. Harness
 * attribution headers fill in the names the route does not set, so discovery
 * identifies itself exactly like a normal call.
 *
 * @param probe - endpoint, protocol, headers and credential, all already resolved.
 * @returns the advertised models in endpoint order.
 * @throws {LlmError} when the endpoint is unusable, refuses, or answers with
 *   something that is not a model listing.
 */
export async function probeModels(probe) {
    let parsed;
    try {
        parsed = new URL(probe.baseURL);
    }
    catch {
        throw new LlmError(`"${probe.baseURL}" is not an absolute URL; discovery needs an http or https endpoint`, 'DISCOVERY_FAILED');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new LlmError(`"${probe.baseURL}" is not an http or https endpoint`, 'DISCOVERY_FAILED');
    }
    const url = listingUrl(probe.baseURL, probe.api);
    const headers = new Headers();
    for (const [name, value] of Object.entries(probe.headers))
        headers.set(name, value);
    for (const [name, value] of Object.entries(attributionHeaders())) {
        if (!headers.has(name))
            headers.set(name, value);
    }
    headers.set('accept', 'application/json');
    if (probe.api === 'anthropic-messages') {
        headers.set('anthropic-version', ANTHROPIC_VERSION);
        if (probe.apiKey !== undefined)
            headers.set('x-api-key', probe.apiKey);
    }
    else if (probe.apiKey !== undefined) {
        headers.set('authorization', `Bearer ${probe.apiKey}`);
    }
    const timeout = AbortSignal.timeout(probe.timeoutMs ?? 30000);
    const signal = probe.signal === undefined ? timeout : AbortSignal.any([probe.signal, timeout]);
    try {
        let response;
        try {
            response = await fetch(url, {
                method: 'GET',
                redirect: 'error',
                headers,
                signal,
            });
        }
        catch (error) {
            if (probe.signal?.aborted)
                throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error });
            throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error });
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => { });
            const hint = response.status === 401 || response.status === 403 ? '; check the API key behind apiKeyEnv' : '';
            throw new LlmError(`${url} answered ${response.status}${hint}`, 'DISCOVERY_FAILED');
        }
        const text = await readBounded(response, url);
        let body;
        try {
            body = JSON.parse(text);
        }
        catch (error) {
            throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error });
        }
        return parseListing(body);
    }
    catch (error) {
        if (probe.signal?.aborted)
            throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error });
        if (timeout.aborted)
            throw new LlmError('model discovery timed out', 'DISCOVERY_FAILED', { cause: error });
        throw error;
    }
}
