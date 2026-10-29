# Graph Report - copiloto-live  (2026-10-29)

## Corpus Check
- Corpus is ~25,833 words - fits in a single context window. You may not need a graph.

## Summary
- 291 nodes · 493 edges · 13 communities (11 shown, 2 thin omitted)
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 48 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Servidor WebSocket y TLS
- Contexto Asturfuerte
- Buscador de documentos
- Passkeys
- Tiadhe Fuerteventura
- Recordatorios
- Tienda Shopify
- Sentencias y sociedades
- Pedidos y avisos push
- Sincronización Matilde
- Paquete npm
- Clase de pedidos

## God Nodes (most connected - your core abstractions)
1. `Guaguas de Fuerteventura (TIADHE): líneas, horarios y precios` - 22 edges
2. `startSession()` - 16 edges
3. `Passkeys` - 15 edges
4. `server` - 15 edges
5. `Recordatorios` - 12 edges
6. `Resumen STS 485/2026 de 22 de abril de 2026 (rec. 8640/2023)` - 12 edges
7. `Pedidos` - 11 edges
8. `Tienda online Asturfuerte (asturfuerte.es)` - 10 edges
9. `Matilde Sync (Windows)` - 9 edges
10. `api()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `Modo soplador` --semantically_similar_to--> `Modo soplador (solo texto)`  [INFERRED] [semantically similar]
  conocimiento/contexto.md → index.html
- `STS 485/2026 (Unión Ereza)` --semantically_similar_to--> `Resumen STS 485/2026 de 22 de abril de 2026 (rec. 8640/2023)`  [INFERRED] [semantically similar]
  conocimiento/contexto.md → documentos/STS-485-2026-Union-Ereza-incentivos-hotel-Antigua.md
- `Avisos de agenda como notificaciones de Windows` --semantically_similar_to--> `initPush()`  [INFERRED] [semantically similar]
  sync/LEEME.md → index.html
- `Matilde Sync (Windows)` --conceptually_related_to--> `Matilde (asistente personal de Alfredo)`  [INFERRED]
  sync/LEEME.md → conocimiento/contexto.md
- `loadDocs()` --conceptually_related_to--> `Resumen STS 485/2026 de 22 de abril de 2026 (rec. 8640/2023)`  [INFERRED]
  index.html → documentos/STS-485-2026-Union-Ereza-incentivos-hotel-Antigua.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Flujo de desbloqueo y carga de Copiloto Live** — index_biounlock, index_onunlocked, index_loaddocs, index_loadagenda, index_loadpedidos, index_initpush [EXTRACTED 1.00]
- **Pipeline de audio en tiempo real** — index_ensureaudio, index_downsampleto16k, index_topcm16, index_websocket_ws, index_playchunk [EXTRACTED 1.00]
- **Caso STS 485/2026 Unión Ereza** — documentos_sts_485_2026_union_ereza_incentivos_hotel_antigua_union_ereza_sl, conocimiento_contexto_flavio_artemio_dominguez_hormiga, conocimiento_contexto_nelida_cristina_santana_perez, documentos_sts_485_2026_union_ereza_incentivos_hotel_antigua_administracion_general_del_estado, documentos_sts_485_2026_union_ereza_incentivos_hotel_antigua_doctrina_viabilidad_proyecto, documentos_sts_485_2026_union_ereza_incentivos_hotel_antigua_fallo [EXTRACTED 1.00]

## Communities (13 total, 2 thin omitted)

### Community 0 - "Servidor WebSocket y TLS"
Cohesion: 0.06
Nodes (45): RFC-6455, agenda, AGENDA_TOOL, agendaRules(), authorized(), BUNDLED_DOCS, connectGemini(), crypto (+37 more)

### Community 1 - "Contexto Asturfuerte"
Cohesion: 0.07
Nodes (33): Alfredo Herreruela Quintana, Asturfuerte (marca de consultoría digital), Clientes web y cartas QR (La Boquería, Almirante Brunch, La Cancela, Piratas, C.D. Euro), Consultoría Hermiga S.L., Contexto del asistente (Quién eres), Copiloto Live (producto), Hora de Canarias (UTC+0/UTC+1), Matilde (asistente personal de Alfredo) (+25 more)

### Community 2 - "Buscador de documentos"
Cohesion: 0.10
Nodes (35): answer(), answerAsync(), bm25Scores(), buildIndex(), chunk(), docNameTokens(), dot(), EMBED_DIM (+27 more)

### Community 3 - "Passkeys"
Cohesion: 0.15
Nodes (12): b64u(), cborDecode(), item(), readLen(), coseToJwk(), crypto, fromB64u(), fs (+4 more)

### Community 4 - "Tiadhe Fuerteventura"
Cohesion: 0.11
Nodes (24): Fuerteventura / La Oliva (lugar), NEX Continental Holdings / TIADHE (empleador), Avisos en vigor (parada Gorriones, carretera del Almácigo), Bono Residente Canario, Guaguas de Fuerteventura (TIADHE): líneas, horarios y precios, Línea 01 Puerto del Rosario – Morro Jable, Línea 02 Puerto del Rosario – Vega de Río Palmas, Línea 03 Puerto del Rosario – Caleta de Fuste – Las Salinas (aeropuerto) (+16 more)

### Community 5 - "Recordatorios"
Cohesion: 0.16
Nodes (12): ahora(), crypto, DIAS, diasEntre(), fechaBonita(), fs, MESES, path (+4 more)

### Community 6 - "Tienda Shopify"
Cohesion: 0.21
Nodes (19): api(), cache, catalogo(), ENVIO, esCOD(), estadoEnvio(), estadoPago(), eur() (+11 more)

### Community 7 - "Sentencias y sociedades"
Cohesion: 0.18
Nodes (14): Flavio Artemio Domínguez Hormiga (abogado), Nélida Cristina Santana Pérez (procuradora), Sociedades donde Flavio es apoderado (UGH, Grupo Montalvo BPO, Livingcenter...), STS 485/2026 (Unión Ereza), STSJ Canarias 103/2025 (expropiación El Cotillo), Administración General del Estado (Abogacía del Estado), Sentencia de instancia de la Audiencia Nacional, Contrato de arrendamiento del hotel (vence 30/04/2020) (+6 more)

### Community 8 - "Pedidos y avisos push"
Cohesion: 0.16
Nodes (5): crypto, fs, fs, path, Push

### Community 9 - "Sincronización Matilde"
Cohesion: 0.23
Nodes (9): ARRANCAR MATILDE SYNC.bat, matilde-sync.estado.json, Matilde Sync (Windows), matilde-sync.json (url, pin, borrarRemoto), OCR en servidor (~8 s por página), ComprobarAvisos(), Enc(), Log() (+1 more)

### Community 10 - "Paquete npm"
Cohesion: 0.18
Nodes (11): dependencies, web-push@^3.6.7, engines, node, main, name, private, scripts (+3 more)

## Knowledge Gaps
- **25 isolated node(s):** `RFC-6455`, `STSJ Canarias 103/2025 (expropiación El Cotillo)`, `Sociedades donde Flavio es apoderado (UGH, Grupo Montalvo BPO, Livingcenter...)`, `Hora de Canarias (UTC+0/UTC+1)`, `Clientes web y cartas QR (La Boquería, Almirante Brunch, La Cancela, Piratas, C.D. Euro)` (+20 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 97 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Passkeys` connect `Passkeys` to `Servidor WebSocket y TLS`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `startSession()` (e.g. with `.add()` and `.describe()`) actually correct?**
  _`startSession()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **What connects `RFC-6455`, `STSJ Canarias 103/2025 (expropiación El Cotillo)`, `Sociedades donde Flavio es apoderado (UGH, Grupo Montalvo BPO, Livingcenter...)` to the rest of the system?**
  _25 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Servidor WebSocket y TLS` be split into smaller, more focused modules?**
  _Cohesion score 0.05725490196078432 - nodes in this community are weakly interconnected._
- **Why does `Pedidos` connect `Clase de pedidos` to `Pedidos y avisos push`, `Servidor WebSocket y TLS`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Are the 6 inferred relationships involving `server` (e.g. with `.add()` and `.avisosDeHoy()`) actually correct?**
  _`server` has 6 INFERRED edges - model-reasoned connections that need verification._
- **Should `Contexto Asturfuerte` be split into smaller, more focused modules?**
  _Cohesion score 0.06951219512195123 - nodes in this community are weakly interconnected._