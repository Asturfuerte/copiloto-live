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
    await run('pdftoppm', ['-r', '200', '-gray', '-png', file, path.join(tmp, 'p')]);
    const pngs = fs.readdirSync(tmp).filter(f => f.endsWith('.png')).sort();
    let text = '';
    for (let i = 0; i < pngs.length; i++) {
      const t = await run('tesseract', [path.join(tmp, pngs[i]), '-', '-l', OCR_LANG, '--psm', '6']);
      text += '\n\n===== Página ' + (i + 1) + ' =====\n' + t;
      fs.unlinkSync(path.join(tmp, pngs[i]));
      if (onProgress) onProgress(i + 1, pngs.length);
    }
    return text;
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
}
// Si el PDF no tiene texto y aún no tiene OCR, lo genera y guarda el sidecar. Devuelve true si hizo OCR.
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
    index.docs.push({ name, file: f, chunks: parts.length, chars: text.length });
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

function search(index, query, k = 5) {
  const N = index.chunks.length; if (!N) return [];
  const q = [...new Set(tokens(query))]; if (!q.length) return [];
  const k1 = 1.5, b = 0.75;
  const scored = index.chunks.map(c => {
    let s = 0;
    for (const w of q) {
      const f = c.tf.get(w); if (!f) continue;
      const df = index.df.get(w) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.len / index.avgLen));
    }
    return { c, s };
  }).filter(x => x.s > 0).sort((a, b2) => b2.s - a.s);
  return scored.slice(0, k).map(x => x.c);
}

function answer(index, query, k = 5) {
  const hits = search(index, query, k);
  if (!index.chunks.length) return 'No hay documentos cargados.';
  if (!hits.length) return 'No he encontrado nada sobre eso en los documentos (' + index.docs.map(d => d.name).join(', ') + ').';
  return hits.map(h => `[${h.doc}, fragmento ${h.n}]\n${h.text}`).join('\n\n---\n\n');
}

module.exports = { buildIndex, search, answer, tokens, chunk, ensureOcr, OCR_SIDECAR };
