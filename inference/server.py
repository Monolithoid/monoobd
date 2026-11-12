"""
Inference microserver — SD 1.5 + ControlNet (CPU)

POST /generate  { image, prompt, negative_prompt, mode, steps, cfg_scale, denoising_strength }
GET  /health    → { ready: true }
"""
import io, base64, logging, os, warnings
from contextlib import asynccontextmanager

warnings.filterwarnings("ignore", message=".*resume_download.*", category=FutureWarning)

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image
from diffusers import (
    StableDiffusionControlNetPipeline,
    ControlNetModel,
    UniPCMultistepScheduler,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

HF_CACHE    = os.environ.get("HF_HOME", "/models/hf-cache")
SD_BASE     = "runwayml/stable-diffusion-v1-5"
CN_SCRIBBLE = "lllyasviel/control_v11p_sd15_scribble"
CN_LINEART  = "lllyasviel/control_v11p_sd15_lineart"

_pipelines: dict = {}


def get_pipeline(mode: str) -> StableDiffusionControlNetPipeline:
    if mode not in _pipelines:
        log.info(f"Chargement pipeline {mode}…")
        cn_id = CN_SCRIBBLE if mode == "encrage" else CN_LINEART
        controlnet = ControlNetModel.from_pretrained(
            cn_id, torch_dtype=torch.float32, cache_dir=HF_CACHE)
        pipe = StableDiffusionControlNetPipeline.from_pretrained(
            SD_BASE,
            controlnet=controlnet,
            torch_dtype=torch.float32,
            cache_dir=HF_CACHE,
        )
        pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config)
        pipe.enable_attention_slicing()
        # Désactive le safety checker (inutile, ralentit l'inférence)
        if hasattr(pipe, "safety_checker"):
            pipe.safety_checker = None
        _pipelines[mode] = pipe
        log.info(f"Pipeline {mode} prêt.")
    return _pipelines[mode]


@asynccontextmanager
async def lifespan(app: FastAPI):
    for mode in os.environ.get("PRELOAD_MODES", "").split(","):
        mode = mode.strip()
        if mode:
            try:
                get_pipeline(mode)
            except Exception as e:
                log.warning(f"Preload {mode} échoué : {e}")
    yield


app = FastAPI(title="bd-inference", lifespan=lifespan)


class GenerateRequest(BaseModel):
    image: str                    # base64 PNG
    prompt: str
    negative_prompt: str = ""
    mode: str = "encrage"         # "encrage" | "colorisation"
    steps: int = 20
    cfg_scale: float = 7.0
    denoising_strength: float = 0.7


class GenerateResponse(BaseModel):
    image: str                    # base64 PNG


def _b64_to_pil(b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def _pil_to_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _snap8(n: int) -> int:
    """Multiple de 8 inférieur — exigence Stable Diffusion."""
    return max(8, (n // 8) * 8)


@app.get("/health")
def health():
    return {"ready": True}


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest):
    if req.mode not in ("encrage", "colorisation"):
        raise HTTPException(400, f"mode invalide : {req.mode!r}")
    try:
        img = _b64_to_pil(req.image)
        img = img.resize((_snap8(img.width), _snap8(img.height)), Image.LANCZOS)

        result = get_pipeline(req.mode)(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt,
            image=img,
            num_inference_steps=req.steps,
            guidance_scale=req.cfg_scale,
            generator=torch.Generator().manual_seed(42),
        ).images[0]

        return GenerateResponse(image=_pil_to_b64(result))

    except HTTPException:
        raise
    except Exception as e:
        log.exception("Erreur generate")
        raise HTTPException(500, str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
