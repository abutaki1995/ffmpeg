# FFmpeg Service for TakTak Pipeline

A lightweight FFmpeg API that runs as a Docker service in Coolify.
Called by n8n via HTTP Request — no sandbox restrictions.

## Deploy on Coolify

1. Push this folder to a **GitHub repo** (public or private)
2. In Coolify → Your Project → **Add New Resource**
3. Choose **Public Repository** (or GitHub App if private)
4. Paste the repo URL
5. Build pack: **Docker Compose**
6. Coolify will detect the `docker-compose.yml`
7. Set domain (e.g., `ffmpeg.abutaki.me`) or use internal networking
8. Deploy

## Internal Networking (recommended)

If both n8n and this service are on the same Coolify server,
enable **"Connect to Predefined Network"** on both services.
Then call it from n8n using the container name:

```
http://ffmpeg-api:3000/compose
```

No need for a public domain — keeps it private and fast.

## API

### POST /compose

```json
{
  "clip_urls": ["https://...", "https://...", ...],
  "narration_url": "https://...",
  "music_url": "https://...",
  "ass_content": "[Script Info]\n...",
  "options": {
    "narration_delay": 1000,
    "narration_volume": 0.95,
    "music_volume": 0.08,
    "preset": "fast",
    "crf": 23
  }
}
```

Returns: `video/mp4` binary file

### GET /health
Returns FFmpeg version and status.

### GET /status
Returns count of active jobs.

## n8n Node Config

Use an **HTTP Request** node:
- Method: POST
- URL: `http://ffmpeg-api:3000/compose`
- Body: JSON (as above)
- Response: File (binary)
