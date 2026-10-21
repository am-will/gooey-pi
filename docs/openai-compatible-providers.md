# Connect an OpenAI-compatible model endpoint

Configure the endpoint in the harness you select in GooeyPi. The endpoint's model identifier, authentication, and supported API must match that harness's configuration. A compatible chat endpoint does not necessarily support Responses, images, tools, or reasoning controls.

## Check the endpoint

Get the base URL and exact model identifier from the server operator. The base URL commonly ends in `/v1`. Do not append `/chat/completions` when the harness expects a base URL.

Check whether the server supports streaming chat completions, tool calls, and images. Configure only capabilities that the server and model both support. Use HTTPS for credentials sent outside your computer, and keep keys out of screenshots and Git commits.

## Configure Pi

For Pi's `openai-completions` API, add a provider to `~/.pi/agent/models.json`. Merge it into an existing file rather than replacing other providers.

```json
{
	"providers": {
		"my-endpoint": {
			"baseUrl": "https://models.example.com/v1",
			"api": "openai-completions",
			"apiKey": "${MY_ENDPOINT_API_KEY}",
			"models": [{ "id": "your-model-id" }]
		}
	}
}
```

Replace the example URL and model ID with your server's values. Supply `MY_ENDPOINT_API_KEY` through the environment inherited by Pi. A variable set in one terminal is not automatically present in a desktop app launched from Finder. Alternatively, use the credential mechanism documented by your installed harness.

Verify the configuration in Pi before opening GooeyPi. Pi's `/model` command reloads the file. The [Pi model documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md) describes additional model metadata and endpoint options. The example above matches the model configuration documented with the installed Pi 1.3 release.

## Refresh the selected harness in GooeyPi

1. Select the harness you configured.
2. Open **Settings**, then **Providers**.
3. Refresh the model catalog.
4. Enable the provider and model if you previously hid them.
5. Select the model in a new chat and send a short prompt.

For OMP, configure credentials and custom models through the installed OMP CLI. GooeyPi reads `omp models --json`; it does not own OMP's credential file. For Rust Prime Agent, configure the provider through that installed Prime release. GooeyPi asks Rust Prime for its available models instead of substituting the bundled TypeScript registry. A provider that the harness cannot authenticate may have no available models.

Use the configuration documentation for the installed harness version. Do not copy one harness's credential file or custom-model schema into another harness's directory.

## Diagnose a missing or failing model

- If the harness cannot list the model, check its endpoint configuration and credentials first. Refreshing GooeyPi cannot create a model that the harness does not report.
- If the harness lists the model but GooeyPi hides it, check provider and model visibility in **Settings**, then refresh.
- If requests return `401` or `403`, check the key and endpoint permissions.
- If requests return `404`, check the base URL, model ID, and API route.
- If chat works but tools or images fail, remove unsupported capabilities from the model configuration.
- If the endpoint is on another computer, `localhost` refers to the computer running the harness. Use the endpoint's reachable address. The [remote-hosts proposal](remote-hosts-design.md) is a design document, not an existing SSH integration.
