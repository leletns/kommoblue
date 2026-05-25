'use strict';

/**
 * Parser e dispatcher de webhooks do Kommo.
 *
 * Suporta os seguintes eventos do WhatsApp Lite:
 *   - message.add        → nova mensagem em lead existente
 *   - add_note           → nova nota/mensagem no lead
 *   - leads.unsorted.add → nova conversa WhatsApp (lead não classificado)
 *   - leads.add          → novo lead criado
 *   - leads.status       → mudança de status (não processado pela IA, só logado)
 *
 * Docs webhooks: https://www.kommo.com/developers/content/crm_platform/webhooks/
 */

const PQueue = require('p-queue').default;
const { processNewMessage, processNewLead } = require('../processors/conversation');
const kommo = require('./client');
const config = require('../config');
const logger = require('../utils/logger');

// Fila com concorrência 2 para não sobrecarregar APIs
const queue = new PQueue({ concurrency: 2, interval: 1000, intervalCap: 3 });

// Debounce: evita processar o mesmo lead múltiplas vezes em sequência rápida
const processingDebounce = new Map();
const DEBOUNCE_MS = 3000; // 3 segundos

/**
 * Entry point: recebe o body parseado do webhook Kommo e enfileira processamento.
 */
async function handleWebhook(body, headers) {
  logger.debug('Webhook recebido:', JSON.stringify(body).slice(0, 300));

  const events = extractEvents(body);

  if (events.length === 0) {
    logger.debug('Webhook sem eventos relevantes, ignorando');
    return { processed: 0 };
  }

  let enqueued = 0;
  for (const event of events) {
    const debounceKey = `${event.type}_${event.leadId}`;
    const lastProcessed = processingDebounce.get(debounceKey);

    if (lastProcessed && Date.now() - lastProcessed < DEBOUNCE_MS) {
      logger.debug(`Debounce ativo para lead ${event.leadId}, pulando`);
      continue;
    }

    processingDebounce.set(debounceKey, Date.now());

    queue.add(async () => {
      try {
        await dispatchEvent(event);
      } catch (err) {
        logger.error(`Erro ao processar evento ${event.type} lead ${event.leadId}:`, err.message);
      }
    });

    enqueued++;
  }

  return { enqueued, queue_size: queue.size };
}

/**
 * Extrai eventos relevantes do payload do webhook Kommo.
 * Kommo pode enviar múltiplos eventos por webhook (ex: add_note + leads.update).
 */
function extractEvents(body) {
  const events = [];

  // ── Formato: message.add (WhatsApp Lite / chat interno) ──────────────────
  if (body.message?.add) {
    for (const msg of body.message.add) {
      if (!msg.entity_id) continue;
      events.push({
        type: 'message',
        leadId: parseInt(msg.entity_id, 10),
        message: {
          id: msg.id,
          text: msg.text || msg.content || '',
          created_at: msg.created_at,
          author_id: msg.author_id || 0,
          direction: msg.author_id === 0 ? 'inbound' : 'outbound',
        },
      });
    }
  }

  // ── Formato: add_note (notas internas, WhatsApp via nota) ────────────────
  if (body.add_note) {
    for (const note of body.add_note) {
      if (!note.element_id) continue;
      // Só processa notas de entrada do cliente (note_type 103 = WhatsApp, 25 = mensagem)
      const clientNoteTypes = [103, 25, 1];
      if (!clientNoteTypes.includes(note.note_type)) continue;

      events.push({
        type: 'message',
        leadId: parseInt(note.element_id, 10),
        message: {
          id: note.id,
          text: note.text || note.params?.text || '',
          created_at: note.created_at,
          direction: 'inbound',
        },
      });
    }
  }

  // ── Formato: leads.unsorted.add (nova conversa WhatsApp — lead novo) ─────
  if (body.leads?.unsorted?.add) {
    for (const unsorted of body.leads.unsorted.add) {
      events.push({
        type: 'unsorted',
        uid: unsorted.uid,
        pipelineId: unsorted.pipeline_id,
        unsortedData: unsorted,
      });
    }
  }

  // ── Formato: leads.add (novo lead criado) ────────────────────────────────
  if (body.leads?.add) {
    for (const lead of body.leads.add) {
      events.push({
        type: 'new_lead',
        leadId: parseInt(lead.id, 10),
      });
    }
  }

  // ── Formato: contacts.add (novo contato — possivelmente com lead) ────────
  if (body.contacts?.add) {
    // Contatos novos geralmente têm lead associado — será tratado no leads.add
  }

  return events;
}

/**
 * Despacha o evento para o processador correto.
 */
async function dispatchEvent(event) {
  switch (event.type) {
    case 'message':
      logger.info(`Processando mensagem — lead ${event.leadId}`);
      await processNewMessage(event);
      break;

    case 'new_lead':
      logger.info(`Processando novo lead ${event.leadId}`);
      await processNewLead(event.leadId);
      break;

    case 'unsorted':
      logger.info(`Processando lead não classificado uid=${event.uid}`);
      await handleUnsortedLead(event);
      break;

    default:
      logger.debug(`Evento não tratado: ${event.type}`);
  }
}

/**
 * Lida com leads "unsorted" do WhatsApp Lite.
 * Aceita o lead no pipeline e analisa a primeira mensagem.
 */
async function handleUnsortedLead(event) {
  const { uid, pipelineId, unsortedData } = event;

  try {
    // Obtém o primeiro pipeline disponível se não especificado
    let targetPipelineId = pipelineId;
    let targetStatusId;

    if (!targetPipelineId) {
      const pipelines = await kommo.getPipelines();
      const mainPipeline = pipelines.find((p) => p.is_main) || pipelines[0];
      targetPipelineId = mainPipeline?.id;
    }

    if (targetPipelineId) {
      const statuses = await kommo.getPipelineStatuses(targetPipelineId);
      // Pega a primeira etapa normal (não ganho/perdido)
      const firstStatus = statuses
        .filter((s) => s.type === 0)
        .sort((a, b) => a.sort - b.sort)[0];
      targetStatusId = firstStatus?.id;
    }

    // Aceita o lead no pipeline
    const result = await kommo.acceptUnsorted(uid, targetPipelineId, targetStatusId);
    logger.info(`Lead unsorted ${uid} aceito no pipeline ${targetPipelineId}`);

    // Analisa a primeira mensagem
    const newLeadId = result?._embedded?.leads?.[0]?.id;
    if (newLeadId) {
      // Pequeno delay para o Kommo processar o lead
      await new Promise((r) => setTimeout(r, 2000));
      await processNewLead(parseInt(newLeadId, 10));
    }
  } catch (err) {
    logger.error(`Falha ao processar unsorted ${uid}:`, err.message);
  }
}

/**
 * Retorna estatísticas da fila de processamento.
 */
function getQueueStats() {
  return {
    size: queue.size,
    pending: queue.pending,
    concurrency: queue.concurrency,
  };
}

module.exports = { handleWebhook, getQueueStats };
