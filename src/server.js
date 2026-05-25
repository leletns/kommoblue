'use strict';

/**
 * Servidor principal — Express.js
 *
 * Rotas:
 *   POST /webhook/kommo      → recebe eventos do Kommo (mensagens, leads)
 *   GET  /auth/kommo         → inicia fluxo OAuth2
 *   GET  /auth/kommo/callback → recebe code OAuth2 e troca por token
 *   GET  /health             → status do servidor
 *   GET  /status             → status detalhado (pipelines, queue, tokens)
 */

const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./utils/logger');
const { handleWebhook, getQueueStats } = require('./kommo/webhook-handler');
const auth = require('./kommo/auth');
const kommo = require('./kommo/client');

const app = express();

// ─── Middleware ──────────────────────────────────────────────────────────────

// Parsa JSON e URL-encoded (Kommo usa ambos dependendo da configuração)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Log de todas as requisições
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path} — IP: ${req.ip}`);
  next();
});

// ─── Webhook Kommo ───────────────────────────────────────────────────────────

/**
 * Verifica assinatura HMAC do webhook (opcional, mas recomendado).
 * Configure WEBHOOK_SECRET igual ao definido no painel Kommo.
 */
function verifyWebhookSignature(req) {
  if (!config.kommo.webhookSecret) return true; // sem validação se não configurado

  const signature = req.headers['x-kommo-signature'] || req.headers['x-amocrm-signature'];
  if (!signature) {
    logger.warn('Webhook sem assinatura recebido');
    return false;
  }

  const body = JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', config.kommo.webhookSecret)
    .update(body)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

app.post('/webhook/kommo', async (req, res) => {
  // Responde imediatamente para o Kommo não reenviar (timeout de 10s)
  res.status(200).json({ received: true });

  // Processa em background
  setImmediate(async () => {
    try {
      const result = await handleWebhook(req.body, req.headers);
      logger.info(`Webhook processado: ${JSON.stringify(result)}`);
    } catch (err) {
      logger.error('Erro no processamento do webhook:', err.message);
    }
  });
});

// ─── OAuth2 ──────────────────────────────────────────────────────────────────

app.get('/auth/kommo', (req, res) => {
  const url = auth.getAuthorizationUrl();
  logger.info(`Redirecionando para OAuth Kommo: ${url}`);

  // Se ?debug=1, mostra a URL em vez de redirecionar
  if (req.query.debug) {
    return res.send(`
      <h2>URL de autorização gerada:</h2>
      <a href="${url}" target="_blank">${url}</a>
      <br><br>
      <p>Clique no link acima para autorizar</p>
      <h3>Config:</h3>
      <pre>${JSON.stringify({
        subdomain: config.kommo.subdomain,
        clientId: config.kommo.clientId ? config.kommo.clientId.slice(0,8)+'...' : 'NÃO DEFINIDO',
        redirectUri: config.kommo.redirectUri,
      }, null, 2)}</pre>
    `);
  }

  res.redirect(url);
});

app.get('/auth/kommo/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  logger.info('OAuth callback recebido — query params:', JSON.stringify(req.query));

  if (error) {
    logger.error('OAuth error:', error, error_description);
    return res.status(400).send(`Erro OAuth: ${error} — ${error_description || ''}`);
  }

  if (!code) {
    logger.warn('Callback sem code. Params recebidos:', JSON.stringify(req.query));
    return res.status(400).send(
      `<h2>Código de autorização não recebido</h2>
       <p>Params: ${JSON.stringify(req.query)}</p>
       <p>Verifique se o Redirect URI na integração Kommo está exatamente igual ao KOMMO_REDIRECT_URI do Railway.</p>`
    );
  }

  try {
    const tokens = await auth.exchangeCode(code);
    logger.info('OAuth Kommo concluído com sucesso!');

    res.send(`
      <html><body style="font-family:sans-serif;max-width:680px;margin:40px auto">
        <h1>✅ Kommo conectado!</h1>
        <p>Token expira em: <b>${new Date(tokens.expires_at * 1000).toLocaleString('pt-BR')}</b></p>

        <div style="background:#fff3cd;border:1px solid #ffc107;padding:16px;border-radius:8px;margin:20px 0">
          <h3 style="margin-top:0">⚠️ IMPORTANTE — Salve os tokens no Railway</h3>
          <p>Copie os 3 valores abaixo e cole nas <b>Variables do Railway</b> para não perder após reinício:</p>
        </div>

        <h3>KOMMO_ACCESS_TOKEN</h3>
        <textarea style="width:100%;height:80px;font-size:11px;padding:8px">${tokens.access_token}</textarea>

        <h3>KOMMO_REFRESH_TOKEN</h3>
        <textarea style="width:100%;height:80px;font-size:11px;padding:8px">${tokens.refresh_token}</textarea>

        <h3>KOMMO_TOKEN_EXPIRES_AT</h3>
        <input style="width:100%;padding:8px;font-size:13px" value="${tokens.expires_at}" readonly>

        <br><br>
        <p style="color:green">✅ O agente IA já está ativo e processando mensagens!</p>
      </body></html>
    `);
  } catch (err) {
    const detail = err.response?.data || err.message;
    logger.error('Falha na troca do código OAuth:', JSON.stringify(detail));
    res.status(500).send(`
      <h2>Erro ao autenticar</h2>
      <p><b>Erro:</b> ${err.message}</p>
      <h3>Resposta do Kommo:</h3>
      <pre style="background:#fee;padding:10px">${JSON.stringify(detail, null, 2)}</pre>
      <h3>Config enviada:</h3>
      <pre style="background:#f0f0f0;padding:10px">${JSON.stringify({
        client_id: config.kommo.clientId?.slice(0,8)+'...',
        redirect_uri: config.kommo.redirectUri,
        grant_type: 'authorization_code',
      }, null, 2)}</pre>
    `);
  }
});

// ─── Health & Status ─────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/status', async (req, res) => {
  const tokenStore = require('./utils/token-store');
  const tokens = tokenStore.getTokens();

  const status = {
    server: 'running',
    timestamp: new Date().toISOString(),
    kommo: {
      subdomain: config.kommo.subdomain,
      authenticated: !!tokens?.access_token,
      token_expires_at: tokens?.expires_at
        ? new Date(tokens.expires_at * 1000).toISOString()
        : null,
      token_expired: tokenStore.isExpired(tokens),
    },
    ai: {
      model: config.anthropic.model,
      api_key_set: !!config.anthropic.apiKey,
    },
    agent: config.agent,
    queue: getQueueStats(),
  };

  // Testa conexão com Kommo se autenticado
  if (tokens?.access_token) {
    try {
      const pipelines = await kommo.getPipelines();
      status.kommo.pipelines_count = pipelines.length;
    } catch (err) {
      status.kommo.connection_error = err.message;
    }
  }

  res.json(status);
});

// ─── Rota de teste manual ────────────────────────────────────────────────────

app.post('/analyze/:leadId', async (req, res) => {
  const { processNewMessage } = require('./processors/conversation');
  const leadId = parseInt(req.params.leadId, 10);

  if (isNaN(leadId)) {
    return res.status(400).json({ error: 'leadId inválido' });
  }

  logger.info(`Análise manual solicitada para lead ${leadId}`);

  try {
    const result = await processNewMessage({ leadId, message: null });
    res.json(result);
  } catch (err) {
    logger.error(`Erro na análise manual do lead ${leadId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Inicialização ────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  logger.info(`
╔══════════════════════════════════════════════════════╗
║          Kommo Blue — Agente IA ativo                ║
╠══════════════════════════════════════════════════════╣
║  Servidor:  http://localhost:${config.port}                   ║
║  Webhook:   POST /webhook/kommo                      ║
║  OAuth:     GET  /auth/kommo                         ║
║  Status:    GET  /status                             ║
║  Análise:   POST /analyze/:leadId                    ║
╚══════════════════════════════════════════════════════╝
  `);

  if (!config.kommo.subdomain) {
    logger.warn('⚠️  KOMMO_SUBDOMAIN não configurado. Configure o .env');
  }
  if (!config.anthropic.apiKey) {
    logger.warn('⚠️  ANTHROPIC_API_KEY não configurada. Configure o .env');
  }

  const tokenStore = require('./utils/token-store');
  const tokens = tokenStore.getTokens();
  if (!tokens?.access_token) {
    logger.warn('⚠️  Kommo não autenticado. Acesse GET /auth/kommo para autenticar');
  } else {
    logger.info('✅ Tokens Kommo carregados. Agente pronto para receber webhooks.');
  }
});

module.exports = app;
