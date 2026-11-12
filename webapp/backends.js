'use strict';

// ============================================================
// Backends de génération d'image — sélectionnables
// ============================================================
//
//   local    → microserveur inference (SD 1.5 + ControlNet, CPU)
//   openai   → OpenAI Images API (endpoint /v1/images/edits)
//   novelai  → NovelAI Image API (img2img)
//
// Chaque backend expose la même interface :
//   generate({ image, prompt, negativePrompt, mode, strength }) → base64 PNG
//
// Un backend n'est « configuré » que si ses variables d'environnement
// sont présentes (clé API). Le backend par défaut est DEFAULT_BACKEND
// (ou le premier configuré).
// ============================================================

const zlib  = require('zlib');
const sharp = require('sharp');

const GEN_TIMEOUT = 60 * 60 * 1000;

const INFERENCE_URL = process.env.INFERENCE_URL || 'http://inference:8000';

const OPENAI_API_KEY      = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL     = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const OPENAI_IMAGE_MODEL  = process.env.OPENAI_IMAGE_MODEL  || 'gpt-image-1';
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';

const NOVELAI_API_KEY = process.env.NOVELAI_API_KEY || '';
const NOVELAI_URL     = process.env.NOVELAI_URL   || 'https://image.novelai.net/ai/generate-image';
const NOVELAI_MODEL   = process.env.NOVELAI_MODEL || 'nai-diffusion-4-5-full';
const NOVELAI_STEPS   = parseInt(process.env.NOVELAI_STEPS || '28', 10);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function httpError(name, r) {
  let body = '';
  try { body = (await r.text()).slice(0, 500); } catch { /* ignore */ }
  return new Error(`${name} ${r.status}: ${body}`);
}

/** Extrait le premier fichier d'une archive ZIP (format renvoyé par NovelAI). */
function firstFileFromZip(buf) {
  // End Of Central Directory : signature 0x06054b50, cherchée depuis la fin
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('NovelAI : réponse ZIP invalide');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('NovelAI : répertoire ZIP invalide');
  const method     = buf.readUInt16LE(cdOffset + 10);
  const compSize   = buf.readUInt32LE(cdOffset + 20);
  const localOff   = buf.readUInt32LE(cdOffset + 42);
  const nameLen    = buf.readUInt16LE(localOff + 26);
  const extraLen   = buf.readUInt16LE(localOff + 28);
  const dataStart  = localOff + 30 + nameLen + extraLen;
  const data       = buf.subarray(dataStart, dataStart + compSize);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`NovelAI : compression ZIP non supportée (${method})`);
}

// ── Backend : local (inference SD 1.5 + ControlNet) ─────────────────────────

const local = {
  id:    'local',
  label: 'Local (SD 1.5 + ControlNet, CPU)',
  configured: () => true,
  async ready() {
    try {
      const r = await fetch(`${INFERENCE_URL}/health`, { signal: AbortSignal.timeout(5000) });
      return r.ok;
    } catch { return false; }
  },
  async generate({ image, prompt, negativePrompt, mode, strength }) {
    const r = await fetch(`${INFERENCE_URL}/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        image,
        prompt,
        negative_prompt:    negativePrompt,
        mode,
        steps:              20,
        cfg_scale:          7,
        denoising_strength: strength,
      }),
      signal:  AbortSignal.timeout(GEN_TIMEOUT),
    });
    if (!r.ok) throw await httpError('inference', r);
    return (await r.json()).image;
  },
};

// ── Backend : OpenAI (ChatGPT / gpt-image) ──────────────────────────────────

function openaiSize(width, height) {
  const ratio = width / height;
  if (ratio > 1.2)  return '1536x1024';
  if (ratio < 0.83) return '1024x1536';
  return '1024x1024';
}

const openai = {
  id:    'openai',
  label: `ChatGPT / OpenAI (${OPENAI_IMAGE_MODEL})`,
  configured: () => !!OPENAI_API_KEY,
  async ready() { return !!OPENAI_API_KEY; },
  async generate({ image, prompt, negativePrompt, mode }) {
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY non configurée');
    const buf  = Buffer.from(image, 'base64');
    const meta = await sharp(buf).metadata();

    // L'API Images n'a pas de negative prompt : on le formule en consigne.
    const instruction = mode === 'encrage'
      ? 'Redraw this pencil sketch as clean final ink line art, keeping the exact same composition, poses and framing.'
      : 'Color this comic drawing, keeping the exact same composition, line art, poses and framing.';
    const fullPrompt = `${instruction} Style: ${prompt}.`
      + (negativePrompt ? ` Avoid: ${negativePrompt}.` : '');

    const fd = new FormData();
    fd.append('model',   OPENAI_IMAGE_MODEL);
    fd.append('prompt',  fullPrompt);
    fd.append('size',    openaiSize(meta.width, meta.height));
    fd.append('quality', OPENAI_IMAGE_QUALITY);
    fd.append('n',       '1');
    fd.append('image',   new Blob([buf], { type: 'image/png' }), 'sketch.png');

    const r = await fetch(`${OPENAI_BASE_URL}/images/edits`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body:    fd,
      signal:  AbortSignal.timeout(GEN_TIMEOUT),
    });
    if (!r.ok) throw await httpError('openai', r);
    const data = await r.json();
    const out  = data.data && data.data[0];
    if (out && out.b64_json) return out.b64_json;
    if (out && out.url) {
      const img = await fetch(out.url, { signal: AbortSignal.timeout(60000) });
      return Buffer.from(await img.arrayBuffer()).toString('base64');
    }
    throw new Error('openai : réponse sans image');
  },
};

// ── Backend : NovelAI ───────────────────────────────────────────────────────

/** Dimensions multiples de 64, surface ≤ 1024×1024 (gratuit en abonnement Opus). */
function novelaiDims(width, height) {
  const maxArea = 1024 * 1024;
  const scale   = Math.sqrt(maxArea / (width * height));
  const snap    = n => Math.max(64, Math.floor(n / 64) * 64);
  return { width: snap(width * scale), height: snap(height * scale) };
}

const novelai = {
  id:    'novelai',
  label: `NovelAI (${NOVELAI_MODEL})`,
  configured: () => !!NOVELAI_API_KEY,
  async ready() { return !!NOVELAI_API_KEY; },
  async generate({ image, prompt, negativePrompt, strength }) {
    if (!NOVELAI_API_KEY) throw new Error('NOVELAI_API_KEY non configurée');
    const buf  = Buffer.from(image, 'base64');
    const meta = await sharp(buf).metadata();
    const { width, height } = novelaiDims(meta.width, meta.height);
    const resized = (await sharp(buf).resize(width, height, { fit: 'fill' }).png().toBuffer())
      .toString('base64');

    const isV4  = /diffusion-4/.test(NOVELAI_MODEL);
    const is45  = /diffusion-4-5/.test(NOVELAI_MODEL);
    const seed  = Math.floor(Math.random() * 4294967295);
    // Paramètres alignés sur ceux envoyés par novelai.net (params_version 3)
    const parameters = {
      params_version:   3,
      width,
      height,
      scale:            5,
      sampler:          'k_euler_ancestral',
      steps:            NOVELAI_STEPS,
      n_samples:        1,
      seed,
      ucPreset:         0,
      qualityToggle:    true,
      negative_prompt:  negativePrompt,
      noise_schedule:   'karras',
      cfg_rescale:      0,
      sm:               false,
      sm_dyn:           false,
      dynamic_thresholding:           false,
      controlnet_strength:            1,
      legacy:                         false,
      legacy_uc:                      false,
      legacy_v3_extend:               false,
      add_original_image:             false,
      prefer_brownian:                true,
      deliberate_euler_ancestral_bug: false,
      skip_cfg_above_sigma:           null,
      use_coords:                     false,
      characterPrompts:               [],
      reference_image_multiple:                [],
      reference_information_extracted_multiple: [],
      reference_strength_multiple:             [],
      normalize_reference_strength_multiple:   true,
      // reference image (guide la génération sans img2img)
      reference_image_multiple:                [resized],
      reference_information_extracted_multiple: [1.0],
      reference_strength_multiple:             [0.6],
    };
    if (isV4) {
      parameters.v4_prompt = {
        caption:    { base_caption: prompt, char_captions: [] },
        use_coords: false,
        use_order:  true,
      };
      parameters.v4_negative_prompt = {
        caption:   { base_caption: negativePrompt, char_captions: [] },
        legacy_uc: false,
      };
    }
    if (!is45) delete parameters.skip_cfg_above_sigma;

    const r = await fetch(NOVELAI_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${NOVELAI_API_KEY}`,
        Origin:         'https://novelai.net',
        Referer:        'https://novelai.net/',
      },
      body: JSON.stringify({ input: prompt, model: NOVELAI_MODEL, action: 'generate', parameters }),
      signal: AbortSignal.timeout(GEN_TIMEOUT),
    });
    if (!r.ok) throw await httpError('novelai', r);
    const zip = Buffer.from(await r.arrayBuffer());
    return firstFileFromZip(zip).toString('base64');
  },
};

// ── Registre ────────────────────────────────────────────────────────────────

const BACKENDS = { local, openai, novelai };

// LOCAL_ENABLED=false permet de masquer le backend local (ex. VPS sans inference)
const LOCAL_ENABLED = (process.env.LOCAL_ENABLED || 'true').toLowerCase() !== 'false';

function available() {
  return Object.values(BACKENDS)
    .filter(b => b.configured() && (b.id !== 'local' || LOCAL_ENABLED));
}

function defaultBackendId() {
  const wanted = (process.env.DEFAULT_BACKEND || '').trim().toLowerCase();
  const list   = available();
  if (list.some(b => b.id === wanted)) return wanted;
  return list.length ? list[0].id : 'local';
}

function get(id) {
  const wanted = (id || defaultBackendId()).toLowerCase();
  const b = available().find(x => x.id === wanted);
  if (!b) throw new Error(`Backend « ${wanted} » inconnu ou non configuré`);
  return b;
}

module.exports = { get, available, defaultBackendId, firstFileFromZip, novelaiDims, openaiSize };
