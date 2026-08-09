# Video Generation Through Preset Jobs

Custom provider nodes whose `/videos` surface is an **async submit → poll → fetch-result API** (instead of a synchronous generation endpoint) can be wired into the `/api/v1/videos/generations` route without any new provider code. The model row carries a `generationConfig.preset`, and the dispatcher routes the request through a single job executor that is configured entirely by declarative preset data.

## How dispatch works

1. The route parses `model` as `provider/model` and resolves the provider node's credentials (`POST /api/v1/videos/generations`).
2. `handleVideoGeneration` (in `open-sse/handlers/videoGeneration.ts`) checks whether the provider is a **custom provider node** (no entry in the static video registry).
3. For custom nodes it reads the custom model row via `getCustomModelVideoPreset(provider, model)`:
   - The model row has `generationConfig.preset` set (e.g. `"agnes-video-job"`) → dispatch through the **job executor** (`open-sse/handlers/videoGeneration/job.ts`).
   - The preset name does not match any known preset → **502** `Unknown video job preset: <preset>` (server-side misconfiguration).
   - No preset configured → fall back to the generic OpenAI-compatible sync handler, mirroring the images route.
4. The job executor runs the preset pipeline: **submit** the job, **poll** for terminal status, **read** the finished video URL, and return the standard OpenAI-compatible response shape.

The executor is one handler family; every provider-specific detail (paths, auth, body shape, status/result fields, poll cadence) is data in the preset definition.

## Response contract

Both the sync and job paths return the same shape:

```json
{
  "created": 1234567890,
  "data": [{ "url": "https://…", "format": "mp4" }]
}
```

This is the shape the media-generation consumer reads (`data.data[0].url`), so preset-job providers are drop-in replacements for sync providers.

## Presets

Presets live in `open-sse/handlers/videoGeneration/job.ts` (`VIDEO_JOB_PRESETS`). Each preset declares:

| Field                                        | Meaning                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `authHeaderName` / `authScheme`              | `x-api-key` with `raw` value (Agnes, muapi) or `Authorization` with `Bearer` prefix (Sora). Missing credentials → request goes out without an auth header.                                             |
| `baseUrlFallback`                            | Default base URL. Overridden by the provider connection's `providerSpecificData.baseUrl` (or top-level `baseUrl`), which wins when set.                                                                |
| `submit.path` / `submit.buildBody`           | Where and how the job is submitted. `{model}` in the path is substituted with the encoded model id; the body is built from `model`/`prompt`/`duration` plus pass-through of every other request field. |
| `taskIdPath`                                 | Dot path into the submit response identifying the job (e.g. `task_id`, `request_id`, `id`). Missing job id → **502**.                                                                                  |
| `poll.pathTemplate`                          | Poll URL template; `{taskId}` is substituted.                                                                                                                                                          |
| `statusPath` / `statusDone` / `statusFailed` | Where the job status lives and which values are terminal.                                                                                                                                              |
| `resultPath`                                 | Dot path into the poll response holding the finished video URL: a string, a string array, or an array of `{ url }` objects are all accepted. Completed job with no readable URL → **502**.             |
| `maxPolls` / `pollIntervalMs`                | Poll budget (default 60 polls × 2000 ms). Exhausted → **504** `Video job timed out`.                                                                                                                   |

### `agnes-video-job` — Agnes Video V2.0

- Auth: `x-api-key: <key>` (raw).
- Base URL fallback: `https://apihub.agnes-ai.com`.
- Submit: `POST /v1/videos` with `{ model, prompt, ...extras }` — image, mode, `num_frames`, `frame_rate` and other provider knobs pass through untouched.
- Job id: `task_id` from the submit response.
- Poll: `GET /v1/videos/{taskId}`; status at `status` (`completed` / `failed`).
- Result: `metadata.url` — the completed video URL is returned as JSON metadata, not a binary body.

### `muapi-video-job` — muapi.ai

- Auth: `x-api-key: <key>` (raw).
- Base URL fallback: `https://api.muapi.ai`.
- Submit: `POST /api/v1/{model}` with `{ prompt, duration?, ...extras }`.
- Job id: `request_id` from the submit response.
- Poll: `GET /api/v1/predictions/{taskId}/result`; status at `status` (`completed` / `failed`).
- Result: `outputs` — an array of video URLs.

### `sora-job` — OpenAI Sora

- Auth: `Authorization: Bearer <key>`.
- Base URL fallback: `https://api.openai.com`.
- Submit: `POST /v1/videos` with `{ model, prompt, seconds?, ...extras }`. `seconds` is a **string** enum (`"4" | "8" | "12"`) in the Sora API, so a numeric `duration` is stringified; size mapping is intentionally not forced.
- Job id: `id` from the submit response.
- Poll: `GET /v1/videos/{taskId}`; status at `status` (`completed` / `failed`).
- Result: `data` — an array whose entries are either a URL string or `{ url: "…" }`.

## Setup

1. **Register the provider node** as an OpenAI-compatible custom provider (`providerSpecificData.baseUrl` optional — the preset's `baseUrlFallback` is used when absent).
2. **Register a custom model** tagged with the `videos` endpoint and a `generationConfig`:

   ```json
   {
     "id": "super-video-v1",
     "name": "Super Video v1",
     "source": "manual",
     "apiFormat": "chat-completions",
     "supportedEndpoints": ["videos"],
     "generationConfig": { "preset": "agnes-video-job" }
   }
   ```

   `addCustomModel` (in `src/lib/db/models.ts`) accepts `generationConfig?: { preset: string }` as its final parameter and persists it on the model row; `updateCustomModel` forwards it the same way. The provider-models API accepts `generationConfig` on create and update.

3. **Call the route** as usual:

   ```bash
   curl -X POST http://localhost:8787/api/v1/videos/generations \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $API_KEY" \
     -d '{
       "model": "my-custom-provider/super-video-v1",
       "prompt": "a cat playing piano",
       "duration": 5
     }'
   ```

## Troubleshooting

| Symptom                                                                        | Cause                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `400 Unknown video provider: …`                                                | Non-custom provider not in the static registry; preset jobs only apply to custom provider nodes. |
| `502 Unknown video job preset: …`                                              | `generationConfig.preset` does not match any preset in `VIDEO_JOB_PRESETS`. Fix the model row.   |
| `502 Video provider did not return a job id (…)`                               | Submit succeeded but the response had no readable value at `taskIdPath`.                         |
| `502 Video job failed (…)` / `Video job completed but no result URL found (…)` | Poll reached a terminal `statusFailed` state, or `resultPath` held no readable URL.              |
| `504 Video job timed out after 60 polls (…)`                                   | Job never reached a terminal status within the poll budget.                                      |
| Upstream 4xx/5xx passthrough                                                   | `fetchJson` returns the upstream status when the submit/poll request itself is not OK.           |
| Requests go out without auth                                                   | No `apiKey`/`accessToken` on the provider connection; the executor sends `Content-Type` only.    |
