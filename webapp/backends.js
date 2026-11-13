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
//   generate({ image, prompt, negativePrompt, mode, strength, params }) → base64 PNG
//
// `params` déclare les réglages ajustables depuis l'interface (par moteur).
// Les valeurs reçues sont filtrées et bornées par sanitizeParams() ; une
// valeur absente reprend la valeur par défaut (variables d'environnement).
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

// Force de transformation commune (img2img) : vide = auto selon le mode
const STRENGTH_PARAM = {
  key: 'strength', label: 'Force de transformation', type: 'number',
  min: 0.05, max: 0.99, step: 0.05, default: null,
  hint: 'Vide = auto selon le mode. Plus élevé = s’éloigne davantage du croquis.',
};

/** Ne garde que les paramètres déclarés par le backend, bornés et typés. */
function sanitizeParams(backend, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const def of backend.params || []) {
    const v = raw[def.key];
    if (v === undefined || v === null || v === '') continue;
    if (def.type === 'number') {
      let n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (def.integer) n = Math.round(n);
      n = Math.min(def.max, Math.max(def.min, n));
      out[def.key] = n;
    } else if (def.type === 'select') {
      if (def.options.some(o => o.value === String(v))) out[def.key] = String(v);
    }
  }
  return out;
}

/** Valeur effective d'un paramètre : celle reçue, sinon la valeur par défaut. */
function param(backend, params, key) {
  if (params && params[key] !== undefined) return params[key];
  const def = (backend.params || []).find(d => d.key === key);
  return def ? def.default : undefined;
}

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
  params: [
    { key: 'steps', label: 'Étapes', type: 'number', integer: true, min: 5, max: 50, step: 1, default: 20,
      hint: 'Plus d’étapes = plus de détails, mais plus lent sur CPU.' },
    { key: 'cfg_scale', label: 'Guidance (CFG)', type: 'number', min: 1, max: 15, step: 0.5, default: 7,
      hint: 'Fidélité au prompt.' },
  ],
  async generate({ image, prompt, negativePrompt, mode, strength, params }) {
    const r = await fetch(`${INFERENCE_URL}/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        image,
        prompt,
        negative_prompt:    negativePrompt,
        mode,
        steps:              param(local, params, 'steps'),
        cfg_scale:          param(local, params, 'cfg_scale'),
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
  params: [
    { key: 'quality', label: 'Qualité', type: 'select', default: OPENAI_IMAGE_QUALITY,
      options: [
        { value: 'low', label: 'Basse' }, { value: 'medium', label: 'Moyenne' },
        { value: 'high', label: 'Haute' }, { value: 'auto', label: 'Auto' },
      ],
      hint: 'Haute qualité = plus cher et plus lent.' },
    { key: 'input_fidelity', label: 'Fidélité au croquis', type: 'select', default: '',
      options: [
        { value: '', label: 'Par défaut' }, { value: 'low', label: 'Basse' }, { value: 'high', label: 'Haute' },
      ],
      hint: 'Haute = conserve mieux les traits et la composition du croquis.' },
  ],
  async generate({ image, prompt, negativePrompt, mode, params }) {
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
    fd.append('quality', param(openai, params, 'quality'));
    const fidelity = param(openai, params, 'input_fidelity');
    if (fidelity) fd.append('input_fidelity', fidelity);
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
  label: 'NovelAI',
  configured: () => !!NOVELAI_API_KEY,
  async ready() { return !!NOVELAI_API_KEY; },
  params: [
    { key: 'model', label: 'Modèle', type: 'select', default: NOVELAI_MODEL,
      options: [...new Set([NOVELAI_MODEL,
        'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated',
        'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview', 'nai-diffusion-3'])]
        .map(v => ({ value: v, label: v })) },
    STRENGTH_PARAM,
    { key: 'noise', label: 'Bruit ajouté', type: 'number', min: 0, max: 0.99, step: 0.05, default: 0,
      hint: 'Ajoute de la variation et des détails ; trop élevé = perte de la composition.' },
    { key: 'steps', label: 'Étapes', type: 'number', integer: true, min: 1, max: 50, step: 1, default: NOVELAI_STEPS,
      hint: 'Au-delà de 28 étapes, la génération consomme des Anlas.' },
    { key: 'scale', label: 'Guidance (CFG)', type: 'number', min: 1, max: 10, step: 0.5, default: 5,
      hint: 'Fidélité au prompt.' },
    { key: 'sampler', label: 'Sampler', type: 'select', default: 'k_euler_ancestral',
      options: ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m_sde', 'k_dpmpp_2m', 'k_dpmpp_sde']
        .map(v => ({ value: v, label: v })) },
  ],
  async generate({ image, prompt, negativePrompt, strength, params }) {
    if (!NOVELAI_API_KEY) throw new Error('NOVELAI_API_KEY non configurée');
    const buf  = Buffer.from(image, 'base64');
    const meta = await sharp(buf).metadata();
    const { width, height } = novelaiDims(meta.width, meta.height);
    const resized = (await sharp(buf).resize(width, height, { fit: 'fill' }).png().toBuffer())
      .toString('base64');

    const model = param(novelai, params, 'model');
    const isV4  = /diffusion-4/.test(model);
    const is45  = /diffusion-4-5/.test(model);
    const seed  = Math.floor(Math.random() * 4294967295);
    // Paramètres alignés sur ceux envoyés par novelai.net (params_version 3)
    const parameters = {
      params_version:   3,
      width,
      height,
      scale:            param(novelai, params, 'scale'),
      sampler:          param(novelai, params, 'sampler'),
      steps:            param(novelai, params, 'steps'),
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
      add_original_image:             true,
      prefer_brownian:                true,
      deliberate_euler_ancestral_bug: false,
      skip_cfg_above_sigma:           null,
      use_coords:                     false,
      characterPrompts:               [],
      reference_image_multiple:                [],
      reference_information_extracted_multiple: [],
      reference_strength_multiple:             [],
      normalize_reference_strength_multiple:   true,
      // img2img : le croquis sert de base. Pas de vibe transfer avec l'image brute :
      // les modèles V4/V4.5 exigent des vibes pré-encodées (/ai/encode-vibe) et
      // renvoient sinon une erreur 500. Pour s'éloigner davantage du trait d'origine,
      // augmenter NOVELAI_STRENGTH (ex. 0.75–0.85).
      image:            resized,
      strength,
      noise:            param(novelai, params, 'noise'),
      extra_noise_seed: seed,
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
      body: JSON.stringify({ input: prompt, model, action: 'img2img', parameters }),
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

module.exports = { get, available, defaultBackendId, sanitizeParams, firstFileFromZip, novelaiDims, openaiSize };
