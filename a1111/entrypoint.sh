#!/usr/bin/env bash
# A1111 entrypoint — downloads missing models, then starts the server
set -euo pipefail

MODELS_DIR=/app/stable-diffusion-webui/models
SD_DIR="${MODELS_DIR}/Stable-diffusion"
CN_DIR="${MODELS_DIR}/ControlNet"

download_if_missing() {
    local dest="$1" url="$2" label="$3" size="${4:-}"
    if [ -f "$dest" ]; then
        echo "[setup] Already present: ${label}"
        return
    fi
    mkdir -p "$(dirname "$dest")"
    echo "[setup] Downloading: ${label}${size:+ (~${size} MB)}…"
    wget -q --show-progress -O "${dest}.tmp" "$url"
    mv "${dest}.tmp" "$dest"
    echo "[setup] OK: ${label}"
}

echo "[setup] Checking models…"

# Stable Diffusion 1.5 model (base)
download_if_missing \
    "${SD_DIR}/v1-5-pruned-emaonly.safetensors" \
    "https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors" \
    "SD 1.5 (base model)" "3976"

# ControlNet Scribble — inking from a sketch
download_if_missing \
    "${CN_DIR}/control_v11p_sd15_scribble.pth" \
    "https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_scribble.pth" \
    "ControlNet Scribble" "1445"

# ControlNet Lineart — guidance for colouring
download_if_missing \
    "${CN_DIR}/control_v11p_sd15_lineart.pth" \
    "https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_lineart.pth" \
    "ControlNet Lineart" "1445"

echo "[setup] Models OK. Starting AUTOMATIC1111 (CPU mode)…"

exec python launch.py \
    --api \
    --listen \
    --port 7860 \
    --skip-torch-cuda-test \
    --use-cpu all \
    --no-half \
    --precision full \
    --no-half-vae \
    --opt-split-attention \
    ${SD_EXTRA_ARGS:-}
