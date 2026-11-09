# Custom Headers

[简体中文](README.md) | **English**

Visual provider route management and custom HTTP headers for DSH.

We designed and developed this plugin to provide a complete workflow for route configuration, request headers, model catalogs, and credential storage. It integrates with the host's model interfaces and uses runtime dependencies supplied by the host.

- Package: `dsh-plugin-custom-headers`
- Version: `0.1.0`
- License: MIT

## Features

- **Custom headers**: Configure `User-Agent` and other headers per route. Header names are merged case-insensitively, with configured values taking precedence in the final merge.
- **Three protocols**: OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages.
- **Provider management**: Add, edit, and remove routes in Settings, with separate endpoints, protocols, credentials, and models.
- **Model catalogs**: Manage model IDs, names, context windows, output limits, text/image inputs, and reasoning levels, or retrieve available models from an endpoint.
- **Credential protection**: Store keys through the host credential service. Route configuration contains references only, and stored secrets are never displayed in the UI.
- **Incremental updates**: Update only changed routes. If replacement registration fails, the plugin attempts to restore the previous adapter. A failed route does not block other routes.
- **Save feedback**: Detect stale drafts and report partially completed credential writes so remaining changes can be retried.

## Installation and Quick Start

### Requirements

- DSH: `>=0.2.2-rc.1 <0.3.0`; compatibility validation baseline: `0.2.2-rc.1`.
- Local development: Node.js 22 or later and npm.
- The plugin runs inside the host and cannot be started as a standalone service.

### Install a Local Directory

Install the project directory through the host plugin management tool:

```text
plugin_manager(action: "install_bundle", target: "C:\path\to\oh-dsh-plugin-custom-headers")
```

The plugin manager handles linking and activation. Build the project as described below before installing from source. After installation or an update, restart the host if needed to load the settings page.

### Configure Your First Route

1. Open **Settings → Custom Headers**.
2. Add a provider with a unique route ID, protocol, and service endpoint.
3. Enter an API key and add the headers you want to send.
4. Add models manually, or retrieve available models and select the entries you need.
5. Save the configuration, then select a model from this route in the host.

The bundled default routes use example endpoints. Replace them with your own endpoints and model catalogs before use.

## Configuration Example

The following is the plugin's `config` content. See the [configuration template](examples/profile.patch.example.yml) for a complete profile example.

```yaml
providers:
  my-provider:
    displayName: my-provider
    api: openai-responses
    baseURL: https://api.example.com/v1
    apiKeyEnv: MY_PROVIDER_API_KEY
    headers:
      User-Agent: my-client/1.0
      X-Client-Name: custom-headers
    models:
      - id: my-model
        name: My Model
        contextWindow: 262144
        maxTokens: 32768
        input: [text, image]
        reasoningEfforts:
          off: null
          low: low
          medium: medium
          high: high
    reasoning: high
    streamIdleTimeoutMs: 300000
```

| Field | Description |
|---|---|
| `providers` | Routes keyed by unique route ID |
| `displayName` | Normalized by the plugin to match the route ID |
| `api` | `openai-completions`, `openai-responses`, or `anthropic-messages` |
| `baseURL` | Service base URL; OpenAI endpoints commonly include `/v1`. Follow your endpoint's requirements |
| `apiKeyEnv` | Credential reference or matching startup environment variable name; never a plaintext key |
| `headers` | Custom headers for this route |
| `models` | At least one valid model whose ID matches the service |
| `contextWindow` / `maxTokens` | Context window and maximum output tokens; defaults are `262144` and `32768` respectively |
| `input` | Input types; defaults to `[text]`, with optional `image` support |
| `reasoningEfforts` | Mapping from reasoning levels to protocol values. Omit for a non-reasoning model; `off: null` sends no reasoning parameter |
| `reasoning` | Optional default reasoning level for the route |
| `streamIdleTimeoutMs` | Optional streaming idle timeout in milliseconds |

### Headers and Credentials

Headers apply only to routes registered by this plugin. Names are handled case-insensitively to avoid duplicate fields. Invalid names, line breaks, and restricted transport-control headers are rejected.

When you enter an API key in Settings, the plugin stores it through the host credential service and saves only its reference in the configuration. Leave the field empty to keep an existing key. Removing a route retains its credentials so other configurations sharing the reference continue to work.

### Saving and Model Discovery

Edits remain in a draft until saved. If the configuration revision has changed, saving is rejected with a reload prompt. The host does not provide a conditional write interface, so this check cannot guarantee atomic commits across processes.

Credentials are saved before route configuration. If some keys are written successfully but a later step fails, the page reports the completed reference names and retries only the remaining changes. Saving configuration and registering runtime routes are separate stages; consult host logs if registration fails.

Model discovery uses the saved route's endpoint, protocol, credentials, and headers. It has a default timeout of 30 seconds and does not follow redirects. Model listings depend on endpoint support; verify context windows, output limits, and image capabilities yourself.

## Development and Verification

```powershell
npm install
npm run vendor
npm run verify
```

`vendor` extracts runtime dependencies needed for testing from the local host installation into `node_modules`. Those dependencies are not committed or distributed as plugin code. If the default installation path does not apply, see the [compatibility maintenance guide](docs/COMPATIBILITY.md).

| Command | Purpose |
|---|---|
| `npm run check` | TypeScript type checking |
| `npm run build` | Compile `src/` into `lib/` |
| `npm test` | Run the full regression suite |
| `npm run verify` | Run type checking, build, and the full test suite in sequence |
| `npm run test:wire` | Request and protocol adapter tests |
| `npm run test:client` | Settings page logic tests |
| `npm run test:discovery` | Model discovery tests |
| `npm run compat` | Check compatibility with the local host |
| `npm run pack:check` | Inspect package contents |

The current regression baseline is **94 passing tests**, covering headers, configuration validation, route registration and recovery, credential saving, edit conflicts, and model discovery. Default tests use local mock endpoints and do not require real API keys. Passing tests do not constitute validation against live upstream services.

## Project Structure

```text
src/                 Host-side code: routes, headers, configuration, credentials, discovery
client.js            Visual settings page
lib/                 TypeScript build output and host entry point
locale/              Chinese and English plugin metadata
cordis.patch.yml     Default plugin configuration
examples/            Configuration templates
test/                Regression tests
tools/               Compatibility checks, test runners, and supporting tools
docs/                Architecture, deployment, and maintenance documentation
```

## Troubleshooting

| Issue | What to check |
|---|---|
| Route is missing | Confirm the plugin is enabled, validate configuration, and inspect host registration logs |
| Route ID conflict | Choose an ID not already used in the current profile |
| Missing key or authentication failure | Check the credential reference, actual key, and service permissions |
| Headers are not applied | Confirm the request uses a route registered by this plugin and check whether a gateway rewrites headers |
| Model discovery fails | Check the saved endpoint, credentials, model listing interface, and network connectivity |
| Settings page is missing | Restart the host and ensure the plugin row ID remains `CustomHeaders` |
| Save conflict | Reload the latest configuration, then reapply your changes |

The plugin currently supports API key authentication, without an OAuth authorization flow. Model capabilities follow configured declarations. After a host or service upgrade, review compatibility and rerun verification.

## Further Documentation

The maintenance documents below are primarily in Chinese.

- [Architecture](docs/ARCHITECTURE.md)
- [Single-host maintenance](docs/SINGLE-HOST.md)
- [Multi-device deployment](docs/MULTI-DEVICE.md)
- [Compatibility maintenance](docs/COMPATIBILITY.md)
- [Changelog](CHANGELOG.md)

## License

This project is licensed under the [MIT License](LICENSE).
