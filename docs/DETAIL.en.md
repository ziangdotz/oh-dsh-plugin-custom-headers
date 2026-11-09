# dsh-plugin-custom-headers

Version **v0.1.0**.

Registers custom pi-ai provider routes in DSH so their final HTTP requests carry your configured `User-Agent` and extra headers.

## Supported protocols

- OpenAI Chat Completions
- OpenAI Responses
- Anthropic Messages

Each route supports a protocol, Base URL, headers, and model catalog. The official DSH adapter handles streaming, tool calls, reasoning, images, timeouts, cancellation, and retries. Available capabilities depend on the model and upstream service.

## Configuration and use

1. Enable the plugin and open **Custom Headers** in DSH settings.
2. Add a provider and enter its route ID, protocol, and Base URL.
3. Enter an API key as needed, select a User-Agent preset, or edit headers manually.
4. Configure the model catalog, or use **Fetch models** to retrieve it from the upstream service.
5. Click **Save**, then select a model from that route in the DSH model picker.

The host credential service stores API keys, while configuration stores only reference names. Saved keys appear as placeholders. Leave the key field empty to retain an existing value. Deleting a provider retains stored credentials because other plugins may share the same reference.

## Installation and compatibility

The current verified baseline is DSH **0.2.2-rc.1**, Cordis **4.1.0**, pi-ai **1.3.0**, and Schemastery **3.19.0**. The plugin version is **v0.1.0**.

For a local source installation, replace the path below with your project directory. Restart DSH after installation and enable the plugin.

```powershell
dsh plugin --profile desktop add 'link:C:\path\to\dsh-plugin-custom-headers'
```

Build and type checks pass on this baseline, along with 87 automated regression tests and 18 compatibility checks. Loading the settings page and reading configuration passed desktop acceptance. Real upstream calls depend on each service's credentials, network, and model support.

## Behavior and upgrade considerations

Custom headers apply to routes registered by this plugin. It uses the official adapter's `profile.piProvider` interface to merge configured headers into request options and override the default harness User-Agent. Verify this interface and header merging again after upgrading DSH or pi-ai.

Fetching the model catalog sends a request to the configured upstream service. Saving settings re-registers affected routes.

See the project README, CHANGELOG, and docs directory for development, deployment, and validation details.
