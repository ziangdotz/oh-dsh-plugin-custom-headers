/**
 * `dsh-plugin-custom-headers` — deployment HTTP headers for pi-ai routes.
 *
 * The official `@deepseek-ai/dsh-llm-pi-ai` adapter filters every configured
 * header that collides case-insensitively with its attribution header and then
 * sends its own `user-agent`. That is a deliberate contract, not a bug: the
 * harness identifies itself on every provider request. This plugin does not
 * change that contract. It registers *additional* provider routes through the
 * same official adapter, and gives those routes a pi-ai provider that adds the
 * deployment's headers to the request options after the attribution merge, so
 * the configured value is what reaches the wire.
 *
 * Consequences worth stating plainly:
 *   - Only routes this plugin registers are affected; every other provider in
 *     the composition keeps the harness attribution header.
 *   - This is an override of a harness default, not a supported configuration
 *     surface. Nothing here is endorsed by the harness, and a future release
 *     could change the adapter internals this plugin reuses (see README).
 *
 * @module dsh-plugin-custom-headers
 */
import { providersFingerprint, readProviders, resolveRoute, Config, RouteConfigError } from './config.js';
import { createRouteAdapter } from './adapter.js';
import { probeModels } from './discovery.js';
import { createCordisHost, safeLog } from './host.js';
import { headerNames } from './headers.js';
import { checkCompat, } from './compat.js';
/** Package name, as the Loader reports the row. */
export const name = 'dsh-plugin-custom-headers';
/** The plugin cannot register anything before the LLM seam exists. */
export const inject = ['llm'];
export { Config };
/**
 * The settings namespace this plugin's page edits — the row id the composition
 * gives the plugin. Model discovery is offered for exactly this namespace, so
 * only this plugin's page can interrogate its routes' endpoints.
 */
export const SETTINGS_NAMESPACE = 'CustomHeaders';
/** Diagnostic prefix shared by every line this plugin writes. */
const PREFIX = 'dsh-plugin-custom-headers:';
/**
 * Describe a registration failure without losing the stable code the LLM seam
 * attaches to it (`DUPLICATE_ADAPTER` is the one that matters here).
 * @param error - the thrown value.
 * @returns a single-line diagnostic.
 */
function describeFailure(error) {
    const code = error?.code;
    const message = error instanceof Error ? error.message : String(error);
    return typeof code === 'string' ? `${code}: ${message}` : message;
}
/**
 * Mount the plugin.
 *
 * Each provider is resolved and registered on its own: one provider that is
 * misconfigured, or whose route another adapter already owns, logs a line and
 * leaves every other provider —in this plugin and elsewhere —untouched.
 *
 * @param ctx - the plugin context (requires the `llm` service).
 * @param config - the row's configuration.
 */
export function apply(ctx, config) {
    let compat;
    try {
        compat = checkCompat();
    }
    catch (error) {
        safeLog(ctx, 'error', `${PREFIX} compatibility probe failed: ${describeFailure(error)}`);
        return;
    }
    for (const issue of compat.warnings) {
        safeLog(ctx, 'warn', `${PREFIX} compatibility warning at ${issue.point}: ${issue.detail}`);
    }
    if (compat.fatal.length > 0) {
        for (const issue of compat.fatal) {
            safeLog(ctx, 'error', `${PREFIX} incompatible DSH runtime at ${issue.point}: ${issue.detail}`);
        }
        safeLog(ctx, 'error', `${PREFIX} routes were not registered; port src/compat.ts to this DSH release, then run "npm run compat" and "npm run verify"`);
        return;
    }
    if (typeof ctx.llm.registerAdapter !== 'function') {
        safeLog(ctx, 'error', `${PREFIX} the "llm" service no longer exposes registerAdapter(); the plugin needs a small port of src/index.ts and src/adapter.ts`);
        return;
    }
    const host = createCordisHost(ctx);
    const mounted = new Map();
    const unmount = (provider) => {
        const state = mounted.get(provider);
        if (state === undefined)
            return;
        mounted.delete(provider);
        try {
            state.dispose();
        }
        catch (error) {
            safeLog(ctx, 'warn', `${PREFIX} disposing provider "${provider}" failed: ${describeFailure(error)}`);
        }
    };
    const reconcile = () => {
        let providers;
        try {
            providers = readProviders(config);
        }
        catch (error) {
            safeLog(ctx, 'error', `${PREFIX} cannot read "providers" from the plugin configuration: ${describeFailure(error)}`);
            return;
        }
        for (const provider of [...mounted.keys()]) {
            if (!(provider in providers)) {
                unmount(provider);
                safeLog(ctx, 'info', `${PREFIX} provider "${provider}" is no longer configured and was unregistered`);
            }
        }
        for (const [provider, source] of Object.entries(providers)) {
            const fingerprint = providersFingerprint({ [provider]: source });
            const current = mounted.get(provider);
            if (current !== undefined && current.fingerprint === fingerprint)
                continue;
            let route;
            try {
                route = resolveRoute(provider, source);
            }
            catch (error) {
                const detail = error instanceof RouteConfigError ? error.message : describeFailure(error);
                safeLog(ctx, 'error', `${PREFIX} provider "${provider}" was not registered: ${detail}`);
                continue;
            }
            for (const [entry, reason] of route.modelErrors) {
                safeLog(ctx, 'warn', `${PREFIX} provider "${provider}" skipped model "${entry}": ${reason}`);
            }
            try {
                const adapter = createRouteAdapter(provider, route, host);
                unmount(provider);
                const dispose = ctx.llm.registerAdapter([provider], adapter);
                mounted.set(provider, { fingerprint, route, dispose, adapter });
                const declared = headerNames(route.headers);
                safeLog(ctx, 'info', `${PREFIX} registered provider "${provider}" (api ${route.api}, ${route.models.length} model(s), ${route.displayName}; headers: ${declared.length === 0 ? 'none' : declared.join(', ')})`);
            }
            catch (error) {
                if (current !== undefined && !mounted.has(provider)) {
                    try {
                        const dispose = ctx.llm.registerAdapter([provider], current.adapter);
                        mounted.set(provider, { ...current, dispose });
                        safeLog(ctx, 'warn', `${PREFIX} provider "${provider}" update failed; previous adapter restored`);
                    }
                    catch (restoreError) {
                        safeLog(ctx, 'error', `${PREFIX} provider "${provider}" restore failed: ${describeFailure(restoreError)}`);
                    }
                }
                safeLog(ctx, 'error', `${PREFIX} provider "${provider}" was not registered: ${describeFailure(error)}`);
            }
        }
    };
    reconcile();
    // The Models page asks `llm/discoverModels` with this namespace; answering it
    // is what makes "fetch available models" work on this plugin's own page. The
    // handler reads the live configuration each call, so an edit made moments
    // before the button is pressed is the endpoint that gets interrogated.
    const discover = async (request, signal) => {
        if (request.baseURL !== undefined || request.api !== undefined || request.apiKey !== undefined) {
            throw new Error('model discovery accepts only a saved provider route; endpoint, protocol and credential overrides are disabled');
        }
        const provider = request.provider ?? '';
        let providers;
        try {
            providers = readProviders(config);
        }
        catch (error) {
            throw new Error(`cannot read "providers" from the plugin configuration: ${describeFailure(error)}`);
        }
        const source = providers[provider];
        if (source === undefined)
            throw new Error(`this plugin has no provider route "${provider}"`);
        let route;
        try {
            route = resolveRoute(provider, source);
        }
        catch (error) {
            throw new Error(`this plugin cannot serve route "${provider}": ${describeFailure(error)}`);
        }
        const apiKey = await host.resolveApiKey(provider, route);
        return await probeModels({
            baseURL: route.baseURL,
            api: route.api,
            headers: route.headers,
            ...apiKey === undefined ? {} : { apiKey },
            ...signal === undefined ? {} : { signal },
        });
    };
    ctx.effect(() => {
        try {
            return ctx.llm.registerModelDiscovery(SETTINGS_NAMESPACE, discover);
        }
        catch (error) {
            // A missing LLM seam must not take the routes down with it.
            safeLog(ctx, 'error', `${PREFIX} model discovery was not registered: ${describeFailure(error)}`);
            return () => { };
        }
    });
    // A profile-layer edit reaches a running Host as a volatile loader update;
    // the official adapter listens to the same event for the same reason.
    ctx.on('loader/volatile-update', () => {
        try {
            reconcile();
        }
        catch (error) {
            safeLog(ctx, 'error', `${PREFIX} reconciling providers after a configuration update failed: ${describeFailure(error)}`);
        }
    });
    ctx.effect(() => () => {
        for (const provider of [...mounted.keys()])
            unmount(provider);
    });
}
// Resolution helpers exported for this plugin's own tests, which drive the
// real adapter against a local HTTP server.
export { assertValidHeaders, mergeHeadersCaseInsensitive } from './headers.js';
export { resolveRoutes, RouteConfigError, providersFingerprint, readProviders } from './config.js';
export { createRouteProvider, getSupportedThinkingLevels, resolveModelReasoning } from './models.js';
export { createRouteAdapter } from './adapter.js';
export { listingUrl, parseListing, probeModels } from './discovery.js';
export { resolveRoute };
