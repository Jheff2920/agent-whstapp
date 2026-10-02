# Conectar el cerebro a WhatsApp (sin n8n)

En este modo el cerebro habla **directo con Meta**: Meta llama a `https://TU-URL/webhook` y el cerebro responde por la
Graph API. Las alertas a asesores salen por **Telegram**. No hace falta n8n.

```
Meta WhatsApp ──▶ https://<equipo>.<tailnet>.ts.net/webhook ──(Tailscale Funnel)──▶ cerebro :3000 ──▶ Ollama | Claude
                                                                                     │
cliente ◀── Graph API ◀────────────── outbox ◀──── SQLite ◀── panel :3001 (privado) ─┘     alertas ──▶ Telegram
```

## 1. Meta (WhatsApp Cloud API)

1. En <https://developers.facebook.com> crea una app de tipo *Business* y agrega el producto **WhatsApp**.
2. En *WhatsApp → Configuración de la API* copia el **Phone Number ID** (`WA_PHONE_NUMBER_ID`). Para empezar sirve el número
   de prueba de Meta; luego registras el número real de la tienda.
3. **Token permanente** (`WA_ACCESS_TOKEN`): en *Business Settings → Usuarios del sistema* crea un usuario del sistema,
   asígnale tu app y la cuenta de WhatsApp con los permisos `whatsapp_business_messaging` y
   `whatsapp_business_management`, y genera el token. (El token del panel de pruebas **caduca a las 24 h**.)
4. **App Secret** (`WA_APP_SECRET`): *Configuración de la app → Básica → Clave secreta*. El cerebro lo usa para comprobar la
   firma de cada mensaje; sin firma válida se rechaza.
5. Inventa un **verify token** (`WA_VERIFY_TOKEN`), por ejemplo una frase larga aleatoria.
6. Cuando tengas la URL pública (paso 3): *WhatsApp → Configuración → Webhook → Editar*, URL de devolución
   `https://<equipo>.<tailnet>.ts.net/webhook` y tu verify token; después **suscribe el campo `messages`**.

> **Costos de Meta:** las conversaciones tienen tarifas de Meta, independientes de este proyecto. Según el registro de
> cambios de WhatsApp Business Platform que consulté, desde el 1 de octubre de 2026 los mensajes de servicio entregados
> dentro de la ventana de 24 h pasan a ser facturables. Revisa la tabla de precios vigente de tu país en tu cuenta de Meta.

## 2. Telegram (alertas a asesores)

1. En Telegram abre **@BotFather**, escribe `/newbot` y sigue los pasos: te da el token (`TELEGRAM_BOT_TOKEN`).
2. Escríbele cualquier mensaje a tu bot (o agrégalo a un grupo de asesores y escribe ahí).
3. Abre `https://api.telegram.org/bot<TOKEN>/getUpdates` y busca `"chat":{"id":...}`: ese número (en grupos suele ser
   negativo) es `TELEGRAM_CHAT_ID`.

No publiques el token. Cuando una conversación se escala, un cliente espera mientras atiende una persona o se pide una
cotización, llega un mensaje con el motivo, el último mensaje del cliente y el enlace al panel (`PANEL_URL`).

## 3. URL pública fija con Tailscale Funnel

Meta exige una dirección **HTTPS pública y fija**. [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) la da gratis
con un nombre `*.ts.net`, sin dominio propio y sin abrir puertos del router.

```bash
# instala Tailscale (https://tailscale.com/download) e inicia sesión
sudo tailscale up
# en la consola de administración de Tailscale activa HTTPS y Funnel para el equipo (te lo pide la primera vez)
sudo tailscale funnel --bg 3000      # publica solo el puerto 3000 del cerebro
tailscale funnel status              # muestra la URL: https://<equipo>.<tailnet>.ts.net
```

Se expone **únicamente el puerto público** (`PORT=3000`): `/webhook`, `/health` (y `/api/inbound` solo si defines
`INTERNAL_TOKEN`). El **panel** corre en otro puerto (`PANEL_PORT=3001`, por defecto solo en `127.0.0.1`) y **no** queda
publicado. Funciona igual en tu PC y en la Raspberry Pi.

## 4. Configuración mínima (`.env`)

```bash
NODE_ENV=production
LLM_PROVIDER=ollama                 # o anthropic (en la Raspberry Pi usa anthropic)
WA_ACCESS_TOKEN=...
WA_PHONE_NUMBER_ID=...
WA_VERIFY_TOKEN=...
WA_APP_SECRET=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ADMIN_PASSWORD_HASH=...             # npm run hash-password
SESSION_SECRET=...                  # openssl rand -hex 32
PANEL_URL=http://localhost:3001     # la dirección con la que abres el panel (va en los avisos de Telegram)
```

En producción el servicio **no arranca** si falta algo imprescindible (App Secret, token o Phone Number ID, verify token,
contraseña del panel) o si quedan secciones `TODO` en `knowledge/`.

## 5. Probar

1. `npm run build && npm start` y abre el panel en <http://localhost:3001>.
2. Con Funnel activo, en Meta pulsa *Verificar y guardar* en el webhook (el cerebro responde al desafío).
3. Escribe desde tu WhatsApp al número de prueba: el mensaje aparece en el panel y el asistente responde.
4. Escribe "quiero hablar con una persona": la conversación pasa a *Escalado* y te llega el aviso por Telegram.

> Si usas el modo n8n en vez de este, mira [`../n8n/README.md`](../n8n/README.md).
