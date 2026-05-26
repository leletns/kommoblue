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

// Armazena últimos webhooks recebidos para debug
const recentWebhooks = [];

// GET para confirmar que o webhook está ativo (browser test)
app.get('/webhook/kommo', (req, res) => {
  res.json({ status: 'ok', message: 'Webhook ativo — aguardando POST do Kommo', url: req.originalUrl });
});

app.post('/webhook/kommo', async (req, res) => {
  // Salva payload para debug (últimos 5)
  recentWebhooks.unshift({ time: new Date().toLocaleTimeString('pt-BR'), body: req.body });
  if (recentWebhooks.length > 5) recentWebhooks.pop();

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

    const envBlock = `KOMMO_ACCESS_TOKEN="${tokens.access_token}"\nKOMMO_REFRESH_TOKEN="${tokens.refresh_token}"\nKOMMO_TOKEN_EXPIRES_AT="${tokens.expires_at}"`;

    res.send(`
      <html><head><meta charset="utf-8"></head>
      <body style="font-family:sans-serif;max-width:720px;margin:40px auto;padding:0 20px">
        <h1>✅ Kommo conectado!</h1>
        <p>Token expira em: <b>${new Date(tokens.expires_at * 1000).toLocaleString('pt-BR')}</b></p>

        <div style="background:#fff3cd;border:2px solid #f59e0b;padding:16px;border-radius:8px;margin:20px 0">
          <h3 style="margin-top:0">⚠️ Cole isso no Raw Editor do Railway</h3>
          <p>1. No Railway → Variables → <b>Raw Editor</b><br>
             2. Seleciona tudo (Ctrl+A) e apaga<br>
             3. Cola o bloco abaixo<br>
             4. Clica <b>Update Variables</b></p>
        </div>

        <p><b>Clica no botão para copiar tudo de uma vez:</b></p>
        <button onclick="copyAll()" style="background:#7c3aed;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:16px;cursor:pointer;margin-bottom:12px">
          📋 Copiar tokens para o Railway
        </button>
        <span id="ok" style="color:green;display:none;margin-left:10px">✅ Copiado!</span>

        <textarea id="envblock" readonly style="width:100%;height:120px;font-size:11px;padding:12px;font-family:monospace;white-space:nowrap;overflow-x:auto;background:#111;color:#0f0;border-radius:8px">${envBlock}</textarea>

        <p style="color:#666;font-size:13px">⚠️ Esses são apenas os 3 tokens novos. No Raw Editor do Railway, mantenha todas as outras variáveis que já estão lá e apenas substitua/adicione essas 3 linhas.</p>

        <p style="color:green;margin-top:20px">✅ O agente IA já está ativo!</p>

        <script>
          function copyAll() {
            const t = document.getElementById('envblock');
            t.select();
            document.execCommand('copy');
            document.getElementById('ok').style.display='inline';
          }
        </script>
      </body></html>
    `);
  } catch (err) {
    const detail = err.response?.data || err.message;
    const status = err.response?.status;
    logger.error('Falha na troca do código OAuth:', JSON.stringify(detail));

    // Gera comando curl para o usuário trocar o token manualmente se necessário
    const curlCmd = `curl -X POST "https://${config.kommo.subdomain}.kommo.com/oauth2/access_token" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "client_id=${config.kommo.clientId}&client_secret=${config.kommo.clientSecret}&grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(config.kommo.redirectUri)}"`;

    res.status(500).send(`
      <html><head><meta charset="utf-8"></head>
      <body style="font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px">
        <h2>❌ Erro ${status || ''} ao autenticar</h2>
        <p><b>Erro:</b> ${err.message}</p>

        ${status === 403 ? `
        <div style="background:#fef3c7;border:2px solid #f59e0b;padding:16px;border-radius:8px;margin:20px 0">
          <h3 style="margin-top:0">⚠️ 403 Forbidden — IP do Railway bloqueado temporariamente</h3>
          <p>O Kommo bloqueou temporariamente o servidor do Railway. Opções:</p>
          <ol>
            <li><b>Aguarda 30 min</b> e tenta novamente em <a href="/auth/kommo">/auth/kommo</a></li>
            <li><b>Troca o token manualmente</b> rodando o curl abaixo no seu computador:</li>
          </ol>
          <p>Copia e cola no terminal do seu PC (PowerShell ou CMD):</p>
          <textarea readonly style="width:100%;height:120px;font-size:11px;padding:8px;font-family:monospace;background:#111;color:#0f0;border-radius:6px">${curlCmd}</textarea>
          <button onclick="document.querySelector('textarea').select();document.execCommand('copy')" style="margin-top:8px;background:#7c3aed;color:#fff;border:none;padding:10px 20px;border-radius:6px;cursor:pointer">📋 Copiar curl</button>
          <p style="margin-top:16px;color:#666;font-size:13px">O curl vai retornar um JSON com access_token, refresh_token e expires_in. Cole esses valores no Railway.</p>
        </div>
        ` : ''}

        <details>
          <summary>Detalhes técnicos</summary>
          <pre style="background:#fee;padding:10px">${JSON.stringify(detail, null, 2)}</pre>
        </details>
      </body></html>
    `);
  }
});

// Debug: últimos webhooks recebidos
app.get('/webhook/recent', (req, res) => res.json(recentWebhooks));

// ─── Health & Status ─────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug — testa conexão real com a API Kommo
app.get('/debug-api', async (req, res) => {
  const kommoClient = require('./kommo/client');
  const tokenStore = require('./utils/token-store');
  const results = {};

  results.baseUrl = config.kommo.baseUrl;
  results.subdomain = config.kommo.subdomain;

  const tokens = tokenStore.getTokens();
  results.tokenPresent = !!tokens?.access_token;
  results.tokenPreview = tokens?.access_token ? tokens.access_token.slice(0, 20) + '...' : 'none';

  const { http } = kommoClient;

  // Testa /leads (lista)
  try {
    const r = await http.get('/leads', { params: { limit: 1 } });
    const firstLead = r.data?._embedded?.leads?.[0];
    results.leads_list = { status: r.status, sample: firstLead ? { id: firstLead.id, name: firstLead.name } : null };

    // Testa detalhe do primeiro lead
    if (firstLead?.id) {
      try {
        const r2 = await http.get(`/leads/${firstLead.id}`, {
          params: { with: 'contacts,pipeline,custom_fields_values' },
        });
        results.leads_detail = { status: r2.status, name: r2.data?.name };
      } catch (e2) {
        results.leads_detail = { error: e2.message, status: e2.response?.status };
      }

      // Testa notas
      try {
        const r3 = await http.get(`/leads/${firstLead.id}/notes`, { params: { limit: 1 } });
        results.notes_test = { status: r3.status };
      } catch (e3) {
        results.notes_test = { error: e3.message, status: e3.response?.status };
      }

      // Testa talks
      try {
        const r4 = await http.get('/talks', { params: { entity_id: firstLead.id, entity_type: 'leads', limit: 1 } });
        results.talks_test = { status: r4.status };
      } catch (e4) {
        results.talks_test = { error: e4.message, status: e4.response?.status };
      }
    }
  } catch (err) {
    results.leads_list = { error: err.message, status: err.response?.status, body: err.response?.data };
  }

  // Testa /leads/pipelines
  try {
    const r = await http.get('/leads/pipelines', { params: { limit: 10 } });
    results.pipelines_test = { status: r.status, count: r.data?._embedded?.pipelines?.length || 0 };
  } catch (err) {
    results.pipelines_test = { error: err.message, status: err.response?.status, body: err.response?.data };
  }

  // Testa /account
  try {
    const r = await http.get('/account');
    results.account_test = { status: r.status, name: r.data?.name, subdomain: r.data?.subdomain };
  } catch (err) {
    results.account_test = { error: err.message, status: err.response?.status };
  }

  res.json(results);
});

// Debug — mostra o que o servidor está lendo das variáveis
app.get('/debug-env', (req, res) => {
  const at = process.env.KOMMO_ACCESS_TOKEN;
  const rt = process.env.KOMMO_REFRESH_TOKEN;
  const exp = process.env.KOMMO_TOKEN_EXPIRES_AT;
  res.json({
    KOMMO_ACCESS_TOKEN: at ? `SET (${at.length} chars, starts: ${at.slice(0,12)}...)` : 'NÃO DEFINIDO',
    KOMMO_REFRESH_TOKEN: rt ? `SET (${rt.length} chars)` : 'NÃO DEFINIDO',
    KOMMO_TOKEN_EXPIRES_AT: exp || 'NÃO DEFINIDO',
    KOMMO_SUBDOMAIN: process.env.KOMMO_SUBDOMAIN || 'NÃO DEFINIDO',
    KOMMO_CLIENT_ID: process.env.KOMMO_CLIENT_ID ? 'SET' : 'NÃO DEFINIDO',
  });
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

// ─── Debug de lead específico ─────────────────────────────────────────────────

/**
 * GET /debug-lead/:id
 * Mostra TODOS os dados brutos de um lead: notas, talks, tipos, textos.
 * Use para diagnosticar por que o lead não tem conversa visível.
 */
app.get('/debug-lead/:id', async (req, res) => {
  const leadId = parseInt(req.params.id, 10);
  if (isNaN(leadId)) return res.status(400).json({ error: 'leadId inválido' });

  const { http } = kommo;
  const result = { leadId };

  // Notas raw
  try {
    const notesRes = await http.get(`/leads/${leadId}/notes`, { params: { limit: 50 } });
    const notes = notesRes.data?._embedded?.notes || [];
    result.notes_count = notes.length;
    result.note_types = [...new Set(notes.map((n) => n.note_type))];
    result.notes_sample = notes.slice(0, 10).map((n) => ({
      id: n.id,
      note_type: n.note_type,
      created_by: n.created_by,
      created_at: new Date(n.created_at * 1000).toLocaleString('pt-BR'),
      text_preview: (n.params?.text || n.text || '').slice(0, 120),
      params_keys: Object.keys(n.params || {}),
    }));
  } catch (err) {
    result.notes_error = { status: err.response?.status, message: err.message };
  }

  // Notas do CONTATO (WhatsApp pode estar linkado ao contato, não ao lead)
  try {
    const leadRes = await http.get('/leads', {
      params: { 'filter[id]': leadId, with: 'contacts', limit: 1 },
    });
    const contactId = leadRes.data?._embedded?.leads?.[0]?._embedded?.contacts?.[0]?.id;
    result.contact_id = contactId || null;

    if (contactId) {
      const cNotesRes = await http.get(`/contacts/${contactId}/notes`, { params: { limit: 50 } });
      const cNotes = cNotesRes.data?._embedded?.notes || [];
      result.contact_notes_count = cNotes.length;
      result.contact_note_types = [...new Set(cNotes.map((n) => n.note_type))];
      result.contact_notes_sample = cNotes.slice(0, 10).map((n) => ({
        id: n.id,
        note_type: n.note_type,
        created_by: n.created_by,
        created_at: new Date(n.created_at * 1000).toLocaleString('pt-BR'),
        text_preview: (n.params?.text || n.text || '').slice(0, 150),
        params_keys: Object.keys(n.params || {}),
      }));
    }
  } catch (err) {
    result.contact_notes_error = { status: err.response?.status, message: err.message };
  }

  // Talks via filter[entity_id]
  try {
    const talksRes = await http.get('/talks', {
      params: { 'filter[entity_id]': leadId, 'filter[entity_type]': 'leads', limit: 10 },
    });
    const talks = talksRes.data?._embedded?.talks || [];
    result.talks_count = talks.length;
    result.talks_sample = talks.slice(0, 3).map((t) => ({
      id: t.id,
      entity_id: t.entity_id,
      entity_type: t.entity_type,
      source_uid: t.source_uid,
    }));

    if (talks.length > 0) {
      try {
        const msgsRes = await http.get(`/talks/${talks[0].id}/messages`, { params: { limit: 10 } });
        const msgs = msgsRes.data?._embedded?.messages || [];
        result.talk_msgs_count = msgs.length;
        result.talk_msgs_sample = msgs.slice(0, 5).map((m) => ({
          id: m.id,
          author_type: m.author?.type,
          content_type: m.content?.type,
          text: (m.content?.text || '').slice(0, 100),
        }));
      } catch (err2) {
        result.talk_msgs_error = { status: err2.response?.status, message: err2.message };
      }
    }
  } catch (err) {
    result.talks_error = { status: err.response?.status, message: err.message };
  }

  // Testa /chats (endpoint alternativo para WhatsApp Lite)
  try {
    const chatsRes = await http.get('/chats', {
      params: { 'filter[entity_id]': leadId, 'filter[entity_type]': 'leads', limit: 5 },
    });
    const chats = chatsRes.data?._embedded?.chats || [];
    result.chats_count = chats.length;
    result.chats_status = chatsRes.status;
    result.chats_sample = chats.slice(0, 2);

    // Tenta buscar mensagens de chats
    if (chats.length > 0) {
      try {
        const chatMsgRes = await http.get(`/chats/${chats[0].id}/messages`, { params: { limit: 5 } });
        result.chat_msgs_count = chatMsgRes.data?._embedded?.messages?.length ?? 0;
        result.chat_msgs_sample = (chatMsgRes.data?._embedded?.messages || []).slice(0, 3).map((m) => ({
          author_type: m.author?.type,
          text: (m.content?.text || '').slice(0, 100),
        }));
      } catch (err2) {
        result.chat_msgs_error = { status: err2.response?.status, msg: err2.message };
      }
    }
  } catch (err) {
    result.chats_error = { status: err.response?.status, message: err.message };
  }

  // Testa /events (histórico de eventos — pode conter mensagens WhatsApp)
  try {
    const evtRes = await http.get('/events', {
      params: { 'filter[entity][id][]': leadId, 'filter[entity][type]': 'lead', limit: 10 },
    });
    const events = evtRes.data?._embedded?.events || [];
    result.events_count = events.length;
    result.events_types = [...new Set(events.map((e) => e.type))];
    result.events_sample = events.slice(0, 3).map((e) => ({
      type: e.type,
      entity_type: e.entity?.type,
      created_at: new Date(e.created_at * 1000).toLocaleString('pt-BR'),
    }));
  } catch (err) {
    result.events_error = { status: err.response?.status, message: err.message };
  }

  // Lead embedded
  try {
    const leadRes = await http.get('/leads', {
      params: { 'filter[id]': leadId, with: 'contacts,tags,custom_fields_values,chats', limit: 1 },
    });
    const leads = leadRes.data?._embedded?.leads || [];
    if (leads.length > 0) {
      const l = leads[0];
      result.lead_name = l.name;
      result.lead_status_id = l.status_id;
      result.lead_embedded_keys = Object.keys(l._embedded || {});
      result.lead_embedded_chats = l._embedded?.chats || [];
    }
  } catch (err) {
    result.lead_error = { status: err.response?.status, message: err.message };
  }

  res.json(result);
});

// ─── Varredura em massa ───────────────────────────────────────────────────────

app.post('/scan', async (req, res) => {
  const { startBulkScan } = require('./processors/bulk-scan');
  const onlyActive = req.query.only_active === 'true';
  const delayMs = parseInt(req.query.delay || '2000', 10);
  const recentDays = parseInt(req.query.recent_days || '0', 10);

  const result = await startBulkScan({ onlyActive, delayMs, recentDays });
  res.json(result);
});

app.post('/scan/stop', (req, res) => {
  const { stopScan } = require('./processors/bulk-scan');
  res.json(stopScan());
});

app.get('/scan/status', (req, res) => {
  const { getScanStatus } = require('./processors/bulk-scan');
  res.json(getScanStatus());
});

// Painel visual da varredura
app.get('/scan', (req, res) => {
  res.send(`
    <html><head>
      <meta charset="utf-8">
      <title>Varredura — Kommo Blue</title>
      <style>
        body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px}
        .btn{background:#7c3aed;color:#fff;border:none;padding:12px 28px;border-radius:8px;cursor:pointer;font-size:16px;margin-right:10px}
        .btn:hover{background:#6d28d9}
        .btn-sec{background:#059669}
        .progress{background:#e5e7eb;border-radius:8px;height:24px;margin:16px 0}
        .progress-bar{background:#7c3aed;height:100%;border-radius:8px;transition:width .5s;display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px}
        .log{background:#111;color:#0f0;padding:16px;border-radius:8px;height:300px;overflow-y:auto;font-size:12px;font-family:monospace}
        .stat{display:inline-block;background:#f3f4f6;border-radius:8px;padding:12px 20px;margin:8px;text-align:center}
        .stat b{display:block;font-size:28px;color:#7c3aed}
        .won{color:#059669} .moved{color:#2563eb} .error{color:#dc2626} .skip{color:#9ca3af}
      </style>
    </head><body>
      <h1>🔍 Varredura em Massa — Kommo Blue</h1>
      <p>Processa TODOS os leads do Kommo: detecta comprovantes + CPF, qualifica e move pipelines automaticamente.</p>

      <button class="btn" onclick="startScan(0)">▶ Varrer TODOS os leads</button>
      <button class="btn btn-sec" onclick="startScan(14)" style="background:#0284c7">🕐 Últimas 2 semanas</button>
      <button class="btn btn-sec" onclick="startScan(7)" style="background:#059669">🕐 Última semana</button>
      <button class="btn" style="background:#dc2626;margin-top:8px" onclick="stopScan()">⏹ Parar varredura</button>

      <div id="stats" style="margin-top:20px"></div>
      <div class="progress"><div class="progress-bar" id="bar" style="width:0%">0%</div></div>
      <div class="log" id="log">Aguardando início da varredura...</div>

      <script>
        let interval;
        async function startScan(recentDays) {
          const label = recentDays > 0 ? `últimos ${recentDays} dias` : 'todos os leads';
          if(!confirm(`Iniciar varredura (${label})?`)) return;
          await fetch('/scan?recent_days='+recentDays, {method:'POST'});
          clearInterval(interval);
          interval = setInterval(updateStatus, 2000);
          updateStatus();
        }
        async function stopScan() {
          if(!confirm('Parar a varredura?')) return;
          await fetch('/scan/stop', {method:'POST'});
          clearInterval(interval);
          updateStatus();
        }
        async function updateStatus() {
          const r = await fetch('/scan/status');
          const d = await r.json();
          const p = d.progress_percent || 0;
          document.getElementById('bar').style.width = p+'%';
          document.getElementById('bar').textContent = p+'%';
          document.getElementById('stats').innerHTML =
            '<div class="stat"><b>'+d.total+'</b>Total</div>'+
            '<div class="stat"><b>'+d.processed+'</b>Processados</div>'+
            '<div class="stat" style="color:#059669"><b>'+d.won+'</b>Ganhos 🎉</div>'+
            '<div class="stat" style="color:#2563eb"><b>'+d.moved+'</b>Movidos</div>'+
            '<div class="stat" style="color:#dc2626"><b>'+d.errors+'</b>Erros</div>'+
            (d.currentLead ? '<div class="stat"><b style="font-size:14px">'+d.currentLead.name+'</b>Processando</div>' : '');
          const log = (d.log||[]).map(l => {
            const cls = l.type==='won'?'won':l.type==='moved'?'moved':l.type==='error'?'error':'skip';
            return '<div class="'+cls+'">['+l.time+'] '+l.message+'</div>';
          }).join('');
          document.getElementById('log').innerHTML = log || 'Sem logs ainda...';
          if(!d.running && d.finishedAt) {
            clearInterval(interval);
            document.getElementById('bar').style.background = '#059669';
          }
        }
        // Atualiza status ao carregar se já houver varredura
        updateStatus();
      </script>
    </body></html>
  `);
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
