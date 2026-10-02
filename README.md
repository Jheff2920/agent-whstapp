# agent-whstapp

Agente de ventas 24/7 por WhatsApp para **Red Soluciones**. Atiende a clientes, recuerda a cada uno entre conversaciones
y deriva a una persona cuando hace falta. Funciona con un **modelo local (Ollama)** o con **Claude** (API), según una variable.

> **Estado:** funcionan la conexión **directa con la Cloud API de Meta** (webhook con firma y deduplicación, envío con
> reintentos, ventana de 24 h; **sin n8n**), el agente con herramientas, la memoria por cliente, las **alertas a asesores
> por Telegram** y el **panel web** para ver conversaciones e intervenir. n8n queda como modo opcional. Pendiente (ver [Hoja de ruta](#hoja-de-ruta)): citas en Google Calendar,
> aprendizaje global con aprobación, despliegue en Raspberry Pi y llamadas de voz.

## Cómo funciona

```
Meta WhatsApp ─▶ POST /webhook (firma X-Hub-Signature-256) ─▶ cola por cliente ─▶ Agente ─▶ Ollama | Claude
                                         │                                           │
                                      SQLite ◀──────────────── herramientas ─────────┘
                                         │
                        outbox ─▶ Graph API ─▶ cliente          alertas ─▶ Telegram

(modo opcional con n8n: Meta ─▶ n8n ─▶ POST /api/inbound, y outbox ─▶ n8n ─▶ Graph API)
```

- **Entrada asíncrona:** `POST /webhook` (Meta) valida la firma `X-Hub-Signature-256`, guarda el mensaje
  una sola vez (Meta reintenta entregas) y responde `202` de inmediato; `GET /webhook` responde a la verificación de Meta; la respuesta del agente se genera después.
  Así un modelo local lento no provoca reintentos de Meta.
- **Un cliente a la vez:** los mensajes de un mismo cliente se procesan en serie; ráfagas de mensajes cortos se agrupan.
- **Modos de conversación:** `bot`, `humano`, `escalado`. Fuera de `bot` el agente no responde (solo guarda).
  Si una persona toma el control mientras el modelo piensa, la respuesta del bot se descarta.
- **Si el modelo falla** (Ollama caído, red): se escala a humano y se avisa al cliente; nunca queda en silencio.
- **Salida confiable:** cada mensaje saliente pasa por una *outbox* en SQLite con reintentos y espera creciente
  (los rechazos definitivos de WhatsApp, como un token inválido, no se reintentan).
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
| Archivo | Contenido | Estado |
|---|---|---|
| `catalog.json` | 82 productos del **Catálogo Red Soluciones 2026** (16 categorías): marca, modelo, características, precio en soles, garantía y página del PDF | ✅ cargado |
| `sedes.yml` | Las dos sedes (Cyberplaza y San Isidro): dirección y horario por día, hora de Lima; reglas de citas y feriados | ✅ cargado (**confirma la lista de feriados**) |
| `empresa.md` | Qué ofrece, precios con IGV, garantía y devoluciones, formas de pago (Interbank, BCP, Plin, Yape), envíos nacionales, boleta/factura, contacto | ✅ completo: pagos, envíos nacionales y comprobantes cargados |
| `resenas.md` | Reseñas reales de clientes, citadas textualmente | opcional: **no existe**; sin él el agente no menciona opiniones de clientes |

Se recargan solos al editarlos. Las secciones con `TODO` no se muestran al modelo: se reemplazan por un aviso para que
derive a una persona en lugar de inventar. Con `NODE_ENV=production` el servicio **se niega a arrancar** mientras
quede algún `TODO` en un archivo obligatorio. Los tests usan datos ficticios en `tests/fixtures/`.

El prompt incluye además el **estado de las sedes ahora** (abierta/cerrada y cuándo abre), calculado con la hora de Lima
en código y no por el modelo. El tono (cercano y profesional, de "tú", sin emojis) está en las reglas de `src/agent/prompt.ts`.
Si `sedes.yml` no tiene la sección `citas`, el agente no agenda: da dirección y horario y deriva a una persona.

El catálogo completo no cabe en el prompt, así que el modelo recibe un **índice** (modelo, marca y precio, ≈2 000 tokens
en total) y consulta las especificaciones con la herramienta `search_catalog` (por modelo o palabras clave).
Cada producto se transcribió tal como figura en el PDF; los modelos repetidos con distinta configuración
(SWIFT 2, FALCON 1, SWAN 2, ZD230) se distinguen por `variante`.

## Citas en tienda

El cliente puede reservar una visita por WhatsApp. Reglas (en `knowledge/sedes.yml`, sección `citas`):

| Regla | Valor |
|---|---|
| Duración de cada cita | 1 hora |
| Anticipación mínima | 1 hora |
| Citas simultáneas | 2 por franja **en cada sede** (hay personal en ambas) |
| Feriados | no se atiende ni se agenda (lista `feriados`) |
| Horario | el de cada sede (Cyberplaza lun–sáb 10–19, San Isidro lun–vie 9–18 y sáb 9–13); domingos cerrado |
| Límites de protección propuestos | hasta 30 días hacia adelante y 2 citas próximas por cliente (ajustables) |

**Cómo se evita que el modelo se equivoque:** el agente solo ofrece horarios que devuelve la herramienta
`check_availability`, y la reserva (`book_appointment`) la valida el código: horario de la sede, feriados, anticipación,
horizonte y cupos, dentro de una transacción de SQLite (no hay doble reserva aunque lleguen dos mensajes a la vez). Los
textos de confirmación salen de código (día, hora y dirección exactos); el modelo solo los repite. No se reserva sin que el
cliente haya respondido que sí (`cliente_confirmo`). El bot solo puede ver y tocar las citas del propio cliente.
Herramientas: `check_availability`, `book_appointment`, `my_appointments`, `cancel_appointment`, `reschedule_appointment`.

- **Base de datos = fuente de verdad; Google Calendar = espejo.** Si Google falla, la cita sigue confirmada, se
  reintenta (hasta 8 veces) y después se avisa por Telegram y el panel muestra «Google ✗» con un botón «Reintentar».
  Cada sede tiene su calendario (`calendar_id`); sin él la cita solo vive en el sistema. Configuración: [`deploy/README.md` §6](./deploy/README.md).
- **Avisos a asesores** (Telegram) cuando el asistente agenda, cancela o cambia una cita.
- **Recordatorio** 3 horas antes (nunca antes de las 8:00 de Lima): texto libre si el cliente escribió en las últimas 24 h; si no,
  una **plantilla aprobada por Meta** (`WA_REMINDER_TEMPLATE`). Sin plantilla el aviso no sale y queda una nota en la conversación.
  Ver [`deploy/README.md` §7](./deploy/README.md).
- **Feriados:** la lista de `sedes.yml` cubre hasta fines de 2027 y viene del calendario oficial peruano; **revísala**
  y agrega los días no laborables que decrete el gobierno. Al arrancar se avisa si la lista no cubre el período reservable.

## Panel web (bandeja de conversaciones)

Un panel tipo WhatsApp Web para ver las conversaciones en vivo y **tomar el control** cuando haga falta.

- **Bandeja:** filtros (todas, escaladas, con asesor, asistente, sin leer), búsqueda por nombre, número o texto, y aviso
  cuando la ventana de 24 h de WhatsApp venció.
- **Hilo:** mensajes del cliente, del asistente y de asesores (con estado: en cola, enviado, entregado, leído, no se envió),
  notas internas, **Tomar control** / **Devolver al asistente**. Al escribir con el asistente activo, la persona toma el
  control automáticamente para que no hablen los dos. No deja enviar fuera de la ventana de 24 h ni a clientes dados de baja.
- **Ficha del cliente:** nombre, etapa comercial, resumen, datos recordados (editables) y citas próximas.
- **Agenda:** semana por semana, filtro por sede, crear/reprogramar/cancelar citas a mano, marcar «completada» o «no asistió» y ver si cada cita llegó a Google Calendar.
- **Tiempo real:** los mensajes aparecen sin recargar (SSE). Funciona en escritorio y en el celular, con modo claro y oscuro.

```bash
cp .env.example .env     # define ADMIN_PASSWORD y SESSION_SECRET (openssl rand -hex 32)
npm run build            # compila el servidor y el panel (web/dist)
npm start                # panel en http://localhost:3001
npm run web:dev          # desarrollo del panel con recarga (http://localhost:5173)
npm run hash-password    # genera ADMIN_PASSWORD_HASH para no guardar la contraseña en claro
```

**Seguridad:** el panel va en su **propio puerto** (`PANEL_PORT`, por defecto 3001 y solo en `127.0.0.1`). El puerto
público (`PORT`, 3000), el que se expone con el túnel, solo atiende `/api/inbound` y `/health`. Para verlo desde otros
equipos de tu red usa `PANEL_HOST=0.0.0.0` (idealmente con Tailscale o Cloudflare Access si quieres acceso desde fuera);
no lo publiques tal cual en internet. Contraseña con bloqueo tras 5 intentos fallidos, sesión firmada de 12 h en cookie
`HttpOnly` + `SameSite=Strict` y comprobación de `Origin` en las operaciones que modifican datos. Usa `COOKIE_SECURE=true`
si lo sirves por HTTPS.

## Alertas a asesores

Cuando una conversación se **escala** (el asistente no puede resolver, un reclamo, error del modelo), cuando un cliente
**escribe mientras atiende una persona** (máximo una alerta cada 10 min por conversación) o cuando se registra una
**solicitud de cotización**, el cerebro envía un mensaje por **Telegram** (`TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`) con el
motivo, el último mensaje del cliente y el enlace directo a la conversación en el panel (`PANEL_URL`). El texto va sin
formato para que lo que escriba un cliente no pueda alterarlo. Si falla el envío, el asistente sigue funcionando: solo se
registra en el log. (Con n8n también se puede enviar por correo: `ALERT_URL`.)

## Variables de entorno

Ver [`.env.example`](./.env.example) y la guía de conexión [`deploy/README.md`](./deploy/README.md). Obligatorias en
producción: `WA_APP_SECRET` (App Secret de Meta, valida la firma) y, para enviar, `WA_ACCESS_TOKEN` + `WA_PHONE_NUMBER_ID`
+ `WA_VERIFY_TOKEN` (modo directo) o `N8N_SEND_URL` + `INTERNAL_TOKEN` (modo n8n). Sin ninguno de los dos los mensajes solo
se escriben en el log (desarrollo).

## Modo n8n (opcional)

Los workflows ya están creados en el n8n Cloud del proyecto y versionados en [`n8n/`](./n8n/README.md) (pasos de configuración incluidos).

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
  appointments/        citas: reglas y cupos, franjas, espejo en Google Calendar y recordatorios
  llm/                 interfaz común + proveedores Ollama y Anthropic
  knowledge/           carga y búsqueda del conocimiento del negocio
  db/                  SQLite (better-sqlite3) y repositorio
  whatsapp/            firma HMAC, parser del webhook y envío directo por la Cloud API
  events.ts            bus de eventos en vivo (panel)
  notify.ts            alertas a asesores (Telegram o n8n)
  panel/               API, autenticación y servidor del panel
  cli-chat.ts          chat por terminal para pruebas
  cli-hash-password.ts genera ADMIN_PASSWORD_HASH
web/                   panel web (Vite + React)
knowledge/             datos del negocio (catálogo, sedes, empresa)
deploy/                guía de conexión con Meta, Telegram y Tailscale Funnel
n8n/                   modo opcional: workflows de WhatsApp y alertas
tests/                 vitest (+ fixtures ficticios)
```

## Hoja de ruta

1. ✅ **Base:** modelo intercambiable, agente, memoria por cliente, entrada/salida, tests.
2. ✅ **Conexión directa con Meta (sin n8n)**, alertas por Telegram y **panel web** de conversaciones con toma de control. n8n queda opcional.
3. ✅ **Citas en tienda** (cupos por sede, feriados, agenda en el panel, espejo en Google Calendar y recordatorios).
4. **Aprendizaje:** resúmenes por cliente y aprendizajes globales que tú apruebas antes de que entren al prompt; seguimientos.
5. Despliegue en **Raspberry Pi** (systemd, Cloudflare Tunnel, copias de seguridad).
6. **Llamadas de voz** (ruta y proveedor por decidir).
