// Cerebro de Claude para Copiloto Live (modo híbrido).
// Gemini Live sigue siendo el oído y la voz; cuando hay que pensar, buscar en internet
// o consultar documentos, Gemini llama a la función "investigar" y la resolvemos aquí con Claude.
// Sin dependencias: llamada HTTPS directa a la API de mensajes de Anthropic.
const https = require('https');

const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS || 1200);
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 45000);
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
    type: 'web_search_20250305', name: 'web_search', max_uses: 4,
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

function systemPrompt(ctx) {
  return `Eres el cerebro de "${ctx.nombre}", una asistente de voz en español de España. Otra parte del sistema escucha la conversación y habla; tú recibes las preguntas que necesitan pensar, buscar en internet o consultar documentos, y devuelves la respuesta que ella dirá en voz alta.

Ahora mismo es ${ctx.ahora} (hora de Canarias). El usuario principal es Alfredo; vive en Lajares (La Oliva, Fuerteventura).

CÓMO RESPONDER (tu texto se va a leer en voz alta):
- Texto hablado y natural: sin listas, sin viñetas, sin títulos, sin markdown, sin enlaces ni URLs, sin citar fuentes con corchetes.
- Ve al grano: primero la respuesta, luego el detalle imprescindible. Normalmente entre una y cinco frases; más solo si la pregunta lo exige.
- Escribe los números y marcadores como se dicen ("doce a diez", "el sábado treinta y uno a las ocho y media de la tarde").
- Datos actuales (resultados, horarios, precios, noticias, quién ocupa un cargo): búscalos en internet antes de responder.
- Datos que puedan estar en los documentos del usuario: consúltalos antes de responder y básate solo en lo que devuelvan.
- Si no encuentras algo, dilo claramente en una frase. Nunca inventes cifras, fechas, resultados ni cláusulas.
- No menciones que eres otro sistema ni que te han consultado: responde como si hablara ella directamente.
${ctx.conocimiento ? '\n=== CONOCIMIENTO PROPIO (información fiable para estas sesiones) ===\n' + ctx.conocimiento : ''}`;
}

// Pregunta a Claude con bucle de herramientas. ctx: { nombre, ahora, conocimiento, conversacion, docs(), buscar(p, d), leer(d, n), log }
async function investigar(pregunta, ctx) {
  const t0 = Date.now();
  const docNames = ctx.docs();
  const contenido = (ctx.conversacion ? 'Lo último que se ha hablado (transcripción automática, puede tener errores):\n' + ctx.conversacion + '\n\n' : '') + 'Pregunta o tarea: ' + pregunta;
  const messages = [{ role: 'user', content: contenido }];
  const base = { model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt(ctx), tools: tools(docNames) };
  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const quedan = TIMEOUT_MS - (Date.now() - t0);
    if (quedan < 3000) break;
    const r = await post(Object.assign({}, base, { messages }), quedan);
    const content = r.content || [];
    if (r.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content });
      const resultados = [];
      for (const b of content) {
        if (b.type !== 'tool_use') continue;
        let out;
        try {
          if (b.name === 'consultar_documentos') out = await ctx.buscar(String(b.input.pregunta || ''), b.input.documento ? String(b.input.documento) : '');
          else if (b.name === 'leer_documento') out = ctx.leer(String(b.input.documento || ''), Number(b.input.parte) || 1);
          else out = 'Herramienta no disponible.';
        } catch (e) { out = 'Error: ' + e.message; }
        if (ctx.log) ctx.log('  Claude -> ' + b.name + '(' + JSON.stringify(b.input).slice(0, 80) + ')');
        resultados.push({ type: 'tool_result', tool_use_id: b.id, content: String(out).slice(0, 60000) });
      }
      messages.push({ role: 'user', content: resultados });
      continue;
    }
    if (r.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content }); continue; } // búsqueda web larga: se reanuda
    const texto = content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (ctx.log) ctx.log('Claude respondió en ' + (Date.now() - t0) + ' ms (' + (r.usage ? r.usage.input_tokens + '+' + r.usage.output_tokens + ' tokens' : '') + ')');
    return texto || 'No he encontrado una respuesta clara.';
  }
  return 'No he podido terminar de mirarlo a tiempo; dímelo otra vez en un momento.';
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

const RULES = `

=== PENSAR Y BUSCAR ===
Tienes la función investigar: es tu manera de buscar en internet, consultar los documentos del usuario y pensar las respuestas difíciles. Úsala SIEMPRE antes de responder cuando haga falta un dato actual (resultados, calendarios, noticias, horarios, precios), algo de los documentos del usuario, normativa o cualquier dato del que no estés segura. No respondas de memoria esas cosas.
Antes de llamarla, di solo una frase muy corta y natural ("Un momento, lo miro"). Cuando vuelva la respuesta, dila con tus palabras pero fiel a lo que devuelve: no añadas datos, no cambies cifras ni fechas, no digas "según mi búsqueda" ni menciones que has consultado a otro sistema.
Para charlar, saludar, la agenda, los pedidos o la tienda NO hace falta: usa tus otras funciones o responde directamente.`;

module.exports = { enabled, investigar, TOOL, RULES, MODEL };
