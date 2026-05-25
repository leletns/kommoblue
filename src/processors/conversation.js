'use strict';

/**
 * Orquestrador principal: webhook → carregar contexto → IA → aplicar decisão
 *
 * Fluxo:
 *  1. Recebe evento do webhook (nova mensagem, lead novo, etc.)
 *  2. Carrega histórico completo da conversa
 *  3. Envia para o agente IA
 *  4. Aplica decisão: move pipeline, adiciona nota, envia resposta
 */

const kommo = require('../kommo/client');
const { loadConversationContext } = require('../kommo/conversation-loader');
const { analyzeConversation } = require('../ai/agent');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Processa uma nova mensagem recebida de um lead.
 * @param {object} event - Evento parseado do webhook
 */
async function processNewMessage(event) {
  const { leadId, message } = event;

  logger.info(`[Processor] Processando mensagem do lead ${leadId}`);

  // 1. Carrega contexto completo
  let context;
  try {
    context = await loadConversationContext(leadId);
  } catch (err) {
    logger.error(`[Processor] Falha ao carregar contexto do lead ${leadId}:`, err.message);
    return { success: false, error: err.message };
  }

  // Adiciona nova mensagem ao contexto (se ainda não estiver nas notas)
  const newMessage = message
    ? {
        text: message.text || message.content || '',
        timestamp: message.created_at || Math.floor(Date.now() / 1000),
        direction: 'inbound',
      }
    : null;

  // 2. Analisa com IA
  let decision;
  try {
    decision = await analyzeConversation({ ...context, newMessage });
  } catch (err) {
    logger.error(`[Processor] Falha na análise IA do lead ${leadId}:`, err.message);
    return { success: false, error: err.message };
  }

  // 3. Aplica decisão
  const actions = await applyDecision(leadId, decision, context.summary);

  return {
    success: true,
    lead_id: leadId,
    decision,
    actions_taken: actions,
  };
}

/**
 * Processa um lead recém-criado (ex: WhatsApp Lite → Unsorted aceito).
 */
async function processNewLead(leadId) {
  logger.info(`[Processor] Analisando novo lead ${leadId}`);
  return processNewMessage({ leadId, message: null });
}

/**
 * Aplica as decisões da IA no Kommo.
 */
async function applyDecision(leadId, decision, summary) {
  const actions = [];

  // ── 1. Mover pipeline ─────────────────────────────────────────────────────
  if (decision.move_to_status_id && decision.move_to_status_id !== summary.current_status_id) {
    try {
      await kommo.updateLead(leadId, {
        status_id: decision.move_to_status_id,
        pipeline_id: summary.pipeline_id,
      });

      logger.info(
        `[Processor] Lead ${leadId} movido: "${summary.current_status_name}" → "${decision.move_to_status_name}"`
      );
      actions.push({
        type: 'pipeline_move',
        from: summary.current_status_name,
        to: decision.move_to_status_name,
      });
    } catch (err) {
      logger.error(`[Processor] Falha ao mover lead ${leadId}:`, err.message);
    }
  }

  // ── 2. Adicionar nota ─────────────────────────────────────────────────────
  if (decision.note_to_add) {
    const noteText = buildNoteText(decision);
    try {
      await kommo.addLeadNote(leadId, { text: noteText });
      logger.info(`[Processor] Nota adicionada ao lead ${leadId}`);
      actions.push({ type: 'note_added', text: noteText.slice(0, 80) + '...' });
    } catch (err) {
      logger.error(`[Processor] Falha ao adicionar nota ao lead ${leadId}:`, err.message);
    }
  }

  // ── 3. Adicionar tags ─────────────────────────────────────────────────────
  if (decision.tags_to_add?.length > 0) {
    try {
      await kommo.addTagsToLead(leadId, decision.tags_to_add);
      logger.info(`[Processor] Tags adicionadas ao lead ${leadId}: ${decision.tags_to_add.join(', ')}`);
      actions.push({ type: 'tags_added', tags: decision.tags_to_add });
    } catch (err) {
      logger.error(`[Processor] Falha ao adicionar tags ao lead ${leadId}:`, err.message);
    }
  }

  // ── 4. Resposta automática ────────────────────────────────────────────────
  if (config.agent.autoReply && decision.reply_message && !config.agent.replyRequiresApproval) {
    logger.info(`[Processor] Resposta automática para lead ${leadId}: "${decision.reply_message}"`);
    // Aqui você pode integrar com o endpoint de envio de mensagem do Kommo
    // quando disponível via API (WhatsApp Lite send message)
    actions.push({ type: 'auto_reply_queued', message: decision.reply_message });
  }

  return actions;
}

/**
 * Formata a nota que será adicionada ao lead.
 */
function buildNoteText(decision) {
  const emoji = {
    positivo: '😊',
    muito_positivo: '🎉',
    neutro: '😐',
    negativo: '😟',
    muito_negativo: '😡',
  }[decision.sentiment] || '📝';

  const urgencyLabel = {
    baixa: '',
    media: '',
    alta: '⚠️ URGENTE: ',
    critica: '🚨 CRÍTICO: ',
  }[decision.urgency] || '';

  let note = `${emoji} [IA] ${urgencyLabel}${decision.note_to_add}`;

  if (decision.move_reason) {
    note += `\n📍 Motivo da mudança: ${decision.move_reason}`;
  }

  if (decision.suggested_action) {
    note += `\n💡 Próximo passo: ${decision.suggested_action}`;
  }

  return note;
}

module.exports = { processNewMessage, processNewLead };
