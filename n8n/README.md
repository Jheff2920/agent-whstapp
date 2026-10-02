# Workflows de n8n

n8n es la puerta de WhatsApp: recibe los webhooks de Meta y envía los mensajes salientes. El cerebro (este repo)
hace el agente, la memoria y la cola de salida. Hay dos workflows:

| Archivo | Para qué | URL de producción (n8n Cloud `jheff2920`) |
|---|---|---|
| `workflows/whatsapp-entrada.json` | Meta → n8n → `POST /api/inbound` del cerebro (reenvía el cuerpo **crudo** y la firma `X-Hub-Signature-256`; si el cerebro falla responde 500 para que Meta reintente) | `https://jheff2920.app.n8n.cloud/webhook/red-whatsapp` (GET para verificar y POST para mensajes) |
| `workflows/whatsapp-salida.json` | cerebro → n8n → WhatsApp Business Cloud; devuelve `{ "wa_message_id": "..." }` o 502 | `https://jheff2920.app.n8n.cloud/webhook/red-whatsapp-enviar` |

| `workflows/whatsapp-alerta.json` | cerebro → n8n → correo (Gmail) a un asesor cuando una conversación se escala, un cliente espera respuesta mientras atiende una persona, o se pide una cotización; incluye el enlace al panel | `https://jheff2920.app.n8n.cloud/webhook/red-whatsapp-alerta` |

Ya están creados (sin publicar) en tu n8n Cloud; estos JSON son la copia versionada (se pueden importar con
*Import from file*, pero los marcadores `TU-URL-PUBLICA-DEL-CEREBRO` y `TU_PHONE_NUMBER_ID` hay que reemplazarlos; en la alerta también `ventas@TU-EMPRESA.com`).

## Qué tienes que hacer tú (las credenciales no las puedo crear yo)

1. **Token interno:** elige un secreto largo y ponlo como `INTERNAL_TOKEN` en el `.env` del cerebro.
2. **Credencial de entrada** (nodo *Reenviar al cerebro*): tipo *Custom Auth* con plantilla
   `{"headers":{"X-Internal-Token":"{{api_key}}"}}` y `api_key` = tu `INTERNAL_TOKEN`.
3. **Credencial de salida** (webhook *El cerebro pide enviar un mensaje*): tipo *Header Auth*, nombre de cabecera
   `X-Internal-Token`, valor = tu `INTERNAL_TOKEN`.
4. **Credencial de WhatsApp** (*WhatsApp Business Cloud*): access token de Meta; escribe el *Phone Number ID* en el nodo
   *Enviar mensaje por WhatsApp*.
5. **URL pública del cerebro** en el nodo *Reenviar al cerebro* (p. ej. un Cloudflare Tunnel hacia `localhost:3000`):
   `https://TU-TUNEL/api/inbound`. Solo hace falta exponer `/api/inbound` y `/health`.
6. En el `.env` del cerebro: `N8N_SEND_URL=https://jheff2920.app.n8n.cloud/webhook/red-whatsapp-enviar` y
   `WA_APP_SECRET` = *App Secret* de tu app de Meta (el cerebro valida la firma de Meta).
7. En Meta (WhatsApp → Configuración → Webhook): URL `https://jheff2920.app.n8n.cloud/webhook/red-whatsapp`, token de
   verificación `rs-wa-verify-7f3k9q2m` (el del nodo *¿Token de verificación correcto?*; cámbialo en ambos sitios si
   prefieres otro) y suscribe el campo `messages`.
8. **Alertas:** en el webhook de *Alerta a asesores* usa la **misma credencial Header Auth** del paso 3, conecta tu cuenta de
   Google en el nodo de Gmail y escribe el correo que recibirá los avisos. En el `.env` del cerebro:
   `ALERT_URL=https://jheff2920.app.n8n.cloud/webhook/red-whatsapp-alerta` y `PANEL_URL` con la dirección desde la que abres
   el panel (p. ej. `http://192.168.1.50:3001`) para que el correo traiga el enlace directo a la conversación.
   Para usar Telegram u otro canal basta con reemplazar el nodo de correo.
9. **Publica** los tres workflows en n8n.

## Contrato (lo comprueba `tests/n8n-workflows.test.ts`)

- Entrada: el cuerpo se reenvía byte a byte (webhook con *Raw Body* y petición con cuerpo binario) para que la firma
  HMAC coincida; cabeceras `X-Hub-Signature-256` y `X-Internal-Token`.
- Salida: el cerebro hace `POST` con `{ outboxId, messageId, to, text }` y la cabecera `X-Internal-Token`.
- Alertas: el cerebro hace `POST` con `{ type, conversationId, customerName, waId, reason, lastMessage, panelUrl }`
  (`type`: `escalado`, `mensaje_pendiente` o `cotizacion`) y la cabecera `X-Internal-Token`; n8n responde 200 o 502.
