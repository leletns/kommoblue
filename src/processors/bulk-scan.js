'use strict';

/**
 * Varredura em massa de todos os leads do Kommo.
 *
 * O que faz:
 *  1. Busca TODOS os leads de todos os pipelines
 *  2. Para cada lead: carrega histórico completo + analisa com IA
 *  3. Detecta automaticamente: comprovante de pagamento + CPF → GANHO
 *  4. Move pipeline, qualifica, enriquece dados
 *  5. Gera relatório completo da varredura
 *
 * Rota: POST /scan (inicia) | GET /scan/status (progresso)
 */

const kommo = require('../kommo/client');
const { loadConversationContext } = require('../kommo/conversation-loader');
const { analyzeConversation } = require('../ai/agent');
const logger = require('../utils/logger');

// Estado global da varredura
const scanState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  processed: 0,
  won: 0,
  moved: 0,
  errors: 0,
  skipped: 0,
  log: [],          // Últimas 100 ações
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
  /\b\d{3}[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{2}\b/, // CPF
  /\b\d{5}[\s.\-]?\d{3}\b/,                             // CEP
  /\bdata de nascimento\b/i,
  /\bnascido em\b/i,
  /\brg\b.*\d{6,}/i,
  /\bmatricula\b/i,
];

/**
 * Verifica se uma lista de mensagens contém comprovante + dados pessoais.
 * Se sim, deve ser marcado como GANHO.
 */
function detectPaymentAndData(messages) {
  const allText = messages.map((m) => m.text || '').join('\n').toLowerCase();

  const hasPayment = PAYMENT_PATTERNS.some((p) => p.test(allText));
  const hasCpf = CPF_PATTERN.test(allText);
  const hasPersonalData = DATA_PATTERNS.some((p) => p.test(allText));

  return {
    hasPayment,
    hasCpf,
    hasPersonalData,
    shouldBeWon: hasPayment && (hasCpf || hasPersonalData),
  };
}

/**
 * Inicia a varredura completa em background.
 * @param {object} options
 * @param {boolean} options.onlyActive - Apenas leads ativos (não perdidos/ganhos)
 * @param {number} options.delayMs - Delay entre leads para não sobrecarregar API
 */
async function startBulkScan({ onlyActive = false, delayMs = 2000 } = {}) {
  if (scanState.running) {
    return { error: 'Varredura já em andamento' };
  }

  // Reseta estado
  Object.assign(scanState, {
    running: true,
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

  logger.info('[BulkScan] Iniciando varredura completa de todos os leads...');

  // Executa em background
  runScan({ onlyActive, delayMs }).catch((err) => {
    logger.error('[BulkScan] Erro fatal na varredura:', err.message);
    scanState.running = false;
    scanState.finishedAt = new Date().toISOString();
  });

  return { started: true, message: 'Varredura iniciada em background' };
}

async function runScan({ onlyActive, delayMs }) {
  try {
    // 1. Busca todos os pipelines e suas etapas
    addLog('info', 'Carregando pipelines do Kommo...');
    let pipelines;
    try {
      pipelines = await kommo.getPipelinesWithStatuses();
      addLog('info', `${pipelines.length} pipeline(s) carregado(s): ${pipelines.map(p => p.name).join(', ')}`);
    } catch (err) {
      addLog('error', `ERRO ao carregar pipelines: ${err.message} (status: ${err.response?.status || 'sem status'})`);
      logger.error('[BulkScan] Falha ao carregar pipelines:', err.message);
      throw err;
    }

    // Mapeia status WON e LOST por pipeline
    const wonStatusMap = {};
    const lostStatusMap = {};
    for (const pipeline of pipelines) {
      const won = pipeline.statuses.find((s) => s.type === 142);
      const lost = pipeline.statuses.find((s) => s.type === 143);
      if (won) wonStatusMap[pipeline.id] = won;
      if (lost) lostStatusMap[pipeline.id] = lost;
    }

    // 2. Busca TODOS os leads
    const params = {};
    if (onlyActive) {
      // Filtra apenas leads não finalizados (não WON nem LOST)
      params.filter = { statuses: [{ pipeline_id: 0, status_id: 0 }] };
    }

    addLog('info', `Buscando todos os leads...`);
    let allLeads;
    try {
      allLeads = await kommo.fetchAllPages('/leads', params);
    } catch (err) {
      addLog('error', `ERRO ao buscar leads: ${err.message} (status: ${err.response?.status || 'sem status'})`);
      logger.error('[BulkScan] Falha ao buscar leads:', err.message);
      throw err;
    }
    scanState.total = allLeads.length;

    addLog('info', `Total de leads encontrados: ${allLeads.length}`);
    logger.info(`[BulkScan] ${allLeads.length} leads para processar`);

    // 3. Processa cada lead
    for (const lead of allLeads) {
      scanState.currentLead = { id: lead.id, name: lead.name };

      try {
        await processLeadScan(lead, wonStatusMap, lostStatusMap);
      } catch (err) {
        scanState.errors++;
        addLog('error', `Lead ${lead.id} (${lead.name}): ${err.message}`);
        logger.error(`[BulkScan] Erro no lead ${lead.id}:`, err.message);
      }

      scanState.processed++;

      // Delay para respeitar rate limits da API
      await sleep(delayMs);
    }
  } finally {
    scanState.running = false;
    scanState.finishedAt = new Date().toISOString();
    scanState.currentLead = null;

    const duration = Math.round(
      (new Date(scanState.finishedAt) - new Date(scanState.startedAt)) / 1000
    );

    const summary = `Varredura concluída em ${duration}s — ${scanState.processed} leads | ${scanState.won} ganhos | ${scanState.moved} movidos | ${scanState.errors} erros`;
    addLog('success', summary);
    logger.info(`[BulkScan] ${summary}`);
  }
}

async function processLeadScan(lead, wonStatusMap, lostStatusMap) {
  const leadId = lead.id;

  // 1. Carrega contexto completo
  const context = await loadConversationContext(leadId);
  const { messages, summary } = context;

  if (messages.length === 0) {
    scanState.skipped++;
    addLog('skip', `Lead ${leadId} (${lead.name || 'sem nome'}): sem mensagens`);
    return;
  }

  // 2. Detecção direta: comprovante + CPF/dados → GANHO imediato
  const detection = detectPaymentAndData(messages);

  if (detection.shouldBeWon) {
    const wonStatus = wonStatusMap[lead.pipeline_id];

    if (wonStatus && lead.status_id !== wonStatus.id) {
      await kommo.updateLead(leadId, {
        status_id: wonStatus.id,
        pipeline_id: lead.pipeline_id,
      });

      const note = `✅ [IA - Varredura] CONSULTA GANHA detectada automaticamente.\n` +
        `💳 Comprovante de pagamento: ${detection.hasPayment ? 'sim' : 'não'}\n` +
        `🪪 CPF detectado: ${detection.hasCpf ? 'sim' : 'não'}\n` +
        `📋 Dados pessoais: ${detection.hasPersonalData ? 'sim' : 'não'}\n` +
        `📍 Movido para: ${wonStatus.name}`;

      await kommo.addLeadNote(leadId, { text: note });
      await kommo.addTagsToLead(leadId, ['ia-ganho', 'comprovante-detectado']);

      scanState.won++;
      scanState.moved++;
      addLog('won', `Lead ${leadId} (${lead.name || 'sem nome'}) → GANHO (comprovante + dados detectados)`);
      return;
    } else if (lead.status_id === wonStatus?.id) {
      addLog('skip', `Lead ${leadId} já está como GANHO`);
      scanState.skipped++;
      return;
    }
  }

  // 3. Para os demais, usa IA para qualificar e mover pipeline
  const decision = await analyzeConversation({ ...context, newMessage: null });

  const actions = await applyDecision(leadId, decision, summary, context.contact);

  const wasMoved = actions.some((a) => a.type === 'pipeline_move');
  if (wasMoved) {
    scanState.moved++;
    const move = actions.find((a) => a.type === 'pipeline_move');
    addLog('moved', `Lead ${leadId} (${lead.name || 'sem nome'}): ${move.from} → ${move.to} (score: ${decision.qualification?.score})`);
  } else {
    addLog('analyzed', `Lead ${leadId} (${lead.name || 'sem nome'}): analisado, etapa mantida (score: ${decision.qualification?.score})`);
  }
}

function addLog(type, message) {
  scanState.log.unshift({ type, message, time: new Date().toLocaleTimeString('pt-BR') });
  if (scanState.log.length > 100) scanState.log.pop();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getScanStatus() {
  const progress = scanState.total > 0
    ? Math.round((scanState.processed / scanState.total) * 100)
    : 0;

  return { ...scanState, progress_percent: progress };
}

// Exporta applyDecision para uso no bulk scan
async function applyDecision(leadId, decision, summary, contact) {
  const { processNewMessage } = require('./conversation');
  // Reusa a lógica do processador normal
  const kommoClient = require('../kommo/client');
  const actions = [];

  if (decision.move_to_status_id && decision.move_to_status_id !== summary.current_status_id) {
    try {
      await kommoClient.updateLead(leadId, {
        status_id: decision.move_to_status_id,
        pipeline_id: summary.pipeline_id,
      });
      actions.push({
        type: 'pipeline_move',
        from: summary.current_status_name,
        to: decision.move_to_status_name,
      });
    } catch (err) {
      logger.error(`[BulkScan] Falha ao mover lead ${leadId}:`, err.message);
    }
  }

  if (decision.note_to_add) {
    try {
      const noteText = buildScanNote(decision);
      await kommoClient.addLeadNote(leadId, { text: noteText });
      actions.push({ type: 'note_added' });
    } catch (_) {}
  }

  const tags = buildScanTags(decision);
  if (tags.length > 0) {
    try {
      await kommoClient.addTagsToLead(leadId, tags);
      actions.push({ type: 'tags_added', tags });
    } catch (_) {}
  }

  return actions;
}

function buildScanNote(decision) {
  const score = decision.qualification?.score;
  const scoreLabel = decision.qualification?.score_label || '';
  const bant = decision.qualification?.bant;

  let note = `📊 [IA - Varredura] Score: ${score}/100 (${scoreLabel})\n`;
  note += `${decision.analysis}\n`;

  if (bant) {
    note += `BANT: Budget=${bant.budget} | Authority=${bant.authority} | Need=${bant.need} | Timeline=${bant.timeline}\n`;
  }

  if (decision.suggested_action) {
    note += `💡 ${decision.suggested_action}`;
  }

  return note.slice(0, 1000);
}

function buildScanTags(decision) {
  const tags = ['ia-varrido'];
  if (decision.qualification?.score_label) tags.push(`ia-${decision.qualification.score_label}`);
  if (decision.client_intent === 'comprar') tags.push('pronto-comprar');
  if (decision.urgency === 'alta' || decision.urgency === 'critica') tags.push('urgente');
  return [...new Set(tags)];
}

module.exports = { startBulkScan, getScanStatus, detectPaymentAndData };
