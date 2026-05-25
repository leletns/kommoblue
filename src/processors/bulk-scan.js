'use strict';

/**
 * Varredura em massa de todos os leads do Kommo.
 *
 * Estratégia anti-403:
 *  - Busca leads já enriquecidos (with=contacts,custom_fields_values) na LISTA
 *  - Evita GET /leads/{id} individual que retorna 403 em algumas contas
 *  - Notas e talks buscadas separadamente, com fallback gracioso
 */

const kommo = require('../kommo/client');
const { analyzeConversation } = require('../ai/agent');
const config = require('../config');
const logger = require('../utils/logger');

// Estado global da varredura
const scanState = {
  running: false,
  shouldStop: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  processed: 0,
  won: 0,
  moved: 0,
  errors: 0,
  skipped: 0,
  log: [],
  currentLead: null,
};

// Padrões de detecção no texto das mensagens
const PAYMENT_PATTERNS = [
  /comprovante/i, /paguei/i, /pagamento/i, /transferi/i, /pix/i,
  /boleto/i, /depositei/i, /já paguei/i, /efetuei/i, /realizei o pag/i,
  /confirmação de pag/i, /recibo/i,
];

const CPF_PATTERN = /\b\d{3}[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{2}\b/;

const DATA_PATTERNS = [
  /\b\d{3}[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{2}\b/,
  /\b\d{5}[\s.\-]?\d{3}\b/,
  /\bdata de nascimento\b/i,
  /\bnascido em\b/i,
  /\brg\b.*\d{6,}/i,
  /\bmatricula\b/i,
];

function detectPaymentAndData(messages) {
  const allText = messages.map((m) => m.text || '').join('\n').toLowerCase();
  const hasPayment = PAYMENT_PATTERNS.some((p) => p.test(allText));
  const hasCpf = CPF_PATTERN.test(allText);
  const hasPersonalData = DATA_PATTERNS.some((p) => p.test(allText));
  return { hasPayment, hasCpf, hasPersonalData, shouldBeWon: hasPayment && (hasCpf || hasPersonalData) };
}

/**
 * Para a varredura em andamento.
 */
function stopScan() {
  if (!scanState.running) return { error: 'Nenhuma varredura em andamento' };
  scanState.shouldStop = true;
  addLog('info', '⏹ Parada solicitada — aguardando o lead atual terminar...');
  return { ok: true };
}

/**
 * Inicia a varredura completa em background.
 */
async function startBulkScan({ onlyActive = false, delayMs = 3500 } = {}) {
  if (scanState.running) return { error: 'Varredura já em andamento' };

  Object.assign(scanState, {
    running: true,
    shouldStop: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: 0,
    processed: 0,
    won: 0,
    moved: 0,
    errors: 0,
    skipped: 0,
    log: [],
    currentLead: null,
  });

  logger.info('[BulkScan] Iniciando varredura...');

  runScan({ onlyActive, delayMs }).catch((err) => {
    logger.error('[BulkScan] Erro fatal:', err.message);
    addLog('error', `Erro fatal: ${err.message}`);
    scanState.running = false;
    scanState.finishedAt = new Date().toISOString();
  });

  return { started: true, message: 'Varredura iniciada em background' };
}

async function runScan({ onlyActive, delayMs }) {
  try {
    // 1. Pipelines
    addLog('info', 'Carregando pipelines...');
    let pipelines;
    try {
      pipelines = await kommo.getPipelinesWithStatuses();
      addLog('info', `${pipelines.length} pipeline(s): ${pipelines.map((p) => p.name).join(', ')}`);
    } catch (err) {
      addLog('error', `ERRO pipelines: ${err.message} (${err.response?.status})`);
      throw err;
    }

    const wonStatusMap = {};
    const lostStatusMap = {};
    for (const pipeline of pipelines) {
      const won = pipeline.statuses.find((s) => s.type === 142);
      const lost = pipeline.statuses.find((s) => s.type === 143);
      if (won) wonStatusMap[pipeline.id] = won;
      if (lost) lostStatusMap[pipeline.id] = lost;
    }

    // 2. Busca leads JÁ ENRIQUECIDOS na lista (evita GET /leads/{id} individual)
    addLog('info', 'Buscando leads com dados enriquecidos...');
    let allLeads;
    try {
      const params = { with: 'contacts,tags,custom_fields_values' };
      if (onlyActive) params.filter = { statuses: [{ pipeline_id: 0, status_id: 0 }] };
      allLeads = await kommo.fetchAllPages('/leads', params);
    } catch (err) {
      // Fallback: busca sem with se também der 403
      addLog('error', `Erro com with= (${err.response?.status}), tentando sem enriquecimento...`);
      try {
        const params = {};
        if (onlyActive) params.filter = { statuses: [{ pipeline_id: 0, status_id: 0 }] };
        allLeads = await kommo.fetchAllPages('/leads', params);
      } catch (err2) {
        addLog('error', `ERRO ao buscar leads: ${err2.message}`);
        throw err2;
      }
    }

    scanState.total = allLeads.length;
    addLog('info', `Total: ${allLeads.length} leads encontrados`);

    // 3. Processa cada lead
    for (const lead of allLeads) {
      if (scanState.shouldStop) {
        addLog('info', '⏹ Varredura interrompida pelo usuário');
        break;
      }

      scanState.currentLead = { id: lead.id, name: lead.name };

      let retries = 0;
      while (retries <= 2) {
        try {
          await processLeadScan(lead, wonStatusMap, lostStatusMap, pipelines);
          break;
        } catch (err) {
          if (err.response?.status === 429 && retries < 2) {
            retries++;
            const wait = 10000 * retries; // 10s, 20s
            addLog('info', `Rate limit (429) — aguardando ${wait/1000}s antes de tentar lead ${lead.id} novamente...`);
            await sleep(wait);
          } else {
            scanState.errors++;
            addLog('error', `Lead ${lead.id} (${lead.name || 'sem nome'}): ${err.message}`);
            logger.error(`[BulkScan] Lead ${lead.id}:`, err.message);
            break;
          }
        }
      }

      scanState.processed++;
      await sleep(delayMs);
    }
  } finally {
    scanState.running = false;
    scanState.finishedAt = new Date().toISOString();
    scanState.currentLead = null;

    const duration = Math.round((new Date(scanState.finishedAt) - new Date(scanState.startedAt)) / 1000);
    const summary = `Varredura concluída em ${duration}s — ${scanState.processed} leads | ${scanState.won} ganhos | ${scanState.moved} movidos | ${scanState.errors} erros`;
    addLog('success', summary);
    logger.info(`[BulkScan] ${summary}`);
  }
}

/**
 * Processa um lead usando os dados já carregados da lista enriquecida.
 * Não faz GET /leads/{id} — usa os dados do lead que já vieram da lista.
 */
async function processLeadScan(lead, wonStatusMap, lostStatusMap, pipelines) {
  const leadId = lead.id;

  // Busca notas (opcional — silencia 403)
  let notes = [];
  try {
    notes = await kommo.getLeadNotes(leadId);
  } catch (err) {
    if (err.response?.status !== 403) throw err;
    logger.warn(`[BulkScan] Lead ${leadId}: sem acesso a notas (403), continuando`);
  }

  // Busca talks WhatsApp Lite (opcional — silencia 403/404)
  let talkMessages = [];
  try {
    const talks = await kommo.getTalksByLead(leadId);
    if (talks.length > 0) {
      const allMsgs = await Promise.all(talks.map((t) => kommo.getTalkMessages(t.id)));
      allMsgs.forEach((msgs) => talkMessages.push(...msgs));
    }
  } catch (err) {
    if (![403, 404].includes(err.response?.status)) throw err;
    logger.warn(`[BulkScan] Lead ${leadId}: sem acesso a talks (${err.response?.status})`);
  }

  // Normaliza notas em mensagens
  const normalizedNotes = notes
    .filter((n) => n.params?.text || n.text)
    .map((n) => ({
      id: `note_${n.id}`,
      timestamp: n.created_at,
      direction: n.created_by === 0 ? 'inbound' : 'outbound',
      text: n.params?.text || n.text || '',
      type: 'nota',
    }));

  // Normaliza msgs WhatsApp
  const normalizedTalkMsgs = talkMessages.map((msg) => ({
    id: `msg_${msg.id}`,
    timestamp: msg.created_at,
    direction: msg.author?.type === 'contact' ? 'inbound' : 'outbound',
    text: msg.content?.text || msg.content?.media?.name || '[mídia]',
    type: 'whatsapp',
  }));

  const seen = new Set();
  const messages = [...normalizedNotes, ...normalizedTalkMsgs]
    .filter((m) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; })
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-config.agent.maxContextMessages);

  if (messages.length === 0) {
    scanState.skipped++;
    addLog('skip', `Lead ${leadId} (${lead.name || 'sem nome'}): sem mensagens`);
    return;
  }

  // Detecta comprovante + CPF → GANHO imediato
  const detection = detectPaymentAndData(messages);
  if (detection.shouldBeWon) {
    const wonStatus = wonStatusMap[lead.pipeline_id];
    if (wonStatus && lead.status_id !== wonStatus.id) {
      await kommo.updateLead(leadId, { status_id: wonStatus.id, pipeline_id: lead.pipeline_id });
      const note = `✅ [IA - Varredura] CONSULTA GANHA detectada automaticamente.\n💳 Comprovante: sim\n🪪 CPF: ${detection.hasCpf ? 'sim' : 'não'}\n📋 Dados pessoais: ${detection.hasPersonalData ? 'sim' : 'não'}\n📍 Movido para: ${wonStatus.name}`;
      await kommo.addLeadNote(leadId, { text: note }).catch(() => {});
      await kommo.addTagsToLead(leadId, ['ia-ganho', 'comprovante-detectado']).catch(() => {});
      scanState.won++;
      scanState.moved++;
      addLog('won', `Lead ${leadId} (${lead.name || 'sem nome'}) → GANHO 🎉`);
      return;
    } else if (lead.status_id === wonStatus?.id) {
      addLog('skip', `Lead ${leadId} já GANHO`);
      scanState.skipped++;
      return;
    }
  }

  // Monta contexto para IA com dados já disponíveis
  const tags = lead._embedded?.tags?.map((t) => t.name) || [];
  const customFields = (lead.custom_fields_values || []).map((f) => ({
    code: f.field_code, name: f.field_name, value: f.values?.[0]?.value ?? null,
  })).filter((f) => f.value !== null);

  // Encontra nome do pipeline e status
  const pipeline = pipelines.find((p) => p.id === lead.pipeline_id);
  const status = pipeline?.statuses?.find((s) => s.id === lead.status_id);

  const summary = {
    lead_id: lead.id,
    lead_name: lead.name,
    lead_value: lead.price,
    pipeline_id: lead.pipeline_id,
    pipeline_name: pipeline?.name || `Pipeline ${lead.pipeline_id}`,
    current_status_id: lead.status_id,
    current_status_name: status?.name || `Status ${lead.status_id}`,
    contact_id: lead._embedded?.contacts?.[0]?.id || null,
    contact_name: lead._embedded?.contacts?.[0]?.name || null,
    contact_phone: null,
    contact_email: null,
    created_at: lead.created_at,
    total_messages: messages.length,
    tags,
    utms: extractUtms(lead),
    custom_fields: customFields,
    contact_custom_fields: [],
  };

  // IA analisa
  const decision = await analyzeConversation({ lead, contact: null, summary, messages, newMessage: null });

  // Aplica decisão
  const actions = await applyBulkDecision(leadId, decision, summary);

  const wasMoved = actions.some((a) => a.type === 'pipeline_move');
  if (wasMoved) {
    scanState.moved++;
    const move = actions.find((a) => a.type === 'pipeline_move');
    addLog('moved', `Lead ${leadId} (${lead.name || 'sem nome'}): ${move.from} → ${move.to} (score: ${decision.qualification?.score})`);
  } else {
    addLog('analyzed', `Lead ${leadId} (${lead.name || 'sem nome'}): score ${decision.qualification?.score}/100 — etapa mantida`);
  }
}

function extractUtms(lead) {
  const fields = lead?.custom_fields_values || [];
  const utmMap = {};
  const utmCodes = ['UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_TERM', 'UTM_CONTENT'];
  for (const field of fields) {
    const code = (field.field_code || '').toUpperCase();
    const match = utmCodes.find((u) => u === code);
    if (match) utmMap[match.toLowerCase()] = field.values?.[0]?.value || null;
  }
  return { source: utmMap.utm_source || null, medium: utmMap.utm_medium || null, campaign: utmMap.utm_campaign || null, term: utmMap.utm_term || null, content: utmMap.utm_content || null };
}

async function applyBulkDecision(leadId, decision, summary) {
  const actions = [];

  if (decision.move_to_status_id && decision.move_to_status_id !== summary.current_status_id) {
    try {
      await kommo.updateLead(leadId, { status_id: decision.move_to_status_id, pipeline_id: summary.pipeline_id });
      actions.push({ type: 'pipeline_move', from: summary.current_status_name, to: decision.move_to_status_name });
    } catch (err) {
      logger.error(`[BulkScan] Falha ao mover lead ${leadId}:`, err.message);
    }
  }

  if (decision.note_to_add) {
    try {
      const score = decision.qualification?.score;
      const note = `📊 [IA] Score: ${score}/100 (${decision.qualification?.score_label || ''})\n${decision.analysis || ''}\n${decision.suggested_action ? '💡 ' + decision.suggested_action : ''}`.trim().slice(0, 1000);
      await kommo.addLeadNote(leadId, { text: note });
      actions.push({ type: 'note_added' });
    } catch (_) {}
  }

  const tags = ['ia-varrido'];
  if (decision.qualification?.score_label) tags.push(`ia-${decision.qualification.score_label}`);
  if (decision.temperature) tags.push(`temp-${decision.temperature}`);
  if (decision.client_intent === 'comprar') tags.push('pronto-comprar');
  if (decision.urgency === 'alta' || decision.urgency === 'critica') tags.push('urgente');

  try {
    await kommo.addTagsToLead(leadId, [...new Set(tags)]);
    actions.push({ type: 'tags_added', tags });
  } catch (_) {}

  // Task creation
  if (decision.task_to_create && decision.temperature !== 'frio' && decision.temperature !== 'desqualificado') {
    try {
      const taskTypeMap = { call: 1, meeting: 2, email: 3, followup: 1 };
      const dueDays = decision.task_to_create.due_days || 1;
      const dueTimestamp = Math.floor(Date.now() / 1000) + (dueDays * 86400);

      await kommo.createTask(leadId, {
        text: decision.task_to_create.text,
        completeTillTimestamp: dueTimestamp,
        taskTypeId: taskTypeMap[decision.task_to_create.type] || 1,
      });
      actions.push({ type: 'task_created', text: decision.task_to_create.text });
    } catch (err) {
      logger.error(`[BulkScan] Falha ao criar tarefa lead ${leadId}:`, err.message);
    }
  }

  return actions;
}

function addLog(type, message) {
  scanState.log.unshift({ type, message, time: new Date().toLocaleTimeString('pt-BR') });
  if (scanState.log.length > 100) scanState.log.pop();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getScanStatus() {
  const progress = scanState.total > 0 ? Math.round((scanState.processed / scanState.total) * 100) : 0;
  return { ...scanState, progress_percent: progress };
}

module.exports = { startBulkScan, stopScan, getScanStatus, detectPaymentAndData };
