// Documentos: indexa los ficheros de una carpeta (md, txt, pdf, docx) y busca fragmentos relevantes (BM25).
// Sin dependencias. PDF via `pdftotext` (poppler-utils) y DOCX via `unzip`, si están instalados.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STOP = new Set(('a al algo ante bajo cabe con contra de del desde durante en entre hacia hasta mediante para por segun sin so sobre tras ' +
  'el la los las un una unos unas lo le les se su sus mi mis tu tus nuestro nuestra que quien quienes cual cuales como cuando donde y e o u ni pero sino ' +
  'es son era eran fue fueron ser sera seran sido siendo esta estan estaba estaban estar hay ha han habia habian haber he hemos ' +
  'este esta estos estas ese esa esos esas aquel aquella aquellos aquellas esto eso aquello yo tu el ella ellos ellas nosotros vosotros usted ustedes ' +
  'me te nos os si no mas muy ya tambien todo toda todos todas otro otra otros otras mismo misma cada ' +
  'dice dicho dicha articulo art num nº the of and').split(/\s+/));

function normalize(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
function stem(w) {
  // Recorte ligero de sufijos del español; suficiente para emparejar singular/plural y derivados.
  if (w.length <= 4) return w;
  return w.replace(/(aciones|ciones|amiento|imiento|mente|idades|idad|ables|ibles|able|ible|ación|acion|ción|cion|adas|idas|ados|idos|ando|iendo|ada|ida|ado|ido|es|as|os|a|e|o|s)$/, '');
}
function tokens(s) {
  return normalize(s).split(/[^a-z0-9ñ]+/).filter(w => w.length > 1 && !STOP.has(w)).map(stem).filter(Boolean);
}

// ---- OCR para PDF escaneados ----
// El texto OCR se guarda junto al PDF como "<fichero>.pdf.ocr.txt" (no se lista como documento aparte).
const OCR_SIDECAR = '.ocr.txt';
const OCR_LANG = process.env.OCR_LANG || 'spa';
function pdfPages(file) { try { const m = /Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file]).toString()); return m ? +m[1] : 0; } catch (e) { return 0; } }
function pdfTextLayer(file) { try { return execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8'); } catch (e) { return ''; } }
// Un PDF "sin texto" es el que tiene menos de ~40 caracteres útiles por página.
function needsOcr(file, text) { const pages = pdfPages(file) || 1; return text.replace(/\s+/g, '').length < 40 * pages; }
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const p = spawn(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
    const out = []; const err = [];
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(cmd + ' salió con ' + code + ': ' + Buffer.concat(err).toString('utf8').slice(0, 200))));
  });
}
// OCR asíncrono (no bloquea las sesiones de voz): rasteriza a 200 ppp y pasa tesseract página a página.
async function ocrPdf(file, onProgress) {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  try {
    await run('pdftoppm', ['-r', String(process.env.OCR_DPI || 150), '-gray', '-png', file, path.join(tmp, 'p')]);
    const pngs = fs.readdirSync(tmp).filter(f => f.endsWith('.png')).sort();
    let text = '';
    for (let i = 0; i < pngs.length; i++) {
      const t = await run('tesseract', [path.join(tmp, pngs[i]), '-', '-l', OCR_LANG, '--psm', '6'], { env: Object.assign({}, process.env, { OMP_THREAD_LIMIT: '1' }) });
      text += '\n\n===== Página ' + (i + 1) + ' =====\n' + t;
      fs.unlinkSync(path.join(tmp, pngs[i]));
      if (onProgress) onProgress(i + 1, pngs.length);
    }
    return text;
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
}
// Si el PDF no tiene texto y aún no tiene OCR, lo genera y guarda el sidecar. Devuelve true si hizo OCR.
function pdfNeedsOcr(file) { return !fs.existsSync(file + OCR_SIDECAR) && needsOcr(file, pdfTextLayer(file)); }
async function ensureOcr(file, onProgress) {
  if (!/\.pdf$/i.test(file)) return false;
  const side = file + OCR_SIDECAR;
  if (fs.existsSync(side)) return false;
  if (!needsOcr(file, pdfTextLayer(file))) return false;
  const t0 = Date.now();
  const text = await ocrPdf(file, onProgress);
  fs.writeFileSync(side, 'Texto obtenido por OCR del PDF escaneado "' + path.basename(file) + '"; puede contener errores de lectura.\n' + text);
  console.log('OCR de ' + path.basename(file) + ': ' + text.length + ' caracteres en ' + Math.round((Date.now() - t0) / 1000) + ' s');
  return true;
}

function readDoc(file) {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.md' || ext === '.txt') return fs.readFileSync(file, 'utf8');
    if (ext === '.pdf') {
      const side = file + OCR_SIDECAR;
      if (fs.existsSync(side)) return fs.readFileSync(side, 'utf8');
      const text = pdfTextLayer(file);
      return needsOcr(file, text) ? '' : text;
    }
    if (ext === '.docx') {
      const xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
      return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    }
  } catch (e) {
    console.log('No se pudo leer ' + path.basename(file) + ': ' + e.message.split('\n')[0]);
  }
  return '';
}

// Trocea en fragmentos de ~1200 caracteres respetando párrafos, con algo de solape.
function tail(s, n) { const t = s.slice(-n); const i = t.indexOf(' '); return i > 0 ? t.slice(i + 1) : t; }
function chunk(text, size = 1200, overlap = 200) {
  const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map(p => p.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const out = []; let cur = '';
  for (const p of paras) {
    if (p.length > size) { // párrafo enorme: cortar por frases
      if (cur) { out.push(cur); cur = ''; }
      let buf = '';
      for (const s of p.split(/(?<=[.;:!?])\s+/)) {
        if ((buf + ' ' + s).length > size && buf) { out.push(buf); buf = tail(buf, overlap) + ' ' + s; } else buf = buf ? buf + ' ' + s : s;
      }
      if (buf) out.push(buf);
      continue;
    }
    if ((cur + '\n' + p).length > size && cur) { out.push(cur); cur = tail(cur, overlap) + '\n' + p; } else cur = cur ? cur + '\n' + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

function buildIndex(dir) {
  const index = { docs: [], chunks: [], df: new Map(), avgLen: 0 };
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.(md|txt|pdf|docx)$/i.test(f) && !f.startsWith('.') && !f.endsWith(OCR_SIDECAR)).sort(); } catch (e) { return index; }
  for (const f of files) {
    const text = readDoc(path.join(dir, f));
    if (!text.trim()) continue;
    const name = f.replace(/\.(md|txt|pdf|docx)$/i, '');
    const parts = chunk(text);
    index.docs.push({ name, file: f, chunks: parts.length, chars: text.length, text: text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n') });
    parts.forEach((t, i) => {
      const toks = tokens(t); const tf = new Map();
      for (const w of toks) tf.set(w, (tf.get(w) || 0) + 1);
      for (const w of tf.keys()) index.df.set(w, (index.df.get(w) || 0) + 1);
      index.chunks.push({ doc: name, n: i + 1, text: t, tf, len: toks.length });
    });
  }
  index.avgLen = index.chunks.reduce((a, c) => a + c.len, 0) / (index.chunks.length || 1);
  if (index.docs.length) console.log('Documentos indexados: ' + index.docs.map(d => d.name + ' (' + d.chunks + ' fragmentos)').join(', '));
  return index;
}

// Palabras que forman parte de los nombres de los documentos: identifican el documento, no el contenido.
function docNameTokens(index) { if (!index._nameToks) index._nameToks = new Set(index.docs.flatMap(d => tokens(d.name))); return index._nameToks; }
function bm25Scores(index, query) {
  const N = index.chunks.length; const out = new Map(); if (!N) return out;
  const names = docNameTokens(index);
  let q = [...new Set(tokens(query))]; const q2 = q.filter(w => !names.has(w)); if (q2.length) q = q2; if (!q.length) return out;
  const k1 = 1.5, b = 0.75;
  index.chunks.forEach((c, i) => {
    let s = 0;
    for (const w of q) {
      const f = c.tf.get(w); if (!f) continue;
      const df = index.df.get(w) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.len / index.avgLen));
    }
    if (s > 0) out.set(i, s);
  });
  return out;
}

function search(index, query, k = 5) {
  const sc = bm25Scores(index, query);
  return [...sc.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, k).map(x => index.chunks[x[0]]);
}

// ---- Embeddings (búsqueda semántica) con la API de Gemini; misma clave que el modelo de voz ----
// Caché en <DOCS_DIR>/.embeddings.json por hash del texto, así un reinicio no vuelve a pagar ni esperar.
const EMBED_MODEL = process.env.EMBED_MODEL || 'gemini-embedding-001';
const EMBED_DIM = Number(process.env.EMBED_DIM || 768);
function sha(t) { return require('crypto').createHash('sha1').update(t).digest('hex'); }
function geminiPost(key, pathq, body) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request({ host: 'generativelanguage.googleapis.com', path: pathq + '?key=' + encodeURIComponent(key), method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
      const bufs = []; res.on('data', d => bufs.push(d));
      res.on('end', () => { const txt = Buffer.concat(bufs).toString('utf8'); if (res.statusCode !== 200) return reject(new Error('Gemini ' + res.statusCode + ': ' + txt.slice(0, 200))); try { resolve(JSON.parse(txt)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('timeout'))); req.write(data); req.end();
  });
}
async function embedTexts(key, texts, taskType) {
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    const r = await geminiPost(key, '/v1beta/models/' + EMBED_MODEL + ':batchEmbedContents', {
      requests: batch.map(t => ({ model: 'models/' + EMBED_MODEL, content: { parts: [{ text: t.slice(0, 6000) }] }, taskType, outputDimensionality: EMBED_DIM })),
    });
    for (const e of r.embeddings) out.push(Float32Array.from(e.values));
  }
  return out;
}
function norm(v) { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map(x => x / s); }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// Calcula (o lee de caché) el embedding de cada fragmento. Asíncrono; mientras no termina, la búsqueda es solo BM25.
async function ensureEmbeddings(index, dir, key, log) {
  if (!key || !index.chunks.length) return;
  const cachePath = path.join(dir, '.embeddings.json');
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); if (cache._model !== EMBED_MODEL || cache._dim !== EMBED_DIM) cache = {}; } catch (e) {}
  const pending = index.chunks.map((c, i) => ({ c, i, h: sha(c.text) })).filter(x => !cache[x.h]);
  if (pending.length) {
    const t0 = Date.now();
    const vecs = await embedTexts(key, pending.map(x => x.c.text), 'RETRIEVAL_DOCUMENT');
    pending.forEach((x, j) => { cache[x.h] = Array.from(vecs[j]); });
    cache._model = EMBED_MODEL; cache._dim = EMBED_DIM;
    const keep = new Set(index.chunks.map(c => sha(c.text)));
    for (const h of Object.keys(cache)) if (!h.startsWith('_') && !keep.has(h)) delete cache[h];
    fs.writeFileSync(cachePath, JSON.stringify(cache));
    if (log) log('Embeddings: ' + pending.length + ' fragmentos nuevos en ' + Math.round((Date.now() - t0) / 1000) + ' s');
  }
  for (const c of index.chunks) c.vec = norm(Float32Array.from(cache[sha(c.text)]));
  index.embedded = true;
}

// Búsqueda híbrida: BM25 (palabras exactas) + coseno (significado). Si no hay embeddings aún, solo BM25.
// Si se indica un documento (nombre o parte), se busca solo en él; si no casa con ninguno, en todos.
function pickDoc(index, documento) {
  if (!documento) return null;
  const want = tokens(documento); if (!want.length) return null;
  let best = null, bestScore = 0;
  for (const d of index.docs) { const dt = new Set(tokens(d.name)); const sc = want.filter(w => dt.has(w)).length / want.length; if (sc > bestScore) { bestScore = sc; best = d.name; } }
  return bestScore >= 0.5 ? best : null;
}
async function searchHybrid(index, query, key, k = 8, documento) {
  const only = pickDoc(index, documento);
  const allowed = i => !only || index.chunks[i].doc === only;
  const bm = bm25Scores(index, query);
  const bmTop = () => [...bm.entries()].filter(x => allowed(x[0])).sort((a, b2) => b2[1] - a[1]).slice(0, k).map(x => index.chunks[x[0]]);
  if (!index.embedded || !key) return bmTop();
  let qv = null;
  try { qv = norm((await embedTexts(key, [query], 'RETRIEVAL_QUERY'))[0]); } catch (e) { return bmTop(); }
  const bmMax = Math.max(1e-9, ...bm.values());
  const cos = index.chunks.map((c, i) => allowed(i) ? Math.max(0, dot(qv, c.vec)) : -1);
  const valid = cos.filter(x => x >= 0); const cMin = Math.min(...valid), cMax = Math.max(...valid);
  const scored = index.chunks.map((c, i) => { if (!allowed(i)) return null; const b = (bm.get(i) || 0) / bmMax; const e = cMax > cMin ? (cos[i] - cMin) / (cMax - cMin) : 0; return { c, s: 0.4 * b + 0.6 * e, b, e }; }).filter(Boolean);
  const top = scored.sort((a, b2) => b2.s - a.s).slice(0, k).filter(x => x.s > 0.15);
  index.lastDebug = top.map(x => ({ doc: x.c.doc, n: x.c.n, total: +x.s.toFixed(3), bm25: +x.b.toFixed(3), sem: +x.e.toFixed(3), inicio: x.c.text.slice(0, 90) }));
  return top.map(x => x.c);
}

// Texto completo de un documento, por partes de ~PAGE caracteres (para listar/resumir/contar todo el contenido).
const PAGE = Number(process.env.DOC_PAGE_CHARS || 14000);
function readDocument(index, documento, parte) {
  if (!index.docs.length) return 'No hay documentos cargados.';
  const name = pickDoc(index, documento) || (index.docs.length === 1 ? index.docs[0].name : null);
  if (!name) return 'No sé qué documento quieres. Documentos: ' + index.docs.map(d => d.name).join('; ') + '.';
  const d = index.docs.find(x => x.name === name);
  const total = Math.max(1, Math.ceil(d.text.length / PAGE));
  let p = Math.min(total, Math.max(1, Number(parte) || 1));
  let start = (p - 1) * PAGE; if (start > 0) { const nl = d.text.lastIndexOf('\n', start); if (nl > start - 400) start = nl + 1; }
  let end = Math.min(d.text.length, p * PAGE); if (end < d.text.length) { const nl = d.text.indexOf('\n', end); if (nl > 0 && nl < end + 400) end = nl; }
  return `[${d.name}, parte ${p} de ${total}]` + (total > 1 && p < total ? ` (pide la parte ${p + 1} para seguir)` : '') + '\n' + d.text.slice(start, end);
}

function format(index, hits) {
  if (!index.chunks.length) return 'No hay documentos cargados.';
  if (!hits.length) return 'No he encontrado nada sobre eso en los documentos (' + index.docs.map(d => d.name).join(', ') + ').';
  return hits.map(h => `[${h.doc}, fragmento ${h.n}]\n${h.text}`).join('\n\n---\n\n');
}
function answer(index, query, k = 8) { return format(index, search(index, query, k)); }
async function answerAsync(index, query, key, k = 8, documento) { return format(index, await searchHybrid(index, query, key, k, documento)); }

module.exports = { buildIndex, search, answer, answerAsync, readDocument, ensureEmbeddings, tokens, chunk, ensureOcr, pdfNeedsOcr, OCR_SIDECAR };
