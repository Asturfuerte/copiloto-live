// Cerebro de Claude para Copiloto Live (modo híbrido).
// Gemini Live sigue siendo el oído y la voz; cuando hay que pensar, buscar en internet
// o consultar documentos, Gemini llama a la función "investigar" y la resolvemos aquí con Claude.
// Sin dependencias: llamada HTTPS directa a la API de mensajes de Anthropic.
const https = require('https');

// La clave se busca de forma tolerante: nombre exacto, nombres alternativos, espacios o comillas de más,
// o cualquier variable cuyo valor sea una clave de Anthropic (sk-ant-…). Nunca se escribe el valor en el log.
function limpiar(v) { return String(v || '').trim().replace(/^["']|["']$/g, '').trim(); }
function buscarClave() {
  const env = process.env;
  const nombres = Object.keys(env);
  const preferidos = ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_KEY', 'CLAUDE_KEY'];
  for (const p of preferidos) {
    const n = nombres.find(x => x.trim().toUpperCase() === p);
    if (n && limpiar(env[n])) return { clave: limpiar(env[n]), origen: JSON.stringify(n) };
  }
  const porNombre = nombres.find(x => /ANTHROPIC|CLAUDE/i.test(x) && /^sk-ant-/.test(limpiar(env[x])));
  if (porNombre) return { clave: limpiar(env[porNombre]), origen: JSON.stringify(porNombre) };
  const porValor = nombres.find(x => /^sk-ant-/.test(limpiar(env[x])));
  if (porValor) return { clave: limpiar(env[porValor]), origen: JSON.stringify(porValor) };
  return { clave: '', origen: '', parecidas: nombres.filter(x => /ANTHROPIC|CLAUDE|API_KEY/i.test(x)).map(x => JSON.stringify(x) + (env[x] ? '' : ' (vacía)')) };
}
const ENCONTRADA = buscarClave();
const KEY = ENCONTRADA.clave;
function diagnostico() {
  if (KEY) return 'clave leída de la variable ' + ENCONTRADA.origen + ' (empieza por ' + KEY.slice(0, 10) + '…, ' + KEY.length + ' caracteres)';
  return 'no hay ninguna variable con una clave de Anthropic. Variables parecidas que sí llegan: ' + (ENCONTRADA.parecidas.join(', ') || 'ninguna');
}
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS || 900);
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 40000);
const MAX_VUELTAS = 6; // tope de idas y vueltas con herramientas por pregunta

function enabled() { return !!KEY; }

function post(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request({
      host: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    }, res => {
      const bufs = []; res.on('data', d => bufs.push(d));
      res.on('end', () => {
        const txt = Buffer.concat(bufs).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error('Claude ' + res.statusCode + ': ' + txt.slice(0, 200)));
        try { resolve(JSON.parse(txt)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Claude tardó demasiado en responder')));
    req.write(data); req.end();
  });
}

// Herramientas: búsqueda web (la ejecuta Anthropic) + documentos del cliente (las ejecutamos nosotros).
function tools(docNames) {
  const t = [{
    type: 'web_search_20250305', name: 'web_search', max_uses: 3,
    user_location: { type: 'approximate', city: 'La Oliva', region: 'Canarias', country: 'ES', timezone: 'Atlantic/Canary' },
  }];
  if (docNames.length) {
    t.push({
      name: 'consultar_documentos',
      description: 'Busca en los documentos del usuario y devuelve los fragmentos más relevantes. Úsala para cualquier dato que pueda estar en ellos. Documentos disponibles: ' + docNames.join('; ') + '.',
      input_schema: { type: 'object', properties: {
        pregunta: { type: 'string', description: 'Qué buscar dentro del documento (concepto, dato, cláusula), sin repetir el nombre del documento.' },
        documento: { type: 'string', description: 'Opcional: nombre (o parte) del documento donde buscar.' },
      }, required: ['pregunta'] },
    }, {
      name: 'leer_documento',
      description: 'Devuelve el texto COMPLETO de un documento, por partes. Úsala para listar, contar, resumir o cuando la búsqueda no basta. Documentos disponibles: ' + docNames.join('; ') + '.',
      input_schema: { type: 'object', properties: {
        documento: { type: 'string', description: 'Nombre (o parte) del documento.' },
        parte: { type: 'integer', description: 'Número de parte, empieza en 1.' },
      }, required: ['documento'] },
    });
  }
  return t;
}

// Instrucciones fijas (se guardan en la caché de Anthropic: las preguntas siguientes no las vuelven a procesar,
// lo que hace la respuesta más rápida y barata). Lo que cambia (hora, conversación) va en el mensaje.
function systemBlocks(ctx) {
  const fijo = `Eres el investigador de "${ctx.nombre}", la secretaria personal de voz de Alfredo, en español de España. Otra parte del sistema escucha la conversación (a veces una reunión con varias personas) y habla; tú recibes las preguntas que necesitan datos y devuelves la respuesta que ella dirá en voz alta. Alfredo vive en Lajares (La Oliva, Fuerteventura, Canarias).

TU PRIORIDAD ES ACERTAR:
- Datos actuales o que pueden haber cambiado (resultados, noticias, horarios, precios, tiempo, normativa vigente, quién ocupa un cargo, datos de empresas o personas públicas): búscalos SIEMPRE en internet antes de responder, aunque creas saberlos. Contrasta con más de una fuente si el dato es importante o las fuentes no coinciden.
- Datos que puedan estar en los documentos del usuario (expedientes, contratos, sentencias, escrituras, informes, calendarios y plantillas guardados): consúltalos y básate solo en lo que digan. Si el dato está en "DOCUMENTOS AL DÍA", úsalo directamente.
- Si no encuentras el dato o las fuentes no son fiables, dilo claramente en una frase ("No lo he encontrado" / "No lo puedo confirmar"). Nunca inventes cifras, fechas, nombres, resultados ni cláusulas. Si algo es una deducción tuya, dilo.
- Sé eficiente: haz solo las búsquedas necesarias; con una o dos suele bastar.

CÓMO RESPONDER (tu texto se lee en voz alta):
- Texto hablado y natural: sin listas, viñetas, títulos, markdown, enlaces ni URLs, y sin corchetes de citas.
- Primero la respuesta directa; luego el detalle imprescindible. Normalmente de una a cuatro frases; más solo si la pregunta lo exige.
- Escribe números y marcadores como se dicen ("doce a once", "el sábado a las ocho y media de la tarde").
- Si la fuente importa (por ejemplo una norma o un dato discutido), nómbrala de palabra ("según el BOE…", "según la federación…").
- No menciones que eres otro sistema: responde como si hablara ella.
${ctx.conocimiento ? '\n=== CONOCIMIENTO PROPIO (información fiable sobre Alfredo y su entorno) ===\n' + ctx.conocimiento : ''}${ctx.siempre || ''}`;
  return [{ type: 'text', text: fijo, cache_control: { type: 'ephemeral' } }];
}

const MAX_DOC = 8000;    // tope de texto por consulta de documentos (antes se mandaba muchísimo más y era lento)
const MAX_LEER = 14000;  // tope por parte leída de un documento

// Pregunta a Claude con bucle de herramientas.
// ctx: { nombre, ahora, conocimiento, siempre, conversacion, docs(), buscar(p, d), leer(d, n), log }
async function investigar(pregunta, ctx) {
  const t0 = Date.now();
  const log = ctx.log || (() => {});
  const docNames = ctx.docs();
  const contenido = 'Ahora: ' + ctx.ahora + ' (hora de Canarias).\n\n'
    + (ctx.conversacion ? 'Lo último que se ha hablado (transcripción automática; los nombres propios pueden venir mal escritos):\n' + ctx.conversacion + '\n\n' : '')
    + 'Pregunta: ' + pregunta;
  const messages = [{ role: 'user', content: contenido }];
  const base = { model: MODEL, max_tokens: MAX_TOKENS, system: systemBlocks(ctx), tools: tools(docNames) };
  let tokens = { entrada: 0, cache: 0, salida: 0 };
  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const quedan = TIMEOUT_MS - (Date.now() - t0);
    if (quedan < 3000) break;
    const r = await post(Object.assign({}, base, { messages }), quedan);
    const content = r.content || [];
    if (r.usage) { tokens.entrada += r.usage.input_tokens || 0; tokens.cache += r.usage.cache_read_input_tokens || 0; tokens.salida += r.usage.output_tokens || 0; }
    for (const b of content) {
      if (b.type === 'server_tool_use' && b.name === 'web_search') log('  Claude busca en internet: ' + JSON.stringify((b.input || {}).query || ''));
      if (b.type === 'web_search_tool_result' && b.content && !Array.isArray(b.content)) log('  Búsqueda web con error: ' + JSON.stringify(b.content).slice(0, 160));
    }
    if (r.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content });
      const resultados = [];
      for (const b of content) {
        if (b.type !== 'tool_use') continue;
        let out;
        try {
          if (b.name === 'consultar_documentos') out = String(await ctx.buscar(String(b.input.pregunta || ''), b.input.documento ? String(b.input.documento) : '')).slice(0, MAX_DOC);
          else if (b.name === 'leer_documento') out = String(ctx.leer(String(b.input.documento || ''), Number(b.input.parte) || 1)).slice(0, MAX_LEER);
          else out = 'Herramienta no disponible.';
        } catch (e) { out = 'Error: ' + e.message; }
        log('  Claude -> ' + b.name + '(' + JSON.stringify(b.input).slice(0, 100) + ')');
        resultados.push({ type: 'tool_result', tool_use_id: b.id, content: out });
      }
      messages.push({ role: 'user', content: resultados });
      continue;
    }
    if (r.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content }); continue; } // búsqueda web larga: se reanuda
    const texto = content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    log('Claude respondió en ' + (Date.now() - t0) + ' ms (tokens: ' + tokens.entrada + ' nuevos + ' + tokens.cache + ' de caché + ' + tokens.salida + ' de salida)');
    return texto || 'No he encontrado una respuesta clara.';
  }
  log('Claude no terminó a tiempo (' + (Date.now() - t0) + ' ms)');
  return 'No he podido terminar de comprobarlo a tiempo. Dile al usuario que no lo has podido confirmar y ofrece volver a mirarlo.';
}

const TOOL = {
  functionDeclarations: [{
    name: 'investigar',
    description: 'Tu forma de pensar a fondo: busca en internet, consulta los documentos del usuario y razona la respuesta. Úsala SIEMPRE que la respuesta dependa de datos actuales (resultados deportivos, calendarios, noticias, horarios, precios, tiempo, quién ocupa un cargo), de los documentos del usuario (expedientes, contratos, sentencias, plantillas de lucha, calendarios guardados…), de normativa o de cualquier dato que no tengas seguro. Devuelve el texto listo para decirlo en voz alta.',
    parameters: { type: 'OBJECT', properties: {
      pregunta: { type: 'STRING', description: 'La pregunta completa y autosuficiente, con todo el contexto necesario (quién, qué, cuándo). Ej.: "¿Cómo quedó el último partido del CL Tisajoire de Lajares en la Liga Cabildos de lucha canaria?"' },
    }, required: ['pregunta'] },
  }],
};

// Con asincrono=true se declara NON_BLOCKING: el modelo de voz sigue hablando mientras se resuelve.
function tool(asincrono) {
  if (!asincrono) return TOOL;
  const f = Object.assign({}, TOOL.functionDeclarations[0], { behavior: 'NON_BLOCKING' });
  return { functionDeclarations: [f] };
}

const RULES = `

=== DATOS: SIEMPRE COMPROBADOS (regla principal) ===
Eres una secretaria fiable: NUNCA afirmes un dato de memoria. Para cualquier dato concreto (resultados, fechas, calendarios, cifras, precios, horarios, noticias, normativa, plazos, nombres de cargos, datos de empresas o personas, contenido de documentos o expedientes) llama a la función investigar ANTES de responder, aunque creas saberlo. Pásale la pregunta completa y autosuficiente, con quién, qué y cuándo, y con los nombres propios bien escritos según tu conocimiento (p. ej. el equipo de lucha de Alfredo es el "CL Unión Temporal Tisajoire" de Lajares).
Cuando vuelva, dila con tus palabras pero fiel: no añadas ni cambies cifras, fechas ni nombres, y si dice que no lo ha encontrado o no lo puede confirmar, dilo así, sin rellenar con suposiciones. No digas "según mi búsqueda" ni menciones a otro sistema.
En reuniones: antes de corregir a alguien con un dato, compruébalo con investigar; si no se puede confirmar, no corrijas.
Excepción: si el dato aparece tal cual en tus instrucciones (secciones CONOCIMIENTO PROPIO o DOCUMENTOS AL DÍA), puedes responder directamente con él, sin investigar.
Si alguien pregunta algo que ya investigaste en esta conversación, puedes reutilizar esa respuesta sin volver a llamar.
No hace falta investigar para charlar, saludar, opinar en general, ni para la agenda, los pedidos o la tienda (para eso tienes tus otras funciones).`;

const RULES_ASINCRONO = `
CÓMO CONSULTAR SIN SILENCIOS: investigar funciona en segundo plano. Justo al llamarla, di en voz alta una frase corta y natural para que no haya silencio, variándola cada vez ("Un segundo, que lo consulto", "Déjame mirarlo un momento", "Ahora te lo digo, lo estoy comprobando"). Mientras llega la respuesta puedes seguir la conversación con normalidad (escuchar, comentar algo breve), pero no adelantes el dato ni lo adivines. Cuando llegue el resultado, dilo en cuanto haya un hueco, enlazándolo con naturalidad ("Ya lo tengo: …").`;
const RULES_ESPERA = `
Justo antes de llamar a investigar, di en voz alta una frase corta y natural para que no haya silencio ("Un segundo, que lo consulto", "Déjame mirarlo"); la respuesta puede tardar unos segundos.`;

module.exports = { enabled, investigar, TOOL, tool, RULES, RULES_ASINCRONO, RULES_ESPERA, MODEL, diagnostico };
