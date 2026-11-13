# Conventions pour Claude Code

## Branches

- Ne jamais pousser directement sur `main`.
- Tout développement se fait sur une branche feature/fix dédiée.
- Ouvrir une pull request vers `main` une fois les changements prêts et le build CI au vert.

## Structure du repo

```
ia-bd/
├── inference/          # Microserveur FastAPI + HuggingFace Diffusers
│   ├── server.py       # API /generate et /health
│   ├── requirements.txt
│   └── Dockerfile      # python:3.10-slim + PyTorch CPU
├── webapp/             # Interface web Node.js/Express
│   ├── server.js       # Endpoints /api/encrage, /api/colorisation, /api/status, /api/backends
│   ├── backends.js     # Moteurs IA : local, openai, novelai
│   ├── package.json
│   └── Dockerfile      # node:alpine
├── docker-compose.yml  # Stack complète (inference + webapp)
├── setup-vps.sh        # Script d'initialisation du VPS
└── .github/workflows/
    └── build.yml       # CI : build & push sur Docker Hub
```

Le répertoire `a1111/` est obsolète (ancienne tentative de fix A1111) — peut être supprimé.

## Stack

- **inference** (`monolithoid/bd-inference`) : FastAPI + SD 1.5 + ControlNet scribble/lineart
  - `GET /health` → `{"ready": true}`
  - `POST /generate` → img2img + ControlNet, retourne base64 PNG
  - Modèles : `runwayml/stable-diffusion-v1-5`, `lllyasviel/control_v11p_sd15_scribble`, `lllyasviel/control_v11p_sd15_lineart`
  - Cache HuggingFace dans `/models/hf-cache` (volume VPS `/opt/ia/bd/models`)

- **webapp** (`monolithoid/bd-webapp`) : Node.js/Express, Google SSO, upload + prévisualisation
  - Moteurs sélectionnables dans `webapp/backends.js` : `local` (appelle `http://inference:8000/generate` via `INFERENCE_URL`), `openai`, `novelai`
  - Un moteur n'apparaît que si sa clé API est configurée ; `GET /api/backends` liste les moteurs disponibles
  - Chaque moteur déclare ses réglages (`params` dans `backends.js`) : renvoyés par `GET /api/backends`, ajustables dans l'UI (mémorisés par navigateur), envoyés en JSON (`params`) et validés par `sanitizeParams()`. Les variables d'environnement servent de valeurs par défaut. Les réglages utilisés sont stockés dans chaque rendu.
  - Pas d'Ollama ni d'Open WebUI : les appels se font en direct depuis la webapp

## CI/CD

- GitHub Actions (`.github/workflows/build.yml`) : push sur `main` → build `bd-inference` + `bd-webapp` → Docker Hub
- Coolify pull les images depuis Docker Hub et redéploie sur le VPS
- Secrets requis dans GHA : `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`

## Variables d'environnement (Coolify)

| Variable | Description |
|---|---|
| `DOMAIN` | Domaine principal (ex: `monolithoid.com`) |
| `DOCKERHUB_USERNAME` | Username Docker Hub |
| `OAUTH_CLIENT_ID` | Google OAuth Client ID |
| `OAUTH_CLIENT_SECRET` | Google OAuth Client Secret |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `ALLOWED_EMAIL` | Seule adresse Gmail autorisée |
| `PRELOAD_MODES` | `encrage,colorisation` pour précharger au démarrage |
| `DEFAULT_BACKEND` | Moteur par défaut : `local`, `openai`, `novelai` |
| `OPENAI_API_KEY` / `OPENAI_IMAGE_MODEL` / `OPENAI_IMAGE_QUALITY` | Moteur ChatGPT (OpenAI Images API, `/v1/images/edits`) |
| `NOVELAI_API_KEY` / `NOVELAI_MODEL` / `NOVELAI_STRENGTH` | Moteur NovelAI (img2img, réponse ZIP) |
| `LOCAL_ENABLED` | `false` pour masquer le moteur local |

## VPS

- Path modèles : `/opt/ia/bd/models/hf-cache/` (~5 Go, téléchargés au premier démarrage)
- Path outputs : `/opt/ia/bd/outputs/`
- Path sessions : `/opt/ia/bd/sessions/`
- CPU uniquement, génération 10-30 min par image
