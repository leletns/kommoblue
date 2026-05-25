'use strict';

/**
 * Orquestrador principal: webhook → contexto → IA → aplica decisão completa
 *
 * O agente agora faz TUDO automaticamente:
 *   1. Carrega histórico completo + UTMs + campos customizados
 *   2. IA analisa, qualifica e extrai dados da conversa
 *   3. Atualiza: pipeline + nome do lead/contato + score + nota + tags
 */

const kommo = require('../kommo/client');
const { loadConversationContext } = require('../kommo/conversation-loader');
const { analyzeConversation } = require('../ai/agent');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Processa uma nova mensagem recebida de um lead.
 */
async function processNewMessage(event) {
  const { leadId, message } = event;

  logger.info(`[Processor] Processando mensagem do lead ${leadId}`);

  // 1. Carrega contexto completo (histórico + UTMs + campos)
  let context;
  try {
    context = await loadConversationContext(leadId);
  } catch (err) {
    logger.error(`[Processor] Falha ao carregar contexto do lead ${leadId}:`, err.message);
    return { success: false, error: err.message };
  }

  const newMessage = message
    ? {
        text: message.text || message.content || '',
        timestamp: message.created_at || Math.floor(Date.now() / 1000),
        direction: 'inbound',
      }
    : null;

  // 2. Analisa com IA (persona + qualificação + extração de dados)
  let decision;
  try {
    decision = await analyzeConversation({ ...context, newMessage });
  } catch (err) {
    logger.error(`[Processor] Falha na análise IA do lead ${leadId}:`, err.message);
    return { success: false, error: err.message };
  }

  // 3. Aplica decisão completa no Kommo
  const actions = await applyDecision(leadId, decision, context.summary, context.contact);

  return {
    success: true,
    lead_id: leadId,
    decision,
    actions_taken: actions,
  };
}

/**
 * Processa um lead recém-criado.
 */
async function processNewLead(leadId) {
  logger.info(`[Processor] Analisando novo lead ${leadId}`);
  return processNewMessage({ leadId, message: null });
}

/**
 * Aplica TODAS as decisões da IA no Kommo.
 */
async function applyDecision(leadId, decision, summary, contact) {
  const actions = [];

  // ── 1. Mover pipeline ─────────────────────────────────────────────────────
  if (
    decision.move_to_status_id &&
    decision.move_to_status_id !== summary.current_status_id
  ) {
    try {
      const leadUpdate = { status_id: decision.move_to_status_id, pipeline_id: summary.pipeline_id };

      // Atualiza valor do lead se IA estimou
      if (decision.update_lead_value && decision.update_lead_value > 0) {
        leadUpdate.price = decision.update_lead_value;
      }

      // Atualiza nome do lead se IA extraiu da conversa
      if (decision.update_lead_name && !summary.lead_name) {
        leadUpdate.name = decision.update_lead_name;
      }

      await kommo.updateLead(leadId, leadUpdate);
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
  } else {
    // Sem mudança de etapa, mas pode ter atualização de nome/valor
    const leadUpdate = {};

    if (decision.update_lead_name && !summary.lead_name) {
      leadUpdate.name = decision.update_lead_name;
    }
    if (decision.update_lead_value && decision.update_lead_value > 0 && !summary.lead_value) {
      leadUpdate.price = decision.update_lead_value;
    }

    if (Object.keys(leadUpdate).length > 0) {
      try {
        await kommo.updateLead(leadId, leadUpdate);
        actions.push({ type: 'lead_enriched', fields: Object.keys(leadUpdate) });
      } catch (err) {
        logger.error(`[Processor] Falha ao enriquecer lead ${leadId}:`, err.message);
      }
    }
  }

  // ── 2. Atualizar contato (nome, telefone, e-mail extraídos da conversa) ───
  const contactUpdate = decision.update_contact;
  if (contactUpdate && summary.contact_id) {
    const fieldsToUpdate = [];

    // Atualiza nome apenas se o contato não tem nome ainda
    if (contactUpdate.name && (!summary.contact_name || summary.contact_name.startsWith('Contato'))) {
      fieldsToUpdate.push({ type: 'name', value: contactUpdate.name });
    }

    // Atualiza telefone apenas se não tinha
    if (contactUpdate.phone && !summary.contact_phone) {
      fieldsToUpdate.push({ type: 'phone', value: contactUpdate.phone });
    }

    // Atualiza e-mail apenas se não tinha
    if (contactUpdate.email && !summary.contact_email) {
      fieldsToUpdate.push({ type: 'email', value: contactUpdate.email });
    }

    if (fieldsToUpdate.length > 0) {
      try {
        await kommo.updateContact(summary.contact_id, contactUpdate);
        logger.info(
          `[Processor] Contato ${summary.contact_id} atualizado: ${fieldsToUpdate.map((f) => f.type).join(', ')}`
        );
        actions.push({ type: 'contact_enriched', fields: fieldsToUpdate.map((f) => f.type) });
      } catch (err) {
        logger.error(`[Processor] Falha ao atualizar contato:`, err.message);
      }
    }
  }

  // ── 3. Atualizar campos customizados de qualificação no lead ──────────────
  if (decision.qualification) {
    try {
      await updateQualificationFields(leadId, decision.qualification, decision.persona, summary, decision);
      actions.push({ type: 'qualification_saved', score: decision.qualification.score });
    } catch (err) {
      logger.error(`[Processor] Falha ao salvar qualificação:`, err.message);
    }
  }

  // ── 4. Adicionar tags ─────────────────────────────────────────────────────
  const allTags = buildTags(decision, summary);
  if (allTags.length > 0) {
    try {
      await kommo.addTagsToLead(leadId, allTags);
      logger.info(`[Processor] Tags adicionadas ao lead ${leadId}: ${allTags.join(', ')}`);
      actions.push({ type: 'tags_added', tags: allTags });
    } catch (err) {
      logger.error(`[Processor] Falha ao adicionar tags:`, err.message);
    }
  }

  // ── 5. Adicionar nota de qualificação ─────────────────────────────────────
  if (decision.note_to_add) {
    const noteText = buildNoteText(decision);
    try {
      await kommo.addLeadNote(leadId, { text: noteText });
      logger.info(`[Processor] Nota adicionada ao lead ${leadId}`);
      actions.push({ type: 'note_added' });
    } catch (err) {
      logger.error(`[Processor] Falha ao adicionar nota:`, err.message);
    }
  }

  // ── 6. Resposta automática ────────────────────────────────────────────────
  if (config.agent.autoReply && decision.reply_message && !config.agent.replyRequiresApproval) {
    logger.info(`[Processor] Resposta automática lead ${leadId}: "${decision.reply_message}"`);
    actions.push({ type: 'auto_reply_queued', message: decision.reply_message });
  }

  return actions;
}

/**
 * Atualiza campos customizados de qualificação no lead.
 * Usa os field_codes padrão — ajuste conforme seus campos no Kommo.
 */
async function updateQualificationFields(leadId, qualification, persona, summary, decision) {
  // Monta campos customizados para atualizar
  // Os field_codes abaixo devem existir no seu Kommo.
  // Se não existirem, o Kommo ignora silenciosamente.
  const customFieldsValues = [];

  // Score de qualificação (campo texto ou numérico)
  if (qualification.score !== undefined) {
    customFieldsValues.push({
      field_code: 'QUALIFICATION_SCORE',
      values: [{ value: String(qualification.score) }],
    });
  }

  // Perfil da persona
  if (persona?.profile_type) {
    customFieldsValues.push({
      field_code: 'PERSONA_PROFILE',
      values: [{ value: persona.profile_type }],
    });
  }

  // BANT — Budget
  if (qualification.bant?.budget) {
    customFieldsValues.push({
      field_code: 'BANT_BUDGET',
      values: [{ value: qualification.bant.budget }],
    });
  }

  // BANT — Authority
  if (qualification.bant?.authority) {
    customFieldsValues.push({
      field_code: 'BANT_AUTHORITY',
      values: [{ value: qualification.bant.authority }],
    });
  }

  // BANT — Need
  if (qualification.bant?.need) {
    customFieldsValues.push({
      field_code: 'BANT_NEED',
      values: [{ value: qualification.bant.need }],
    });
  }

  // BANT — Timeline
  if (qualification.bant?.timeline) {
    customFieldsValues.push({
      field_code: 'BANT_TIMELINE',
      values: [{ value: qualification.bant.timeline }],
    });
  }

  // Budget estimado em valor
  if (qualification.bant?.budget_value) {
    customFieldsValues.push({
      field_code: 'BUDGET_ESTIMATED',
      values: [{ value: qualification.bant.budget_value }],
    });
  }

  // Temperatura
  if (decision.temperature) {
    customFieldsValues.push({
      field_code: 'LEAD_TEMPERATURE',
      values: [{ value: decision.temperature }],
    });
  }

  // Especialidade/assunto
  if (decision.subject_specialist) {
    customFieldsValues.push({
      field_code: 'SUBJECT_SPECIALIST',
      values: [{ value: decision.subject_specialist }],
    });
  }

  // Origem do tráfego
  const trafficSrc = decision.traffic_source_type || classifyUtmSource(summary?.utms);
  if (trafficSrc) {
    customFieldsValues.push({
      field_code: 'TRAFFIC_SOURCE_TYPE',
      values: [{ value: trafficSrc }],
    });
  }

  if (customFieldsValues.length === 0) return;

  await kommo.updateLeadCustomFields(leadId, customFieldsValues);
  logger.info(`[Processor] Campos de qualificação atualizados no lead ${leadId}`);
}

/**
 * Monta tags automáticas com base na qualificação, persona e origem.
 */
function buildTags(decision, summary) {
  const tags = [...(decision.tags_to_add || [])];

  // Temperatura
  if (decision.temperature) tags.push(`temp-${decision.temperature}`);

  // Score de qualificação
  const scoreLabel = decision.qualification?.score_label;
  if (scoreLabel) tags.push(`ia-${scoreLabel}`);

  // Urgência
  if (decision.urgency === 'alta') tags.push('urgente');
  if (decision.urgency === 'critica') tags.push('critico');

  // Intenção
  if (decision.client_intent === 'comprar') tags.push('pronto-comprar');
  if (decision.client_intent === 'desistir') tags.push('desistencia');

  // Especialidade/assunto
  if (decision.subject_specialist) {
    const subjectTag = decision.subject_specialist
      .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 30);
    if (subjectTag) tags.push(`assunto-${subjectTag}`);
  }

  // Origem do tráfego (da IA ou dos UTMs)
  const src = decision.traffic_source_type || classifyUtmSource(summary?.utms);
  if (src === 'pago') tags.push('trafego-pago');
  else if (src === 'organico') tags.push('trafego-organico');
  else if (src === 'indicacao') tags.push('indicacao');

  return [...new Set(tags)];
}

function classifyUtmSource(utms) {
  if (!utms) return 'desconhecido';
  const source = (utms.source || '').toLowerCase();
  const medium = (utms.medium || '').toLowerCase();
  const paidSources = ['google', 'facebook', 'instagram', 'meta', 'youtube', 'tiktok'];
  const paidMediums = ['cpc', 'cpm', 'paid', 'pago', 'ads'];
  if (paidSources.some((s) => source.includes(s)) && paidMediums.some((m) => medium.includes(m))) return 'pago';
  if (['organic', 'seo', 'organico'].some((m) => medium.includes(m))) return 'organico';
  if (['referral', 'indicacao', 'indicação'].some((s) => source.includes(s) || medium.includes(s))) return 'indicacao';
  return 'desconhecido';
}

/**
 * Formata a nota completa de qualificação para o lead.
 */
function buildNoteText(decision) {
  const emoji = {
    positivo: '😊',
    muito_positivo: '🎉',
    neutro: '😐',
    negativo: '😟',
    muito_negativo: '😡',
  }[decision.sentiment] || '📝';

  const urgencyPrefix = {
    alta: '⚠️ URGENTE — ',
    critica: '🚨 CRÍTICO — ',
  }[decision.urgency] || '';

  const score = decision.qualification?.score;
  const scoreBar = score !== undefined ? ` | Score: ${score}/100 (${decision.qualification?.score_label})` : '';

  let note = `${emoji} [IA]${scoreBar} ${urgencyPrefix}${decision.note_to_add}`;

  // Dados extraídos da conversa
  const persona = decision.persona;
  if (persona) {
    const extracted = [];
    if (persona.extracted_name) extracted.push(`Nome: ${persona.extracted_name}`);
    if (persona.extracted_phone) extracted.push(`Tel: ${persona.extracted_phone}`);
    if (persona.extracted_email) extracted.push(`Email: ${persona.extracted_email}`);
    if (persona.extracted_company) extracted.push(`Empresa: ${persona.extracted_company}`);
    if (persona.extracted_role) extracted.push(`Cargo: ${persona.extracted_role}`);
    if (extracted.length > 0) {
      note += `\n👤 Dados extraídos: ${extracted.join(' | ')}`;
    }

    if (persona.profile_type) note += `\n🧩 Perfil: ${persona.profile_type}`;
    if (persona.pain_points?.length > 0) {
      note += `\n❗ Dores: ${persona.pain_points.join(', ')}`;
    }
  }

  // BANT
  const bant = decision.qualification?.bant;
  if (bant) {
    const bantParts = [];
    if (bant.budget) bantParts.push(`Budget: ${bant.budget}${bant.budget_value ? ` (${bant.budget_value})` : ''}`);
    if (bant.authority) bantParts.push(`Autoridade: ${bant.authority}`);
    if (bant.need) bantParts.push(`Necessidade: ${bant.need}`);
    if (bant.timeline) bantParts.push(`Prazo: ${bant.timeline}`);
    if (bantParts.length > 0) {
      note += `\n📊 BANT: ${bantParts.join(' | ')}`;
    }
  }

  if (decision.move_reason) note += `\n📍 Mudança: ${decision.move_reason}`;
  if (decision.suggested_action) note += `\n💡 Próximo passo: ${decision.suggested_action}`;

  return note.slice(0, 1500); // Limite Kommo
}

module.exports = { processNewMessage, processNewLead };
