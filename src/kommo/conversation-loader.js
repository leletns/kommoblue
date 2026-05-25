'use strict';

/**
 * Carrega TODO o histórico de conversa de um lead:
 *   - Mensagens do WhatsApp Lite (via Talks)
 *   - Notas do lead (comentários, SMS, chamadas, etc.)
 *   - Eventos de mudança de pipeline
 *
 * Retorna um array ordenado por timestamp para o agente IA.
 */

const kommo = require('./client');
const config = require('../config');
const logger = require('../utils/logger');

const NOTE_TYPE_LABELS = {
  1: 'comum',
  2: 'chamada_recebida',
  3: 'chamada_realizada',
  4: 'lead_criado',
  25: 'mensagem_enviada',
  102: 'sms_enviado',
  103: 'whatsapp',
  10: 'arquivo',
  11: 'arquivo',
};

/**
 * Carrega o contexto completo da conversa de um lead.
 * @param {number} leadId
 * @returns {{ lead, contact, pipeline, messages: Array, summary: string }}
 */
async function loadConversationContext(leadId) {
  logger.info(`Carregando contexto completo do lead ${leadId}...`);

  // Busca paralela para economizar tempo
  const [lead, notes, talks] = await Promise.all([
    kommo.getLead(leadId, { with: 'contacts,pipeline,loss_reason' }),
    kommo.getLeadNotes(leadId),
    kommo.getTalksByLead(leadId).catch(() => []),
  ]);

  // Busca mensagens das talks em paralelo
  const talkMessages = [];
  if (talks.length > 0) {
    const allTalkMsgs = await Promise.all(
      talks.map((t) => kommo.getTalkMessages(t.id))
    );
    allTalkMsgs.forEach((msgs) => talkMessages.push(...msgs));
  }

  // Busca contato principal
  let contact = null;
  const contactId = lead._embedded?.contacts?.[0]?.id;
  if (contactId) {
    contact = await kommo.getContact(contactId).catch(() => null);
  }

  // Normaliza notas em mensagens
  const normalizedNotes = notes.map((note) => ({
    id: `note_${note.id}`,
    timestamp: note.created_at,
    direction: note.created_by === 0 ? 'inbound' : 'outbound',
    author: note.created_by === 0 ? 'cliente' : `agente_${note.created_by}`,
    type: NOTE_TYPE_LABELS[note.note_type] || `nota_${note.note_type}`,
    text: extractNoteText(note),
  }));

  // Normaliza mensagens das talks
  const normalizedTalkMsgs = talkMessages.map((msg) => ({
    id: `msg_${msg.id}`,
    timestamp: msg.created_at,
    direction: msg.author?.type === 'contact' ? 'inbound' : 'outbound',
    author: msg.author?.type === 'contact' ? 'cliente' : 'atendente',
    type: 'whatsapp',
    text: msg.content?.text || msg.content?.media?.name || '[mídia]',
    media_type: msg.content?.type,
  }));

  // Combina e ordena por timestamp
  const allMessages = [...normalizedNotes, ...normalizedTalkMsgs]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-config.agent.maxContextMessages); // Limita ao máximo configurado

  // Monta resumo do lead
  const pipelineInfo = lead._embedded?.pipeline;
  const statusName = lead._embedded?.status?.name || `status_${lead.status_id}`;

  const summary = {
    lead_id: lead.id,
    lead_name: lead.name,
    lead_value: lead.price,
    pipeline_id: lead.pipeline_id,
    pipeline_name: pipelineInfo?.name,
    current_status_id: lead.status_id,
    current_status_name: statusName,
    responsible_user_id: lead.responsible_user_id,
    contact_name: contact?.name,
    contact_phone: extractPhone(contact),
    contact_email: extractEmail(contact),
    created_at: lead.created_at,
    updated_at: lead.updated_at,
    total_messages: allMessages.length,
    tags: lead._embedded?.tags?.map((t) => t.name) || [],
  };

  logger.info(
    `Contexto carregado: ${allMessages.length} msgs, pipeline "${summary.pipeline_name}", etapa "${summary.current_status_name}"`
  );

  return { lead, contact, summary, messages: allMessages };
}

function extractNoteText(note) {
  if (note.params?.text) return note.params.text;
  if (note.params?.phone) return `[Chamada] ${note.params.phone} — ${note.params.duration || 0}s`;
  if (note.text) return note.text;
  return JSON.stringify(note.params || {});
}

function extractPhone(contact) {
  if (!contact) return null;
  const phones = contact.custom_fields_values?.find(
    (f) => f.field_code === 'PHONE'
  );
  return phones?.values?.[0]?.value || null;
}

function extractEmail(contact) {
  if (!contact) return null;
  const emails = contact.custom_fields_values?.find(
    (f) => f.field_code === 'EMAIL'
  );
  return emails?.values?.[0]?.value || null;
}

module.exports = { loadConversationContext };
