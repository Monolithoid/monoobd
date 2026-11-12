'use strict';

const express   = require('express');
const session   = require('express-session');
const FileStore = require('session-file-store')(session);
const passport  = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const multer    = require('multer');
const sharp     = require('sharp');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const backends  = require('./backends');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL  || '';
const DOMAIN        = process.env.DOMAIN         || 'localhost';
if (!ALLOWED_EMAIL) console.warn('ALLOWED_EMAIL non défini : toutes les connexions seront refusées.');
const PORT          = 8080;
const PROJECTS_DIR  = '/data/projects';
const RENDERS_DIR   = '/data/renders';

if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!fs.existsSync(RENDERS_DIR))  fs.mkdirSync(RENDERS_DIR,  { recursive: true });

// ── Projets helpers ────────────────────────────────────────────────────────────────────────

function loadProject(id) {
  const file = path.join(PROJECTS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveProject(project) {
  fs.writeFileSync(
    path.join(PROJECTS_DIR, `${project.id}.json`),
    JSON.stringify(project, null, 2),
  );
}

function listProjects() {
  return fs.readdirSync(PROJECTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8'));
        return { id: p.id, name: p.name, createdAt: p.createdAt, renderCount: (p.renders || []).length };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function saveRenderFiles(renderId, originalB64, resultB64) {
  const dir = path.join(RENDERS_DIR, renderId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'original.png'), Buffer.from(originalB64, 'base64'));
  fs.writeFileSync(path.join(dir, 'result.png'),   Buffer.from(resultB64,   'base64'));
}

// ── Session ──────────────────────────────────────────────────────────────────────────────

app.use(session({
  store: new FileStore({
    path: '/data/sessions',
    ttl: 7 * 24 * 3600,
    retries: 1,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' },
}));

// ── Passport / Google SSO ───────────────────────────────────────────────────────────────────

passport.use(new GoogleStrategy(
  {
    clientID:     process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
    callbackURL:  `https://monoobd.${DOMAIN}/auth`,
  },
  (_at, _rt, profile, done) => {
    const email = profile.emails?.[0]?.value ?? '';
    // Refus par défaut : sans ALLOWED_EMAIL, personne ne peut se connecter
    // (sinon n'importe quel compte Google aurait accès et consommerait les clés API).
    if (!ALLOWED_EMAIL || email !== ALLOWED_EMAIL) return done(null, false);
    done(null, { email, name: profile.displayName });
  },
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

const auth = (req, res, next) =>
  req.isAuthenticated() ? next() : res.redirect('/login');

// ── Auth routes ──────────────────────────────────────────────────────────────────────────

app.get('/login', passport.authenticate('google', {
  scope: ['openid', 'email', 'profile'],
}));

app.get('/auth', passport.authenticate('google', {
  successRedirect: '/',
  failureRedirect: '/login',
}));

app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

// ── Pages ──────────────────────────────────────────────────────────────────────────────────

app.get('/', auth, (req, res) =>
  res.send(HTML.replace('{{USER}}', req.user.name)));

app.get('/gallery', auth, (req, res) =>
  res.send(GALLERY_HTML.replace('{{USER}}', req.user.name)));

// ── API : statut serveur ─────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  try {
    const backend = backends.get(req.query.backend);
    res.json({ ready: await backend.ready(), backend: backend.id });
  } catch (e) {
    res.json({ ready: false, error: e.message });
  }
});

// ── API : backends disponibles ─────────────────────────────────────────────────────────

app.get('/api/backends', auth, (_req, res) => {
  res.json({
    default:  backends.defaultBackendId(),
    backends: backends.available().map(b => ({ id: b.id, label: b.label })),
  });
});

// ── API : infos session ─────────────────────────────────────────────────────────────────

app.get('/api/session-info', auth, (req, res) => {
  res.json({
    lastRenderPrompt: req.session.lastRenderPrompt || '',
    lastBackend:      req.session.lastBackend      || '',
  });
});

// ── API : projets ──────────────────────────────────────────────────────────────────────────

app.get('/api/projects', auth, (_req, res) => {
  res.json(listProjects());
});

app.post('/api/projects', auth, (req, res) => {
  const { name, projectPrompt = '' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
  const project = {
    id: crypto.randomBytes(8).toString('hex'),
    name: name.trim(),
    createdAt: new Date().toISOString(),
    projectPrompt,
    renders: [],
  };
  saveProject(project);
  res.json(project);
});

app.get('/api/projects/:id', auth, (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projet introuvable' });
  res.json(project);
});

app.patch('/api/projects/:id', auth, (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projet introuvable' });
  const { name, projectPrompt } = req.body;
  if (name !== undefined) project.name = name.trim();
  if (projectPrompt !== undefined) project.projectPrompt = projectPrompt;
  saveProject(project);
  res.json({ id: project.id, name: project.name, projectPrompt: project.projectPrompt });
});

app.delete('/api/projects/:id', auth, (req, res) => {
  const file = path.join(PROJECTS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Projet introuvable' });
  fs.unlinkSync(file);
  res.json({ ok: true });
});

// ── API : gestion des rendus ─────────────────────────────────────────────────────────────

app.get('/api/renders/:id/original', auth, (req, res) => {
  const file = path.join(RENDERS_DIR, req.params.id, 'original.png');
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(file);
});

app.get('/api/renders/:id/result', auth, (req, res) => {
  const file = path.join(RENDERS_DIR, req.params.id, 'result.png');
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(file);
});

app.patch('/api/projects/:id/renders/reorder', auth, (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projet introuvable' });
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids requis' });
  const renderMap = Object.fromEntries((project.renders || []).map(r => [r.id, r]));
  const reordered = ids.filter(id => renderMap[id]).map(id => renderMap[id]);
  const remaining = (project.renders || []).filter(r => !ids.includes(r.id));
  project.renders = [...reordered, ...remaining];
  saveProject(project);
  res.json({ ok: true });
});

app.delete('/api/projects/:pid/renders/:rid', auth, (req, res) => {
  const project = loadProject(req.params.pid);
  if (!project) return res.status(404).json({ error: 'Projet introuvable' });
  const idx = (project.renders || []).findIndex(r => r.id === req.params.rid);
  if (idx === -1) return res.status(404).json({ error: 'Rendu introuvable' });
  project.renders.splice(idx, 1);
  saveProject(project);
  // original.png is kept as archive; only delete result.png to free space
  const resultFile = path.join(RENDERS_DIR, req.params.rid, 'result.png');
  if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
  res.json({ ok: true });
});

app.post('/api/projects/:pid/renders/:rid/relaunch', auth, async (req, res) => {
  try {
    const project = loadProject(req.params.pid);
    if (!project) return res.status(404).json({ error: 'Projet introuvable' });
    const render = (project.renders || []).find(r => r.id === req.params.rid);
    if (!render) return res.status(404).json({ error: 'Rendu introuvable' });

    const originalFile = path.join(RENDERS_DIR, req.params.rid, 'original.png');
    if (!fs.existsSync(originalFile))
      return res.status(404).json({ error: 'Croquis original introuvable (rendu trop ancien)' });

    const b64          = fs.readFileSync(originalFile).toString('base64');
    const renderPrompt = req.body.renderPrompt ?? render.renderPrompt;
    const type         = render.type;
    const backendId    = req.body.backend || render.backend || backends.defaultBackendId();

    const resultB64 = await renderSketch(backendId, type, b64,
      project.projectPrompt, renderPrompt);

    const newId = crypto.randomBytes(6).toString('hex');
    saveRenderFiles(newId, b64, resultB64);

    const newRender = {
      id:           newId,
      type,
      backend:      backendId,
      timestamp:    new Date().toISOString(),
      renderPrompt,
      thumbnail:    await toThumbnail(resultB64),
      hasFiles:     true,
      relaunchedFrom: req.params.rid,
    };
    project.renders.push(newRender);
    saveProject(project);

    res.json({ image: resultB64, render: newRender });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Helpers image ────────────────────────────────────────────────────────────────────────

async function toB64(buffer, maxDim = 768) {
  const img  = sharp(buffer);
  const meta = await img.metadata();
  const scale = maxDim / Math.max(meta.width, meta.height);
  const out = scale < 1
    ? img.resize(Math.round(meta.width * scale), Math.round(meta.height * scale))
    : img;
  return (await out.png().toBuffer()).toString('base64');
}

async function toThumbnail(b64, maxDim = 200) {
  const buf  = Buffer.from(b64, 'base64');
  const img  = sharp(buf);
  const meta = await img.metadata();
  const scale = maxDim / Math.max(meta.width, meta.height);
  const out = scale < 1
    ? img.resize(Math.round(meta.width * scale), Math.round(meta.height * scale))
    : img;
  return 'data:image/png;base64,' + (await out.png().toBuffer()).toString('base64');
}

// Prompts de style par mode (communs à tous les backends)
const STYLES = {
  encrage: {
    prompt:   'manga line art, ligne claire style, Herge Tintin, black and white, '
            + 'crisp clean bold outlines, no color, ink drawing, '
            + 'professional Belgian comic book art, flat style',
    negative: 'color, blur, rough sketch, pencil marks, shading, '
            + 'crosshatching, watermark, signature, low quality, noise, grain',
    strength: 0.7,
    // NovelAI (V4/V4.5) : prompt en tags, sans « flat / no shadows » qui
    // simplifient fortement le rendu. qualityToggle ajoute déjà les tags qualité.
    novelai: {
      prompt:   'comic book page, detailed clean lineart, ink, monochrome, greyscale, '
              + 'bold confident outlines, detailed background, intricate details, '
              + 'professional comic art, ligne claire',
      negative: 'color, sketch, rough lines, messy lines, pencil, blurry, lowres, '
              + 'jpeg artifacts, watermark, signature, text, simple background',
    },
  },
  colorisation: {
    prompt:   'Belgian comic book, Tintin Herge style, ligne claire, '
            + 'vibrant flat colors, bright primary colors, '
            + 'clean coloring, no shadows, professional colored illustration',
    negative: 'black and white, monochrome, dark, heavy shadows, '
            + 'photorealistic, blurry, watermark, signature, low quality',
    strength: 0.5,
    novelai: {
      prompt:   'comic book illustration, full color, detailed coloring, '
              + 'rich vibrant colors, soft shading, lighting, detailed background, '
              + 'intricate details, professional comic art, ligne claire',
      negative: 'monochrome, greyscale, sketch, unfinished, flat color, blurry, lowres, '
              + 'jpeg artifacts, watermark, signature, text, simple background',
      strength: 0.6,
    },
  },
};

// Style effectif pour un backend : surcharge éventuelle (ex. STYLES.encrage.novelai)
function styleFor(mode, backendId) {
  const base = STYLES[mode];
  if (!base) throw new Error(`mode invalide : ${mode}`);
  const style = { ...base, ...(base[backendId] || {}) };
  const envStrength = parseFloat(process.env[`${backendId.toUpperCase()}_STRENGTH`] || '');
  if (!Number.isNaN(envStrength)) style.strength = envStrength;
  return style;
}

// Les API distantes acceptent des images plus grandes que le CPU local
function maxInputDim(backendId) {
  return backendId === 'local' ? 768 : 1536;
}

async function renderSketch(backendId, mode, image, projectPrompt, renderPrompt) {
  const style = styleFor(mode, backendId);
  return backends.get(backendId).generate({
    image,
    prompt:         buildPrompt(style.prompt, projectPrompt, renderPrompt),
    negativePrompt: style.negative,
    mode,
    strength:       style.strength,
  });
}

function buildPrompt(base, projectPrompt, renderPrompt) {
  let p = base;
  if (projectPrompt && projectPrompt.trim()) p += ', ' + projectPrompt.trim();
  if (renderPrompt  && renderPrompt.trim())  p += ', ' + renderPrompt.trim();
  return p;
}

// ── API : rendu ─────────────────────────────────────────────────────────────────────────────

for (const mode of Object.keys(STYLES)) {
  app.post(`/api/${mode}`, auth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
      const { projectId, renderPrompt = '' } = req.body;
      const backendId = backends.get(req.body.backend).id;
      const project   = projectId ? loadProject(projectId) : null;
      const b64       = await toB64(req.file.buffer, maxInputDim(backendId));
      const resultB64 = await renderSketch(backendId, mode, b64,
        project ? project.projectPrompt : '', renderPrompt);
      if (project) {
        const renderId = crypto.randomBytes(6).toString('hex');
        saveRenderFiles(renderId, b64, resultB64);
        project.renders.push({
          id:        renderId,
          type:      mode,
          backend:   backendId,
          timestamp: new Date().toISOString(),
          renderPrompt,
          thumbnail: await toThumbnail(resultB64),
          hasFiles:  true,
        });
        saveProject(project);
      }
      req.session.lastRenderPrompt = renderPrompt;
      req.session.lastBackend      = backendId;
      res.json({ image: resultB64, backend: backendId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

app.listen(PORT, '0.0.0.0', () => console.log(`MonooBD :${PORT}`));

// ── HTML inline — page principale ────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MonooBD</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
header{background:#1e293b;padding:.875rem 1.5rem;display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #334155}
.logo{font-size:1.25rem;font-weight:800;letter-spacing:-.5px}
.logo span{color:#f97316}
.meta{font-size:.8rem;color:#94a3b8;display:flex;align-items:center;gap:.75rem}
.meta a{color:#fb923c;text-decoration:none}
.btn-gallery{background:#7c3aed;color:#fff;padding:.375rem .875rem;border-radius:6px;font-size:.78rem;font-weight:600;text-decoration:none}
.btn-gallery:hover{background:#6d28d9}
.container{max-width:1100px;margin:2rem auto;padding:0 1.25rem}

/* Projets */
.project-bar{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1rem 1.25rem;margin-bottom:1.25rem}
.project-bar h2{font-size:.75rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.625rem}
.project-row{display:flex;gap:.625rem;align-items:center;flex-wrap:wrap}
.project-row select{flex:1;min-width:160px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:.5rem .75rem;font-size:.875rem}
.project-row select:focus{outline:none;border-color:#f97316}
.btn-new{background:#16a34a;color:#fff;padding:.5rem 1rem;border:none;border-radius:8px;font-size:.8rem;cursor:pointer;font-weight:600}
.btn-new:hover{background:#15803d}
.btn-del{background:#7f1d1d;color:#fca5a5;padding:.5rem 1rem;border:none;border-radius:8px;font-size:.8rem;cursor:pointer;font-weight:600}
.btn-del:hover{background:#991b1b}
.prompt-field{margin-top:.75rem}
.prompt-field label{display:block;font-size:.75rem;color:#94a3b8;margin-bottom:.3rem;font-weight:600}
.prompt-field textarea{width:100%;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:.5rem .75rem;font-size:.85rem;resize:vertical;min-height:60px;font-family:inherit}
.prompt-field textarea:focus{outline:none;border-color:#f97316}
.prompt-field .hint{font-size:.7rem;color:#64748b;margin-top:.2rem}
.prompt-save-row{display:flex;justify-content:flex-end;margin-top:.4rem;align-items:center}
.btn-save{background:#1d4ed8;color:#fff;padding:.375rem .875rem;border:none;border-radius:6px;font-size:.78rem;cursor:pointer;font-weight:600}
.btn-save:hover{background:#2563eb}
.saved-flash{font-size:.75rem;color:#34d399;margin-left:.5rem;opacity:0;transition:opacity .3s}
.saved-flash.show{opacity:1}

/* Upload */
.drop-zone{border:2px dashed #334155;border-radius:12px;padding:2.5rem 2rem;
  text-align:center;cursor:pointer;transition:border-color .2s,background .2s;background:#1e293b}
.drop-zone:hover,.drop-zone.over{border-color:#f97316;background:#1c1f30}
.drop-zone p{color:#64748b;font-size:.85rem;margin-top:.375rem}
.icon{color:#f97316}
input[type=file]{display:none}
.fname{font-size:.875rem;color:#fdba74;margin-top:.5rem;font-weight:500}
.dz-thumb{display:none;max-width:160px;max-height:160px;margin:.75rem auto 0;border-radius:8px;border:1px solid #334155;background:#fff}
.dz-thumb.show{display:block}
.actions{display:flex;gap:.75rem;margin-top:1.25rem;justify-content:center;flex-wrap:wrap}
.backend-row{display:flex;gap:.5rem;align-items:center;justify-content:center;margin-top:1rem;font-size:.875rem;color:#94a3b8}
.backend-row select{background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:.4rem .75rem;font-size:.875rem;max-width:100%}
.backend-row select:focus{outline:none;border-color:#f97316}
button{padding:.625rem 1.75rem;border:none;border-radius:8px;font-size:.9rem;
  cursor:pointer;font-weight:600;transition:opacity .15s,transform .1s}
button:active{transform:scale(.97)}
button:disabled{opacity:.4;cursor:not-allowed}
.btn-ink{background:#1d4ed8;color:#fff}
.btn-ink:hover:not(:disabled){background:#2563eb}
.btn-col{background:#c2410c;color:#fff}
.btn-col:hover:not(:disabled){background:#ea580c}
.warn-no-project{background:#451a03;border:1px solid #92400e;color:#fcd34d;border-radius:8px;padding:.5rem .875rem;font-size:.78rem;margin-top:.75rem;display:none}
.warn-no-project.show{display:block}
.status{text-align:center;margin-top:1rem;font-size:.875rem;min-height:1.25rem;color:#94a3b8}
.status.loading{color:#fb923c}
.status.ok{color:#34d399}
.status.err{color:#f87171}
.spin{display:inline-block;width:10px;height:10px;border:2px solid currentColor;
  border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;
  margin-right:5px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.preview{display:none;margin-top:1.75rem;gap:1.25rem}
.preview.show{display:grid;grid-template-columns:1fr 1fr}
.panel{background:#1e293b;border-radius:12px;overflow:hidden;border:1px solid #334155}
.panel-title{padding:.5rem 1rem;font-size:.75rem;font-weight:600;color:#94a3b8;
  background:#0f172a;text-transform:uppercase;letter-spacing:.5px}
.panel img{width:100%;display:block;min-height:200px;background:#334155}

/* Historique */
.history{margin-top:1.75rem;display:none}
.history.show{display:block}
.history h3{font-size:.75rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.75rem}
.history-grid{display:flex;gap:.625rem;flex-wrap:wrap}
.hist-thumb{position:relative;border-radius:8px;overflow:hidden;border:2px solid #334155;cursor:pointer;transition:border-color .2s}
.hist-thumb:hover{border-color:#f97316}
.hist-thumb.sel{border-color:#f97316;box-shadow:0 0 0 2px rgba(249,115,22,.35)}
.hist-reuse{position:absolute;top:0;left:0;right:0;background:rgba(249,115,22,.9);color:#fff;
  font-size:.6rem;font-weight:600;padding:.15rem .3rem;text-align:center;opacity:0;transition:opacity .2s}
.hist-thumb:hover .hist-reuse{opacity:1}
.hist-thumb img{width:100px;height:100px;object-fit:cover;display:block;background:#334155}
.hist-label{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.65);
  font-size:.6rem;color:#e2e8f0;padding:.2rem .3rem;text-align:center;line-height:1.2}

@media(max-width:640px){.preview.show{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <div class="logo">Monoo<span>BD</span></div>
  <div class="meta">
    <a class="btn-gallery" href="/gallery">&#127912; Galerie des rendus</a>
    {{USER}}<a href="/logout">D&eacute;connexion</a>
  </div>
</header>
<div class="container">

  <!-- Projets -->
  <div class="project-bar">
    <h2>Projet</h2>
    <div class="project-row">
      <select id="projSel" onchange="onProjectChange()">
        <option value="">-- Aucun projet --</option>
      </select>
      <button class="btn-new" onclick="openNewProject()">+ Nouveau</button>
      <button class="btn-del" id="btnDelProj" style="display:none" onclick="deleteProject()">Supprimer</button>
    </div>
    <div id="projPromptSection" style="display:none">
      <div class="prompt-field" style="margin-top:.875rem">
        <label>Prompt projet <span style="color:#64748b;font-weight:400">(appliqu&eacute; &agrave; tous les rendus)</span></label>
        <textarea id="projPrompt" rows="2" placeholder="Ex: style steampunk, palette chaude, personnages r&eacute;alistes..."></textarea>
        <div class="hint">Ce prompt s&apos;ajoute automatiquement &agrave; chaque rendu du projet.</div>
      </div>
      <div class="prompt-save-row">
        <button class="btn-save" onclick="saveProjectPrompt()">Enregistrer</button>
        <span class="saved-flash" id="savedFlash">Enregistr&eacute; &#10003;</span>
      </div>
    </div>
  </div>

  <!-- Avertissement sans projet -->
  <div class="warn-no-project" id="warnNoProj">
    &#9888; Aucun projet s&eacute;lectionn&eacute; &mdash; ce rendu ne sera <strong>pas sauvegard&eacute;</strong> dans la galerie.
    <a href="#" onclick="openNewProject();return false;" style="color:#fb923c;margin-left:.5rem">Cr&eacute;er un projet</a>
  </div>

  <!-- Upload -->
  <div class="drop-zone" id="dz">
    <input type="file" id="fi" accept="image/png,image/jpeg,image/webp">
    <svg class="icon" width="40" height="40" fill="none" stroke="currentColor"
         stroke-width="1.5" viewBox="0 0 24 24">
      <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M16 10l-4-4m0 0L8 10m4-4v12"/>
    </svg>
    <p>Glisse ton croquis ici ou <strong>clique pour parcourir</strong></p>
    <p>PNG &bull; JPG &bull; WebP &mdash; redimensionn&eacute; &agrave; 768&thinsp;px max c&ocirc;t&eacute; serveur</p>
    <div class="fname" id="fname"></div>
    <img class="dz-thumb" id="dzThumb" alt="Croquis s&eacute;lectionn&eacute;">
  </div>

  <!-- Prompt rendu -->
  <div class="prompt-field" style="margin-top:.875rem">
    <label>Prompt rendu <span style="color:#64748b;font-weight:400">(optionnel, sp&eacute;cifique &agrave; ce rendu)</span></label>
    <textarea id="renderPrompt" rows="2" placeholder="Ex: personnage debout, fond for&ecirc;t, lumi&egrave;re dramatique..."></textarea>
    <div class="hint">Pr&eacute;-rempli avec le dernier prompt utilis&eacute;. Sera m&eacute;moris&eacute; pour le prochain rendu.</div>
  </div>

  <div class="backend-row">
    <label for="backendSel">Moteur IA</label>
    <select id="backendSel" onchange="onBackendChange()"></select>
  </div>

  <div class="actions">
    <button class="btn-ink" id="bInk" disabled onclick="run('encrage')">
      &#9998;&nbsp;Encrer (B&amp;W ligne claire)
    </button>
    <button class="btn-col" id="bCol" disabled onclick="run('colorisation')">
      &#127912;&nbsp;Coloriser
    </button>
  </div>
  <div class="status" id="st"></div>

  <div class="preview" id="pv">
    <div class="panel">
      <div class="panel-title">Original</div>
      <img id="imgOrig" alt="Original">
    </div>
    <div class="panel">
      <div class="panel-title" id="resTitle">R&eacute;sultat</div>
      <img id="imgRes" alt="R&eacute;sultat">
    </div>
  </div>

  <!-- Historique rendus du projet -->
  <div class="history" id="history">
    <h3>Historique du projet <span style="text-transform:none;letter-spacing:0;font-weight:400;color:#64748b">&mdash; clique sur un rendu pour repasser son croquis</span></h3>
    <div class="history-grid" id="histGrid"></div>
  </div>

</div>

<script>
var file = null;
var currentProjectId = null;
var dz   = document.getElementById('dz');
var fi   = document.getElementById('fi');
var bInk = document.getElementById('bInk');
var bCol = document.getElementById('bCol');
var pv   = document.getElementById('pv');
var st   = document.getElementById('st');
var imgOrig  = document.getElementById('imgOrig');
var imgRes   = document.getElementById('imgRes');
var fname    = document.getElementById('fname');
var dzThumb  = document.getElementById('dzThumb');
var resTitle = document.getElementById('resTitle');
var projSel  = document.getElementById('projSel');
var projPromptSection = document.getElementById('projPromptSection');
var projPrompt = document.getElementById('projPrompt');
var renderPrompt = document.getElementById('renderPrompt');
var btnDelProj = document.getElementById('btnDelProj');
var savedFlash   = document.getElementById('savedFlash');
var warnNoProj   = document.getElementById('warnNoProj');
var histDiv  = document.getElementById('history');
var histGrid = document.getElementById('histGrid');
var backendSel = document.getElementById('backendSel');
var readyTimer = null;

// Drag & drop
dz.onclick = function(){ fi.click(); };
dz.ondragover = function(e){ e.preventDefault(); dz.classList.add('over'); };
dz.ondragleave = function(){ dz.classList.remove('over'); };
dz.ondrop = function(e){
  e.preventDefault(); dz.classList.remove('over');
  if(e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]);
};
fi.onchange = function(){ if(fi.files[0]) pick(fi.files[0]); };

function pick(f, label){
  file = f;
  fname.textContent = label || f.name;
  if(dzThumb.src && dzThumb.src.indexOf('blob:') === 0) URL.revokeObjectURL(dzThumb.src);
  dzThumb.src = URL.createObjectURL(f);
  dzThumb.classList.add('show');
  if(!label) markHistSel(null);
  bInk.disabled = false;
  bCol.disabled = false;
  pv.classList.remove('show');
  setStatus('');
}

function setStatus(msg, cls){
  st.className = 'status ' + (cls || '');
  st.innerHTML = (cls === 'loading' ? '<span class="spin"></span>' : '') + msg;
}

// ── Projets ──────────────────────────────────────────────────────────────────────────────

async function loadProjects(){
  var list = await fetch('/api/projects').then(function(r){ return r.json(); }).catch(function(){ return []; });
  var prev = projSel.value;
  while(projSel.options.length > 1) projSel.remove(1);
  list.forEach(function(p){
    var opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + ' (' + p.renderCount + ' rendu' + (p.renderCount !== 1 ? 's' : '') + ')';
    projSel.appendChild(opt);
  });
  if(prev) projSel.value = prev;
  return list;
}

async function onProjectChange(){
  currentProjectId = projSel.value || null;
  btnDelProj.style.display = currentProjectId ? '' : 'none';
  warnNoProj.classList.toggle('show', !currentProjectId);
  if(!currentProjectId){
    projPromptSection.style.display = 'none';
    histDiv.classList.remove('show');
    return;
  }
  projPromptSection.style.display = '';
  var proj = await fetch('/api/projects/' + currentProjectId).then(function(r){ return r.json(); }).catch(function(){ return null; });
  if(!proj) return;
  projPrompt.value = proj.projectPrompt || '';
  renderHistory(proj.renders || []);
}

function renderHistory(renders){
  histGrid.innerHTML = '';
  if(!renders.length){ histDiv.classList.remove('show'); return; }
  histDiv.classList.add('show');
  renders.slice().reverse().forEach(function(r){
    var div = document.createElement('div');
    div.className = 'hist-thumb';
    div.title = r.renderPrompt || r.type;
    var img = document.createElement('img');
    img.src = r.hasFiles ? '/api/renders/' + r.id + '/result' : r.thumbnail;
    img.alt = r.type;
    var lbl = document.createElement('div');
    lbl.className = 'hist-label';
    lbl.textContent = r.type + (r.renderPrompt ? ' — ' + r.renderPrompt.slice(0, 20) : '');
    div.appendChild(img);
    div.appendChild(lbl);
    div.dataset.renderId = r.id;
    if(r.hasFiles){
      var reuse = document.createElement('div');
      reuse.className = 'hist-reuse';
      reuse.textContent = '↻ Repasser';
      div.appendChild(reuse);
    }
    div.onclick = function(){ reuseRender(r); };
    histGrid.appendChild(div);
  });
}

function markHistSel(id){
  [].forEach.call(histGrid.children, function(el){
    el.classList.toggle('sel', !!id && el.dataset.renderId === id);
  });
}

// Recharge le croquis original d'un rendu de l'historique comme fichier courant
async function reuseRender(r){
  renderPrompt.value = r.renderPrompt || '';
  if(!r.hasFiles){
    setStatus('Croquis original non disponible pour ce rendu (trop ancien) — seul le prompt a été repris.', 'err');
    return;
  }
  try {
    var resp = await fetch('/api/renders/' + r.id + '/original');
    if(!resp.ok) throw new Error('croquis original introuvable');
    var blob = await resp.blob();
    var f = new File([blob], 'croquis-' + r.id + '.png', { type: 'image/png' });
    var d = r.timestamp ? new Date(r.timestamp).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';
    pick(f, 'Croquis de l\u2019historique (' + r.type + (d ? ', ' + d : '') + ')');
    markHistSel(r.id);
    setStatus('Croquis rechargé — choisis Encrer ou Coloriser pour le repasser.', 'ok');
    dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch(e) {
    setStatus('Erreur : ' + e.message, 'err');
  }
}

async function saveProjectPrompt(){
  if(!currentProjectId) return;
  await fetch('/api/projects/' + currentProjectId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPrompt: projPrompt.value }),
  });
  savedFlash.classList.add('show');
  setTimeout(function(){ savedFlash.classList.remove('show'); }, 2000);
}

async function openNewProject(){
  var name = window.prompt('Nom du projet :', 'Mon projet BD');
  if(!name || !name.trim()) return;
  var proj = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), projectPrompt: '' }),
  }).then(function(r){ return r.json(); });
  await loadProjects();
  projSel.value = proj.id;
  await onProjectChange();
}

async function deleteProject(){
  if(!currentProjectId) return;
  var name = projSel.options[projSel.selectedIndex].text;
  if(!window.confirm('Supprimer « ' + name + ' » et tous ses rendus ?')) return;
  await fetch('/api/projects/' + currentProjectId, { method: 'DELETE' });
  currentProjectId = null;
  projSel.value = '';
  await loadProjects();
  await onProjectChange();
}

// ── Rendu ──────────────────────────────────────────────────────────────────────────────────

async function run(action){
  if(!file) return;
  var r = new FileReader();
  r.onload = function(e){ imgOrig.src = e.target.result; };
  r.readAsDataURL(file);
  resTitle.textContent = action === 'encrage' ? 'Encrage ligne claire' : 'Colorisation';
  bInk.disabled = true; bCol.disabled = true;
  pv.classList.remove('show');
  setStatus(backendSel.value === 'local'
    ? 'Génération en cours… peut prendre 10–30 min sur CPU'
    : 'Génération en cours via ' + backendSel.options[backendSel.selectedIndex].text + '…', 'loading');
  try {
    var fd = new FormData();
    fd.append('file', file);
    fd.append('renderPrompt', renderPrompt.value);
    fd.append('backend', backendSel.value);
    if(currentProjectId) fd.append('projectId', currentProjectId);
    var resp = await fetch('/api/' + action, { method: 'POST', body: fd });
    var data = await resp.json();
    if(data.error) throw new Error(data.error);
    imgRes.src = 'data:image/png;base64,' + data.image;
    pv.classList.add('show');
    setStatus('Terminé ✓', 'ok');
    if(currentProjectId){
      var proj = await fetch('/api/projects/' + currentProjectId).then(function(r){ return r.json(); }).catch(function(){ return null; });
      if(proj) renderHistory(proj.renders || []);
      await loadProjects();
      projSel.value = currentProjectId;
    }
  } catch(e) {
    setStatus('Erreur : ' + e.message, 'err');
  } finally {
    bInk.disabled = false; bCol.disabled = false;
  }
}

// ── Moteur IA ─────────────────────────────────────────────────────────────────────────

function onBackendChange(){
  setStatus('');
  pollReady();
}

async function pollReady(){
  clearTimeout(readyTimer);
  var data = await fetch('/api/status?backend=' + encodeURIComponent(backendSel.value))
    .then(function(r){ return r.json(); }).catch(function(){ return { ready: false }; });
  if(!data.ready){
    setStatus(data.error ? 'Moteur indisponible : ' + data.error : 'Serveur IA en cours de démarrage…');
    readyTimer = setTimeout(pollReady, 10000);
  } else if(st.className.indexOf('loading') < 0) {
    setStatus('');
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────────────────────

(async function init(){
  await loadProjects();
  warnNoProj.classList.toggle('show', !currentProjectId);
  var info = await fetch('/api/session-info').then(function(r){ return r.json(); }).catch(function(){ return {}; });
  if(info.lastRenderPrompt) renderPrompt.value = info.lastRenderPrompt;

  var bk = await fetch('/api/backends').then(function(r){ return r.json(); }).catch(function(){ return { backends: [] }; });
  (bk.backends || []).forEach(function(b){
    var opt = document.createElement('option');
    opt.value = b.id; opt.textContent = b.label;
    backendSel.appendChild(opt);
  });
  var wanted = info.lastBackend || bk.default;
  if(wanted && (bk.backends || []).some(function(b){ return b.id === wanted; })) backendSel.value = wanted;
  pollReady();
})();
</script>
</body>
</html>`;

// ── HTML inline — galerie ─────────────────────────────────────────────────────────────────────
const GALLERY_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MonooBD — Galerie</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
header{background:#1e293b;padding:.875rem 1.5rem;display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #334155}
.logo{font-size:1.25rem;font-weight:800;letter-spacing:-.5px}
.logo span{color:#f97316}
.meta{font-size:.8rem;color:#94a3b8;display:flex;align-items:center;gap:.75rem}
.meta a{color:#fb923c;text-decoration:none}
.btn-back{background:#334155;color:#e2e8f0;padding:.375rem .875rem;border-radius:6px;font-size:.78rem;font-weight:600;text-decoration:none}
.btn-back:hover{background:#475569}
.container{max-width:1200px;margin:2rem auto;padding:0 1.25rem}

/* Toolbar */
.toolbar{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;margin-bottom:1.5rem;background:#1e293b;padding:.875rem 1.25rem;border-radius:12px;border:1px solid #334155}
.toolbar label{font-size:.8rem;color:#94a3b8;font-weight:600}
.toolbar select{background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:.45rem .75rem;font-size:.85rem}
.toolbar select:focus{outline:none;border-color:#f97316}
.view-btns{display:flex;gap:.375rem;margin-left:auto}
.view-btn{background:#334155;border:none;color:#94a3b8;padding:.4rem .75rem;border-radius:6px;cursor:pointer;font-size:.8rem;font-weight:600}
.view-btn.active{background:#f97316;color:#fff}

/* Project section */
.project-section{margin-bottom:2.5rem}
.project-heading{display:flex;align-items:center;gap:.75rem;margin-bottom:1rem;padding-bottom:.625rem;border-bottom:1px solid #334155}
.project-heading h2{font-size:1rem;font-weight:700}
.render-count{font-size:.75rem;color:#64748b;background:#1e293b;padding:.2rem .5rem;border-radius:4px}
.empty-state{color:#475569;font-size:.875rem;padding:2rem;text-align:center;background:#1e293b;border-radius:12px;border:1px dashed #334155}

/* BD grid */
.bd-grid{display:grid;gap:1rem}
.bd-grid.grid-2{grid-template-columns:repeat(2,1fr)}
.bd-grid.grid-3{grid-template-columns:repeat(3,1fr)}
.bd-grid.grid-4{grid-template-columns:repeat(4,1fr)}
@media(max-width:900px){.bd-grid.grid-3,.bd-grid.grid-4{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.bd-grid{grid-template-columns:1fr!important}}

/* Panel card */
.render-card{background:#1e293b;border:2px solid #334155;border-radius:10px;overflow:hidden;transition:border-color .15s;cursor:grab;position:relative}
.render-card:hover{border-color:#475569}
.render-card.dragging{opacity:.4;border-color:#f97316;cursor:grabbing}
.render-card.drag-over{border-color:#f97316;border-style:dashed}
.card-img-wrap{position:relative;background:#0f172a;min-height:120px}
.card-img-wrap img{width:100%;display:block;cursor:pointer}
.card-img-wrap img:hover{opacity:.9}
.no-img{display:flex;align-items:center;justify-content:center;min-height:120px;color:#475569;font-size:.8rem}
.card-footer{padding:.625rem .75rem;background:#0f172a;border-top:1px solid #1e293b}
.card-meta{display:flex;align-items:center;gap:.375rem;margin-bottom:.375rem;flex-wrap:wrap}
.badge{font-size:.65rem;font-weight:700;padding:.15rem .45rem;border-radius:4px;text-transform:uppercase}
.badge-enc{background:#1e3a5f;color:#93c5fd}
.badge-col{background:#431407;color:#fed7aa}
.badge-rel{background:#14532d;color:#86efac;font-size:.6rem}
.card-date{font-size:.65rem;color:#475569;margin-left:auto}
.card-prompt{font-size:.72rem;color:#94a3b8;line-height:1.3;margin-bottom:.5rem;min-height:.9rem}
.card-actions{display:flex;gap:.375rem;flex-wrap:wrap}
.ca{padding:.3rem .6rem;border:none;border-radius:5px;font-size:.7rem;font-weight:600;cursor:pointer;transition:opacity .15s}
.ca:hover{opacity:.8}
.ca-view{background:#1d4ed8;color:#fff}
.ca-cmp{background:#0f766e;color:#fff}
.ca-relaunch{background:#7c3aed;color:#fff}
.ca-del{background:#7f1d1d;color:#fca5a5}
.ca:disabled{opacity:.3;cursor:not-allowed}
.drag-handle{position:absolute;top:.4rem;left:.4rem;background:rgba(0,0,0,.55);border-radius:4px;padding:.2rem .35rem;font-size:.7rem;color:#94a3b8;cursor:grab;user-select:none}

/* Lightbox */
.lightbox{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:1000;align-items:center;justify-content:center;flex-direction:column}
.lightbox.show{display:flex}
.lightbox img{max-width:90vw;max-height:85vh;border-radius:8px;object-fit:contain}
.lb-close{position:absolute;top:1rem;right:1.5rem;font-size:2rem;color:#94a3b8;cursor:pointer;line-height:1}
.lb-close:hover{color:#fff}
.lb-caption{margin-top:.75rem;font-size:.8rem;color:#94a3b8;text-align:center}
.lb-dl{margin-top:.5rem;background:#334155;color:#e2e8f0;border:none;border-radius:6px;padding:.4rem .9rem;font-size:.78rem;font-weight:600;cursor:pointer}
.lb-dl:hover{background:#475569}

/* Compare overlay */
.compare-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:1001;flex-direction:column;align-items:center;justify-content:center}
.compare-overlay.show{display:flex}
.compare-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;max-width:92vw;max-height:85vh}
.compare-panel{background:#1e293b;border-radius:8px;overflow:hidden;border:1px solid #334155}
.compare-panel .cp-title{padding:.35rem .75rem;font-size:.72rem;color:#94a3b8;background:#0f172a;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.compare-panel img{max-width:100%;max-height:78vh;display:block;object-fit:contain}
.cmp-close{position:absolute;top:1rem;right:1.5rem;font-size:2rem;color:#94a3b8;cursor:pointer}
.cmp-close:hover{color:#fff}

/* Relaunch modal */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:1002;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.5rem;width:420px;max-width:95vw}
.modal h3{font-size:.95rem;font-weight:700;margin-bottom:1rem}
.modal label{display:block;font-size:.78rem;color:#94a3b8;margin-bottom:.3rem;font-weight:600}
.modal textarea{width:100%;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:.5rem .75rem;font-size:.85rem;resize:vertical;min-height:70px;font-family:inherit}
.modal textarea:focus{outline:none;border-color:#f97316}
.modal-actions{display:flex;justify-content:flex-end;gap:.5rem;margin-top:1rem}
.btn-cancel{background:#334155;color:#e2e8f0;padding:.5rem 1rem;border:none;border-radius:7px;font-size:.83rem;cursor:pointer;font-weight:600}
.btn-confirm{background:#7c3aed;color:#fff;padding:.5rem 1rem;border:none;border-radius:7px;font-size:.83rem;cursor:pointer;font-weight:600}
.btn-confirm:disabled{opacity:.4;cursor:not-allowed}
.modal-status{font-size:.78rem;color:#fb923c;margin-top:.5rem;min-height:1rem;text-align:center}

/* Spinner */
.spin{display:inline-block;width:10px;height:10px;border:2px solid currentColor;
  border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;
  margin-right:5px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.page-loading{text-align:center;padding:4rem;color:#475569}
</style>
</head>
<body>
<header>
  <div class="logo">Monoo<span>BD</span></div>
  <div class="meta">
    <a class="btn-back" href="/">&#8592; Nouvel encrage</a>
    {{USER}}<a href="/logout">D&eacute;connexion</a>
  </div>
</header>

<div class="container">
  <div class="toolbar">
    <label for="projFilter">Projet&nbsp;:</label>
    <select id="projFilter" onchange="applyFilter()">
      <option value="">Tous les projets</option>
    </select>
    <div class="view-btns">
      <button class="view-btn active" id="vb2" onclick="setColumns(2)">&#9646;&#9646;</button>
      <button class="view-btn" id="vb3" onclick="setColumns(3)">&#9646;&#9646;&#9646;</button>
      <button class="view-btn" id="vb4" onclick="setColumns(4)">&#9646;&#9646;&#9646;&#9646;</button>
    </div>
  </div>

  <div id="gallery"></div>
</div>

<!-- Lightbox -->
<div class="lightbox" id="lightbox" onclick="closeLightbox(event)">
  <span class="lb-close" onclick="closeLightbox()">&times;</span>
  <img id="lbImg" alt="">
  <div class="lb-caption" id="lbCaption"></div>
  <button class="lb-dl" id="lbDl" onclick="downloadLb()">T&eacute;l&eacute;charger</button>
</div>

<!-- Compare overlay -->
<div class="compare-overlay" id="compareOverlay" onclick="closeCmp(event)">
  <span class="cmp-close" onclick="closeCmp()">&times;</span>
  <div class="compare-grid">
    <div class="compare-panel">
      <div class="cp-title">Croquis original</div>
      <img id="cmpOrig" alt="Original">
    </div>
    <div class="compare-panel">
      <div class="cp-title">Rendu</div>
      <img id="cmpResult" alt="Rendu">
    </div>
  </div>
</div>

<!-- Relaunch modal -->
<div class="modal-overlay" id="relaunchModal">
  <div class="modal">
    <h3>&#9654; Relancer le rendu</h3>
    <label>Prompt (modifiable)</label>
    <textarea id="relaunchPrompt" rows="3"></textarea>
    <label style="margin-top:.75rem;display:block">Moteur IA</label>
    <select id="relaunchBackend" style="width:100%;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:.5rem .75rem;font-size:.875rem"></select>
    <div class="modal-status" id="relaunchStatus"></div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeRelaunch()">Annuler</button>
      <button class="btn-confirm" id="relaunchConfirm" onclick="confirmRelaunch()">G&eacute;n&eacute;rer</button>
    </div>
  </div>
</div>

<script>
var allProjects = [];
var columns = 2;
var relaunchTarget = null; // {projectId, renderId}

// ── Init ───────────────────────────────────────────────────────────────────────────────────

async function init() {
  document.getElementById('gallery').innerHTML = '<div class="page-loading"><span class="spin"></span> Chargement…</div>';
  allProjects = await loadAllProjects();
  populateFilter();
  renderGallery();
}

async function loadAllProjects() {
  var list = await fetch('/api/projects').then(function(r){ return r.json(); }).catch(function(){ return []; });
  var full = await Promise.all(list.map(function(p){
    return fetch('/api/projects/' + p.id).then(function(r){ return r.json(); }).catch(function(){ return null; });
  }));
  return full.filter(Boolean);
}

function populateFilter() {
  var sel = document.getElementById('projFilter');
  while (sel.options.length > 1) sel.remove(1);
  allProjects.forEach(function(p) {
    var opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
}

function applyFilter() {
  renderGallery();
}

function setColumns(n) {
  columns = n;
  ['vb2','vb3','vb4'].forEach(function(id){ document.getElementById(id).classList.remove('active'); });
  document.getElementById('vb' + n).classList.add('active');
  document.querySelectorAll('.bd-grid').forEach(function(g){
    g.className = 'bd-grid grid-' + n;
  });
}

// ── Render gallery ────────────────────────────────────────────────────────────────────────

function renderGallery() {
  var filterPid = document.getElementById('projFilter').value;
  var projects = filterPid ? allProjects.filter(function(p){ return p.id === filterPid; }) : allProjects;
  var gallery = document.getElementById('gallery');
  gallery.innerHTML = '';

  if (!projects.length) {
    gallery.innerHTML = '<div class="empty-state">Aucun projet trouvé. Commencez par créer un projet sur la page principale.</div>';
    return;
  }

  projects.forEach(function(project) {
    var renders = project.renders || [];
    var section = document.createElement('div');
    section.className = 'project-section';
    section.dataset.projectId = project.id;

    var heading = document.createElement('div');
    heading.className = 'project-heading';
    heading.innerHTML = '<h2>' + esc(project.name) + '</h2>'
      + '<span class="render-count">' + renders.length + ' rendu' + (renders.length !== 1 ? 's' : '') + '</span>';
    section.appendChild(heading);

    if (!renders.length) {
      var empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Aucun rendu dans ce projet.';
      section.appendChild(empty);
    } else {
      var grid = document.createElement('div');
      grid.className = 'bd-grid grid-' + columns;
      grid.dataset.projectId = project.id;
      renders.forEach(function(render) {
        grid.appendChild(buildCard(project.id, render));
      });
      section.appendChild(grid);
    }

    gallery.appendChild(section);
  });
}

function buildCard(projectId, render) {
  var card = document.createElement('div');
  card.className = 'render-card';
  card.dataset.renderId = render.id;
  card.dataset.projectId = projectId;
  card.dataset.hasFiles = render.hasFiles ? 'true' : 'false';
  card.draggable = true;

  var imgSrc   = render.hasFiles ? '/api/renders/' + render.id + '/result' : (render.thumbnail || '');
  var hasFiles = !!render.hasFiles;
  var caption  = esc(render.type + (render.renderPrompt ? ' — ' + render.renderPrompt.slice(0, 40) : ''));

  card.innerHTML =
    '<div class="drag-handle" title="Glisser pour réordonner">&#8597;</div>'
    + '<div class="card-img-wrap">'
    +   (imgSrc
          ? '<img src="' + imgSrc + '" alt="Rendu" loading="lazy" onclick="openLightbox(\\'' + render.id + '\\',\\'' + caption + '\\')">'
          : '<div class="no-img">Pas d&rsquo;image disponible</div>')
    + '</div>'
    + '<div class="card-footer">'
    +   '<div class="card-meta">'
    +     '<span class="badge ' + (render.type === 'encrage' ? 'badge-enc' : 'badge-col') + '">' + render.type + '</span>'
    +     (render.relaunchedFrom ? '<span class="badge badge-rel">relancé</span>' : '')
    +     '<span class="badge badge-rel">' + esc(render.backend || 'local') + '</span>'
    +     '<span class="card-date">' + fmtDate(render.timestamp) + '</span>'
    +   '</div>'
    +   '<div class="card-prompt">' + esc(render.renderPrompt || '—') + '</div>'
    +   '<div class="card-actions">'
    +     '<button class="ca ca-view" onclick="openLightbox(\\'' + render.id + '\\',\\'' + caption + '\\')" ' + (imgSrc ? '' : 'disabled') + '>&#128065; Voir</button>'
    +     '<button class="ca ca-cmp" onclick="openCompare(\\'' + render.id + '\\')" ' + (hasFiles ? '' : 'disabled title="Fichiers non disponibles (rendu ancien)"') + '>&#9867; Comparer</button>'
    +     '<button class="ca ca-relaunch" onclick="openRelaunch(\\'' + projectId + '\\',\\'' + render.id + '\\',\\'' + esc(render.renderPrompt || '') + '\\')" ' + (hasFiles ? '' : 'disabled title="Croquis original non disponible (rendu ancien)"') + '>&#9654; Relancer</button>'
    +     '<button class="ca ca-del" onclick="deleteRender(\\'' + projectId + '\\',\\'' + render.id + '\\')">&#128465; Sup.</button>'
    +   '</div>'
    + '</div>';

  // Drag-and-drop
  card.addEventListener('dragstart', onDragStart);
  card.addEventListener('dragover',  onDragOver);
  card.addEventListener('dragleave', onDragLeave);
  card.addEventListener('drop',      onDrop);
  card.addEventListener('dragend',   onDragEnd);

  return card;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'2-digit' })
    + ' ' + d.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
}

// ── Drag & drop reorder ──────────────────────────────────────────────────────────────────

var dragSrcId   = null;
var dragProjId  = null;

function onDragStart(e) {
  dragSrcId  = this.dataset.renderId;
  dragProjId = this.dataset.projectId;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (this.dataset.projectId === dragProjId && this.dataset.renderId !== dragSrcId) {
    this.classList.add('drag-over');
  }
}

function onDragLeave() {
  this.classList.remove('drag-over');
}

async function onDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  if (!dragSrcId || this.dataset.renderId === dragSrcId) return;
  if (this.dataset.projectId !== dragProjId) return;

  var grid = this.closest('.bd-grid');
  var cards = Array.from(grid.querySelectorAll('.render-card'));
  var srcIdx = cards.findIndex(function(c){ return c.dataset.renderId === dragSrcId; });
  var dstIdx = cards.findIndex(function(c){ return c.dataset.renderId === e.currentTarget.dataset.renderId; });

  // Reorder in DOM immediately
  if (srcIdx < dstIdx) {
    grid.insertBefore(cards[srcIdx], cards[dstIdx].nextSibling);
  } else {
    grid.insertBefore(cards[srcIdx], cards[dstIdx]);
  }

  // Persist
  var newOrder = Array.from(grid.querySelectorAll('.render-card')).map(function(c){ return c.dataset.renderId; });
  await fetch('/api/projects/' + dragProjId + '/renders/reorder', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: newOrder }),
  });

  // Update local count label
  var proj = allProjects.find(function(p){ return p.id === dragProjId; });
  if (proj) {
    var ordered = newOrder.map(function(id){ return (proj.renders || []).find(function(r){ return r.id === id; }); }).filter(Boolean);
    var extra   = (proj.renders || []).filter(function(r){ return !newOrder.includes(r.id); });
    proj.renders = ordered.concat(extra);
  }
}

function onDragEnd() {
  this.classList.remove('dragging');
  document.querySelectorAll('.render-card').forEach(function(c){ c.classList.remove('drag-over'); });
  dragSrcId = null; dragProjId = null;
}

// ── Lightbox ────────────────────────────────────────────────────────────────────────────

var lbCurrentSrc = '';

function openLightbox(renderId, caption) {
  var card     = document.querySelector('.render-card[data-render-id="' + renderId + '"]');
  var hasFiles = card && card.dataset.hasFiles === 'true';
  var src;
  if (hasFiles) {
    src = '/api/renders/' + renderId + '/result';
  } else {
    var img = card && card.querySelector('.card-img-wrap img');
    src = img ? img.src : '';
  }
  if (!src) return;
  lbCurrentSrc = hasFiles ? src : '';
  document.getElementById('lbDl').style.display = hasFiles ? '' : 'none';
  document.getElementById('lbImg').src = src;
  document.getElementById('lbCaption').textContent = (caption || '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  document.getElementById('lightbox').classList.add('show');
}

function closeLightbox(e) {
  if (e && e.target !== document.getElementById('lightbox') && !e.target.classList.contains('lb-close')) return;
  document.getElementById('lightbox').classList.remove('show');
}

function downloadLb() {
  if (!lbCurrentSrc) return;
  var a = document.createElement('a');
  a.href = lbCurrentSrc;
  a.download = 'rendu.png';
  a.click();
}

// ── Compare ────────────────────────────────────────────────────────────────────────────

function openCompare(renderId) {
  document.getElementById('cmpOrig').src   = '/api/renders/' + renderId + '/original';
  document.getElementById('cmpResult').src = '/api/renders/' + renderId + '/result';
  document.getElementById('compareOverlay').classList.add('show');
}

function closeCmp(e) {
  if (e && e.target !== document.getElementById('compareOverlay') && !e.target.classList.contains('cmp-close')) return;
  document.getElementById('compareOverlay').classList.remove('show');
}

// ── Delete render ────────────────────────────────────────────────────────────────────────

async function deleteRender(projectId, renderId) {
  if (!confirm('Supprimer ce rendu ? Le croquis original restera archivé.')) return;
  var resp = await fetch('/api/projects/' + projectId + '/renders/' + renderId, { method: 'DELETE' });
  if (!resp.ok) { alert('Erreur lors de la suppression'); return; }

  // Remove card from DOM
  var card = document.querySelector('.render-card[data-render-id="' + renderId + '"]');
  if (card) card.remove();

  // Update local data
  var proj = allProjects.find(function(p){ return p.id === projectId; });
  if (proj) {
    proj.renders = (proj.renders || []).filter(function(r){ return r.id !== renderId; });
    // Update count label
    var section = document.querySelector('.project-section[data-project-id="' + projectId + '"]');
    if (section) {
      var countEl = section.querySelector('.render-count');
      if (countEl) countEl.textContent = proj.renders.length + ' rendu' + (proj.renders.length !== 1 ? 's' : '');
    }
  }
}

// ── Relaunch ────────────────────────────────────────────────────────────────────────────

async function loadBackends() {
  var sel = document.getElementById('relaunchBackend');
  if (sel.options.length) return;
  var bk = await fetch('/api/backends').then(function(r){ return r.json(); }).catch(function(){ return { backends: [] }; });
  (bk.backends || []).forEach(function(b){
    var opt = document.createElement('option');
    opt.value = b.id; opt.textContent = b.label;
    sel.appendChild(opt);
  });
}

async function openRelaunch(projectId, renderId, currentPrompt) {
  relaunchTarget = { projectId: projectId, renderId: renderId };
  await loadBackends();
  var proj   = allProjects.find(function(p){ return p.id === projectId; });
  var render = proj && (proj.renders || []).find(function(r){ return r.id === renderId; });
  var sel    = document.getElementById('relaunchBackend');
  var cur    = (render && render.backend) || 'local';
  if ([].some.call(sel.options, function(o){ return o.value === cur; })) sel.value = cur;
  document.getElementById('relaunchPrompt').value = currentPrompt || '';
  document.getElementById('relaunchStatus').textContent = '';
  document.getElementById('relaunchConfirm').disabled = false;
  document.getElementById('relaunchModal').classList.add('show');
}

function closeRelaunch() {
  document.getElementById('relaunchModal').classList.remove('show');
  relaunchTarget = null;
}

async function confirmRelaunch() {
  if (!relaunchTarget) return;
  var prompt = document.getElementById('relaunchPrompt').value;
  var btn    = document.getElementById('relaunchConfirm');
  var status = document.getElementById('relaunchStatus');
  btn.disabled = true;
  status.innerHTML = '<span class="spin"></span> Génération en cours…'
    + (document.getElementById('relaunchBackend').value === 'local' ? ' (10–30 min)' : '');

  try {
    var resp = await fetch(
      '/api/projects/' + relaunchTarget.projectId + '/renders/' + relaunchTarget.renderId + '/relaunch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ renderPrompt: prompt, backend: document.getElementById('relaunchBackend').value }),
      }
    );
    var data = await resp.json();
    if (data.error) throw new Error(data.error);

    // Add new card to the project grid
    var proj = allProjects.find(function(p){ return p.id === relaunchTarget.projectId; });
    if (proj) {
      if (!proj.renders) proj.renders = [];
      proj.renders.push(data.render);
      var grid = document.querySelector('.bd-grid[data-project-id="' + relaunchTarget.projectId + '"]');
      if (grid) {
        grid.appendChild(buildCard(relaunchTarget.projectId, data.render));
      }
      // Update count
      var section = document.querySelector('.project-section[data-project-id="' + relaunchTarget.projectId + '"]');
      if (section) {
        var countEl = section.querySelector('.render-count');
        if (countEl) countEl.textContent = proj.renders.length + ' rendu' + (proj.renders.length !== 1 ? 's' : '');
      }
    }

    status.textContent = 'Terminé ✓';
    setTimeout(closeRelaunch, 1500);
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
    btn.disabled = false;
  }
}

// ── Key handlers ────────────────────────────────────────────────────────────────────────

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeLightbox({target: document.getElementById('lightbox')});
    closeCmp({target: document.getElementById('compareOverlay')});
    closeRelaunch();
  }
});

init();
</script>
</body>
</html>`;
