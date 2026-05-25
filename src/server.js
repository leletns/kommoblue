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
      <html><body style="font-family:sans-serif;max-width:600px;margin:50px auto">
        <h1>✅ Kommo conectado!</h1>
        <p>Tokens salvos com sucesso. O agente IA está ativo.</p>
        <p>Você pode fechar esta janela.</p>
        <pre style="background:#f0f0f0;padding:10px">
Access token expira em: ${new Date(tokens.expires_at * 1000).toLocaleString('pt-BR')}
        </pre>
      </body></html>
    `);
  } catch (err) {
    logger.error('Falha na troca do código OAuth:', err.message);
    res.status(500).send(`Erro ao autenticar: ${err.message}`);
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
