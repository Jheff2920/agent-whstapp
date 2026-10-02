# agent-whstapp

Agente de ventas 24/7 por WhatsApp para **Red Soluciones**. Atiende a clientes, recuerda a cada uno entre conversaciones
y deriva a una persona cuando hace falta. Funciona con un **modelo local (Ollama)** o con **Claude** (API), según una variable.

> **Estado: Fase 1 (base).** Ya funcionan: webhook de entrada con firma y deduplicación, agente con herramientas,
> memoria por cliente, cola de salida con reintentos, ventana de 24 h y chat por terminal. Pendiente (ver [Hoja de ruta](#hoja-de-ruta)):
> workflows de n8n, panel web, citas en Google Calendar, aprendizaje global con aprobación, despliegue en Raspberry Pi y llamadas de voz.

## Cómo funciona

```
Meta WhatsApp ─▶ n8n (webhook) ─▶ POST /api/inbound ─▶ cola por cliente ─▶ Agente ─▶ Ollama | Claude
                                         │                                    │
                                      SQLite ◀──────────── herramientas ──────┘
                                         │
                      outbox ─▶ n8n (webhook de salida) ─▶ Graph API ─▶ cliente
```

- **Entrada asíncrona:** `/api/inbound` valida el token interno y la firma `X-Hub-Signature-256`, guarda el mensaje
  una sola vez (Meta reintenta entregas) y responde `202` de inmediato; la respuesta del agente se genera después.
  Así un modelo local lento no provoca reintentos de Meta.
- **Un cliente a la vez:** los mensajes de un mismo cliente se procesan en serie; ráfagas de mensajes cortos se agrupan.
- **Modos de conversación:** `bot`, `humano`, `escalado`. Fuera de `bot` el agente no responde (solo guarda).
  Si una persona toma el control mientras el modelo piensa, la respuesta del bot se descarta.
- **Si el modelo falla** (Ollama caído, red): se escala a humano y se avisa al cliente; nunca queda en silencio.
- **Salida confiable:** cada mensaje saliente pasa por una *outbox* en SQLite con reintentos y espera creciente.
  Fuera de la ventana de 24 h de WhatsApp no se envía texto libre (requiere plantilla aprobada por Meta).
- **Baja/alta:** el cliente escribe `STOP`/`BAJA` para no recibir más mensajes y `ALTA` para volver.

## Requisitos

- Node.js 22 o superior.
- Para el modelo local: [Ollama](https://ollama.com) con un modelo descargado.
- Para Claude: una `ANTHROPIC_API_KEY`.

## Puesta en marcha

```bash
npm install
cp .env.example .env      # ajusta los valores
npm run chat              # probar el agente en la terminal, sin WhatsApp
npm run dev               # servidor con recarga (puerto 3000)
npm test                  # pruebas
npm run typecheck
npm run build && npm start
```

### Modelo de lenguaje

| `LLM_PROVIDER` | Modelo por defecto | Notas |
|---|---|---|
| `ollama` | `qwen2.5:7b-instruct` | Gratis y local. En una PC sin GPU con 16 GB de RAM un modelo de 7-8B tarda varios segundos por respuesta y es menos fiable usando herramientas que Claude. Prueba también `qwen3:8b`, `llama3.1:8b` o `gemma3` (confirma nombres en <https://ollama.com/library>). Con modelos de razonamiento (p. ej. qwen3) puedes fijar `OLLAMA_THINK=false`. |
| `anthropic` | `claude-opus-5-5` | Mejor calidad. `ANTHROPIC_EFFORT` (`low`/`medium`/`high`) controla razonamiento y costo; `LLM_MODEL=claude-sonnet-5-5` abarata. `ANTHROPIC_FALLBACKS=true` reintenta en otro modelo si el principal rechaza por seguridad. |

`LEARNING_PROVIDER` permite usar un proveedor distinto para resúmenes/aprendizaje (por ejemplo chatear con el local y resumir con Claude).
Una Raspberry Pi no puede correr el modelo local con soltura: allí usa `anthropic`.

### Conocimiento del negocio (`knowledge/`)

El agente **solo afirma lo que esté en estos archivos**; no inventa productos, precios ni reseñas.
Los archivos del repo son plantillas vacías marcadas `TODO`:

| Archivo | Contenido |
|---|---|
| `empresa.md` | Qué ofrece Red Soluciones, políticas, ubicación y horario, tono de marca, preguntas frecuentes |
| `catalog.json` | Lista de productos/servicios (objetos libres: nombre, descripción, precio…) |
| `resenas.md` | Reseñas reales de clientes (se citan textualmente) |

Se recargan solos al editarlos. Mientras haya `TODO`, el agente deriva todo a una persona, y con `NODE_ENV=production`
el servicio **se niega a arrancar** hasta completarlos. Los tests usan datos ficticios en `tests/fixtures/`.

## Variables de entorno

Ver [`.env.example`](./.env.example). Obligatorias en producción: `INTERNAL_TOKEN` (secreto compartido con n8n,
cabecera `X-Internal-Token`) y `WA_APP_SECRET` (App Secret de Meta, valida la firma). `N8N_SEND_URL` es el webhook de n8n
que envía por WhatsApp; vacío = los mensajes solo se escriben en el log (modo desarrollo).

## Contrato con n8n

- **Entrada:** n8n reenvía el cuerpo **crudo** del webhook de Meta a `POST /api/inbound` con las cabeceras
  `X-Internal-Token` y `X-Hub-Signature-256` originales. Respuesta `202`. También procesa estados de entrega (`delivered`, `read`…).
- **Salida:** el servicio hace `POST` a `N8N_SEND_URL` con `{ outboxId, messageId, to, text }` y la cabecera `X-Internal-Token`;
  n8n envía por la Graph API y responde `{ "wa_message_id": "..." }`. Cualquier respuesta no `2xx` se reintenta.

## Estructura

```
src/
  config.ts            variables de entorno validadas
  index.ts             arranque y apagado ordenado
  server.ts            Fastify: /health y /api/inbound
  conversation.ts      ingesta, baja/alta, orquestación de la respuesta
  outbox.ts            cola de salida con reintentos y ventana de 24 h
  queue.ts             serialización por cliente
  agent/               loop del agente, prompt y herramientas
  llm/                 interfaz común + proveedores Ollama y Anthropic
  knowledge/           carga y búsqueda del conocimiento del negocio
  db/                  SQLite (better-sqlite3) y repositorio
  whatsapp/            firma HMAC y parser del webhook
  cli-chat.ts          chat por terminal para pruebas
knowledge/             datos del negocio (plantillas vacías)
tests/                 vitest (+ fixtures ficticios)
```

## Hoja de ruta

1. ✅ **Base:** modelo intercambiable, agente, memoria por cliente, entrada/salida, tests.
2. n8n (workflows `inbound`, `send`, alerta de escalamiento) y **panel web** tipo bandeja para ver conversaciones y tomar el control.
3. **Citas en tienda** con Google Calendar vía n8n (zona horaria `America/Lima`) y recordatorios.
4. **Aprendizaje:** resúmenes por cliente y aprendizajes globales que tú apruebas antes de que entren al prompt; seguimientos.
5. Despliegue en **Raspberry Pi** (systemd, Cloudflare Tunnel, copias de seguridad).
6. **Llamadas de voz** (ruta y proveedor por decidir).
