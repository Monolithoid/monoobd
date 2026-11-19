# syntax=docker/dockerfile:1
FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git wget curl \
        libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Fail fast instead of hanging on credential prompts
ENV GIT_TERMINAL_PROMPT=0

# Install CPU PyTorch first (layer independent of the A1111 code)
# Takes ~5 min to build, then cached — only re-runs when the version changes
RUN pip install --no-cache-dir \
        torch==2.1.2 torchvision==0.16.2 \
        --index-url https://download.pytorch.org/whl/cpu

# Tells A1111 which command to use if torch must be reinstalled
ENV TORCH_COMMAND="pip install torch==2.1.2 torchvision==0.16.2 --index-url https://download.pytorch.org/whl/cpu"

# Clone AUTOMATIC1111
RUN git clone --depth 1 \
        https://github.com/AUTOMATIC1111/stable-diffusion-webui \
        /app/stable-diffusion-webui

WORKDIR /app/stable-diffusion-webui

# Extension ControlNet
RUN git clone --depth 1 \
        https://github.com/Mikubill/sd-webui-controlnet \
        extensions/sd-webui-controlnet

# Pre-clone the sub-repositories A1111 needs, at the exact commit it expects.
# GITHUB_TOKEN is injected through a BuildKit secret (never persisted in
# the image) to authenticate to github.com and get around private
# repositories or GitHub Actions runner rate limits.
COPY pre_clone_repos.py /tmp/pre_clone_repos.py
RUN --mount=type=secret,id=github_token \
    TOKEN=$(cat /run/secrets/github_token 2>/dev/null || echo "") && \
    [ -n "$TOKEN" ] && git config --global \
        url."https://x-access-token:${TOKEN}@github.com/".insteadOf \
        "https://github.com/" || true && \
    python3 /tmp/pre_clone_repos.py

# Pre-install A1111's Python dependencies
RUN pip install --no-cache-dir -r requirements_versions.txt

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7860
ENTRYPOINT ["/entrypoint.sh"]
