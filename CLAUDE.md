# Conventions for Claude Code

## Branches

- Never push directly to `main`.
- All development happens on a dedicated feature/fix branch.
- Open a pull request to `main` once the changes are ready and the CI build is green.

## Repository layout

```
ia-bd/
├── inference/          # FastAPI + HuggingFace Diffusers microserver
│   ├── server.py       # /generate and /health API
│   ├── requirements.txt
│   └── Dockerfile      # python:3.10-slim + PyTorch CPU
├── webapp/             # Node.js/Express web interface
│   ├── server.js       # Endpoints /api/encrage, /api/colorisation, /api/status, /api/backends
│   ├── backends.js     # AI engines: local, openai, novelai
│   ├── package.json
│   └── Dockerfile      # node:alpine
├── docker-compose.yml  # Full stack (inference + webapp)
├── setup-vps.sh        # VPS initialisation script
└── .github/workflows/
    └── build.yml       # CI: build & push to Docker Hub
```

The `a1111/` directory is obsolete (earlier attempt at fixing A1111) — it can be deleted.

## Stack

- **inference** (`monolithoid/bd-inference`): FastAPI + SD 1.5 + ControlNet scribble/lineart
  - `GET /health` → `{"ready": true}`
  - `POST /generate` → img2img + ControlNet, returns a base64 PNG
  - Models: `runwayml/stable-diffusion-v1-5`, `lllyasviel/control_v11p_sd15_scribble`, `lllyasviel/control_v11p_sd15_lineart`
  - HuggingFace cache in `/models/hf-cache` (VPS volume `/opt/ia/bd/models`)

- **webapp** (`monolithoid/bd-webapp`): Node.js/Express, Google SSO, upload + preview
  - Engines selectable in `webapp/backends.js`: `local` (calls `http://inference:8000/generate` through `INFERENCE_URL`), `openai`, `novelai`
  - An engine only appears when its API key is configured; `GET /api/backends` lists the available engines
  - No Ollama or Open WebUI: calls are made directly from the webapp

## Language

- Code, comments, docstrings, logs and documentation are in English.
- User-facing UI text (pages, buttons, status and error messages shown in the browser) stays in French.

## CI/CD

- GitHub Actions (`.github/workflows/build.yml`): push to `main` → build `bd-inference` + `bd-webapp` → Docker Hub
- Coolify pulls the images from Docker Hub and redeploys on the VPS
- Secrets required in GHA: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`

## Environment variables (Coolify)

| Variable | Description |
|---|---|
| `DOMAIN` | Main domain (e.g. `monolithoid.com`) |
| `DOCKERHUB_USERNAME` | Docker Hub username |
| `OAUTH_CLIENT_ID` | Google OAuth Client ID |
| `OAUTH_CLIENT_SECRET` | Google OAuth Client Secret |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `ALLOWED_EMAIL` | The only allowed Gmail address |
| `PRELOAD_MODES` | `encrage,colorisation` to preload at startup |
| `DEFAULT_BACKEND` | Default engine: `local`, `openai`, `novelai` |
| `OPENAI_API_KEY` / `OPENAI_IMAGE_MODEL` / `OPENAI_IMAGE_QUALITY` | ChatGPT engine (OpenAI Images API, `/v1/images/edits`) |
| `NOVELAI_API_KEY` / `NOVELAI_MODEL` / `NOVELAI_STRENGTH` | NovelAI engine (img2img, ZIP response) |
| `LOCAL_ENABLED` | `false` to hide the local engine |

## VPS

- Models path: `/opt/ia/bd/models/hf-cache/` (~5 GB, downloaded on first start)
- Outputs path: `/opt/ia/bd/outputs/`
- Sessions path: `/opt/ia/bd/sessions/`
- CPU only, 10-30 min per image
