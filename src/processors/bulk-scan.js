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
const { resolveTaskDueDate } = require('../utils/date-parser');
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

/**
 * Detecta se uma nota é do NOSSO PRÓPRIO agente — deve ser ignorada para evitar
 * análise circular. NÃO filtra notas de outras integrações (Growth Blue OS, etc.)
 * pois essas contêm contexto real da conversa que o nosso agente pode usar.
 */
function isOurOwnNote(note) {
  const text = (note.params?.text || note.text || '').toLowerCase();
  return (
    text.startsWith('[ia - varredura]') ||
    text.startsWith('[ia]') ||
    text.includes('kommo blue') ||
    text.includes('agente ia —') ||
    // Notas geradas por nós na varredura anterior
    text.includes('ia - varredura') ||
    text.includes('consulta ganha detectada automaticamente')
  );
}

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
async function startBulkScan({ onlyActive = false, delayMs = 6000, recentDays = 0 } = {}) {
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

  runScan({ onlyActive, delayMs, recentDays }).catch((err) => {
    logger.error('[BulkScan] Erro fatal:', err.message);
    addLog('error', `Erro fatal: ${err.message}`);
    scanState.running = false;
    scanState.finishedAt = new Date().toISOString();
  });

  return { started: true, message: 'Varredura iniciada em background' };
}

async function runScan({ onlyActive, delayMs, recentDays }) {
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

    // 2. Busca talks recentes → mapeia leadId → [talkIds] com mensagens reais
    //    (com token de longa duração pode ter acesso agora)
    const recentTalksMap = {}; // leadId → [talkId, ...]
    if (recentDays > 0) {
      const fromTs = Math.floor(Date.now() / 1000) - recentDays * 86400;
      addLog('info', `Buscando talks dos últimos ${recentDays} dias...`);
      try {
        const recentTalks = await kommo.fetchAllPages('/talks', {
          'filter[updated_at][from]': fromTs,
        });
        for (const talk of recentTalks) {
          const lid = String(talk.entity_id || talk.element_id || '');
          if (lid) {
            if (!recentTalksMap[lid]) recentTalksMap[lid] = [];
            recentTalksMap[lid].push(talk.id);
          }
        }
        addLog('info', `${recentTalks.length} talks recentes → ${Object.keys(recentTalksMap).length} leads com atividade WhatsApp`);
      } catch (err) {
        addLog('info', `Talks recentes: ${err.message} — seguindo sem filtro de talks`);
      }
    }

    // 3. Busca leads JÁ ENRIQUECIDOS na lista (evita GET /leads/{id} individual)
    addLog('info', recentDays > 0
      ? `Buscando leads ativos dos últimos ${recentDays} dias...`
      : 'Buscando leads com dados enriquecidos...'
    );
    let allLeads;
    try {
      const params = { with: 'contacts,tags,custom_fields_values' };
      // Filtro por data de atualização (últimos N dias)
      if (recentDays > 0) {
        const fromTs = Math.floor(Date.now() / 1000) - recentDays * 86400;
        params['filter[updated_at][from]'] = fromTs;
      }
      allLeads = await kommo.fetchAllPages('/leads', params);
    } catch (err) {
      addLog('error', `ERRO ao buscar leads: ${err.message}`);
      throw err;
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
          await processLeadScan(lead, wonStatusMap, lostStatusMap, pipelines, recentTalksMap);
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

      // Pausa normal entre leads
      await sleep(delayMs);

      // A cada 50 leads: pausa de 30s para respeitar rate limit da Kommo
      if (scanState.processed > 0 && scanState.processed % 50 === 0) {
        addLog('info', `⏸ Pausa de 30s após ${scanState.processed} leads (proteção rate limit)...`);
        await sleep(30000);
      }
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
async function processLeadScan(lead, wonStatusMap, lostStatusMap, pipelines, recentTalksMap = {}) {
  const leadId = lead.id;

  // ── Pula leads GANHOS e PERDIDOS — só ativos ──────────────────────────────
  const wonStatus = wonStatusMap[lead.pipeline_id];
  const lostStatus = lostStatusMap[lead.pipeline_id];
  if (lead.status_id === wonStatus?.id) {
    scanState.skipped++;
    addLog('skip', `Lead ${leadId} (${lead.name || 'sem nome'}): já GANHO — pulando`);
    return;
  }
  if (lead.status_id === lostStatus?.id) {
    scanState.skipped++;
    addLog('skip', `Lead ${leadId} (${lead.name || 'sem nome'}): PERDIDO — pulando`);
    return;
  }

  // Busca notas (opcional — silencia 403)
  let notes = [];
  try {
    notes = await kommo.getLeadNotes(leadId);
  } catch (err) {
    if (err.response?.status !== 403) throw err;
    logger.warn(`[BulkScan] Lead ${leadId}: sem acesso a notas (403), continuando`);
  }

  // Busca mensagens das talks — tenta 3 fontes em ordem
  let talkMessages = [];
  const talkIdsSeen = new Set();

  // 1) Talk IDs conhecidos do mapa de talks recentes
  const knownTalkIds = recentTalksMap[String(leadId)] || [];
  for (const talkId of knownTalkIds) {
    if (!talkIdsSeen.has(talkId)) {
      talkIdsSeen.add(talkId);
      const msgs = await kommo.getTalkMessages(talkId);
      talkMessages.push(...msgs);
    }
  }

  // 2) Busca via filter[entity_id] (complementa)
  if (talkMessages.length === 0) {
    try {
      const talks = await kommo.getTalksByLead(leadId);
      const newTalks = talks.filter((t) => !talkIdsSeen.has(t.id));
      for (const talk of newTalks) {
        talkIdsSeen.add(talk.id);
        const msgs = await kommo.getTalkMessages(talk.id);
        talkMessages.push(...msgs);
      }
    } catch (err) {
      logger.warn(`[BulkScan] Lead ${leadId}: erro ao buscar talks (${err.response?.status})`);
    }
  }

  // Normaliza notas — remove APENAS as nossas próprias notas de varredura
  // (para evitar análise circular). Mantém Growth Blue OS e outras integrações
  // pois contêm contexto real da conversa que o Claude pode usar.
  const normalizedNotes = notes
    .filter((n) => !isOurOwnNote(n))          // remove SOMENTE nossas notas [IA - Varredura]
    .filter((n) => n.params?.text || n.text)  // deve ter texto real
    .map((n) => ({
      id: `note_${n.id}`,
      timestamp: n.created_at,
      // WhatsApp inbound = note_type 103 ou created_by=0 (sistema)
      direction: (n.note_type === 103 || n.created_by === 0) ? 'inbound' : 'outbound',
      text: n.params?.text || n.text || '',
      type: n.note_type === 103 ? 'whatsapp' : n.note_type === 25 ? 'whatsapp' : 'nota',
      note_type: n.note_type,
    }));

  // Normaliza msgs WhatsApp
  const normalizedTalkMsgs = talkMessages.map((msg) => ({
    id: `msg_${msg.id}`,
    timestamp: msg.created_at,
    direction: msg.author?.type === 'contact' ? 'inbound' : 'outbound',
    text: msg.content?.text || msg.content?.media?.name || '[mídia]',
    type: 'whatsapp',
  }));

  // Log diagnóstico: mostra o que veio da API antes e depois do filtro
  const rawNoteTypes = [...new Set(notes.map((n) => n.note_type))].join(',') || 'nenhum';
  const filteredBotCount = notes.filter((n) => isOurOwnNote(n)).length;
  const noTextCount = notes.filter((n) => !isOurOwnNote(n) && !n.params?.text && !n.text).length;
  logger.info(
    `[BulkScan] Lead ${leadId}: ${notes.length} notas (tipos: ${rawNoteTypes}), ` +
    `${filteredBotCount} bot-filtradas, ${noTextCount} sem texto, ` +
    `${talkMessages.length} msgs talks`
  );

  const seen = new Set();
  const messages = [...normalizedNotes, ...normalizedTalkMsgs]
    .filter((m) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; })
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-config.agent.maxContextMessages);

  // Se não há mensagens, não pular — processar com dados do CRM
  // (nome, pipeline, tags, custom fields, DDD do telefone)
  const hasConversation = messages.length > 0;
  if (!hasConversation) {
    const reason = notes.length === 0
      ? 'sem notas na API (WhatsApp Lite — 403)'
      : filteredBotCount === notes.length
      ? `${filteredBotCount} notas nossas filtradas`
      : 'notas sem texto';
    addLog('info', `Lead ${leadId} (${lead.name || 'sem nome'}): ${reason} — analisando só CRM`);
  }

  logger.info(`[BulkScan] Lead ${leadId}: ${messages.length} msgs (${normalizedNotes.length} notas + ${normalizedTalkMsgs.length} whatsapp)`);


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

  // Extrai telefone do contato (vem no embedded quando disponível)
  const embeddedContact = lead._embedded?.contacts?.[0];
  const contactPhone = extractContactPhone(embeddedContact);

  const summary = {
    lead_id: lead.id,
    lead_name: lead.name,
    lead_value: lead.price,
    pipeline_id: lead.pipeline_id,
    pipeline_name: pipeline?.name || `Pipeline ${lead.pipeline_id}`,
    current_status_id: lead.status_id,
    current_status_name: status?.name || `Status ${lead.status_id}`,
    contact_id: embeddedContact?.id || null,
    contact_name: embeddedContact?.name || null,
    contact_phone: contactPhone,
    contact_email: null,
    created_at: lead.created_at,
    total_messages: messages.length,
    has_conversation: hasConversation,
    tags,
    utms: extractUtms(lead),
    custom_fields: customFields,
    contact_custom_fields: [],
  };

  // IA analisa — usa Haiku para economizar custo no bulk scan (~$0.004/lead vs $0.08/lead no Opus)
  const bulkModel = process.env.BULK_SCAN_MODEL || 'claude-haiku-4-5-20251001';
  const decision = await analyzeConversation({ lead, contact: null, summary, messages, newMessage: null }, { modelOverride: bulkModel });

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

/**
 * Extrai telefone do contato embedded (quando disponível).
 * Kommo retorna custom_fields nos contatos embedded com with=contacts.
 */
function extractContactPhone(contact) {
  if (!contact) return null;
  // Tenta campos customizados do contato
  const fields = contact.custom_fields_values || [];
  for (const field of fields) {
    const code = (field.field_code || '').toUpperCase();
    if (code === 'PHONE' || code === 'PHONES') {
      return field.values?.[0]?.value || null;
    }
  }
  return null;
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

  // Nota rica e personalizada com perfil real da lead
  try {
    const note = buildRichNote(decision, summary);
    await kommo.addLeadNote(leadId, { text: note });
    actions.push({ type: 'note_added' });
  } catch (_) {}

  // Tags significativas — sem "ia-varrido"
  const tags = [];
  const score = decision.qualification?.score;
  const scoreLabel = decision.qualification?.score_label;
  if (scoreLabel) tags.push(`ia-${scoreLabel}`); // ia-quente, ia-morno, ia-frio
  if (decision.temperature) tags.push(decision.temperature); // quente, morno, frio
  if (decision.subject_specialist) {
    const subj = decision.subject_specialist.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 25);
    if (subj) tags.push(subj); // ex: lipo, botox, consulta-estetica
  }
  if (decision.client_intent === 'comprar') tags.push('pronto-comprar');
  if (decision.urgency === 'alta' || decision.urgency === 'critica') tags.push('urgente');
  if (decision.traffic_source_type === 'pago') tags.push('trafego-pago');
  else if (decision.traffic_source_type === 'organico') tags.push('trafego-organico');
  else if (decision.traffic_source_type === 'indicacao') tags.push('indicacao');

  try {
    await kommo.addTagsToLead(leadId, [...new Set(tags)]);
    actions.push({ type: 'tags_added', tags });
  } catch (_) {}

  // Task creation com data inteligente
  if (decision.task_to_create && decision.temperature !== 'frio' && decision.temperature !== 'desqualificado') {
    try {
      const taskTypeMap = { call: 1, meeting: 2, email: 3, followup: 1 };
      const dueTimestamp = resolveTaskDueDate(decision.task_to_create);

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

  // Salva rascunho de mensagem como nota
  if (decision.draft_message) {
    try {
      const draftNote = `✍️ [RASCUNHO IA]\n\n${decision.draft_message}`;
      await kommo.addLeadNote(leadId, { text: draftNote });
      actions.push({ type: 'draft_saved' });
    } catch (_) {}
  }

  return actions;
}

/**
 * Nota personalizada com perfil real da lead — não genérica.
 */
function buildRichNote(decision, summary) {
  const score = decision.qualification?.score;
  const scoreLabel = decision.qualification?.score_label || '';
  const temp = decision.temperature || '';
  const tempEmoji = { quente: '🔥', morno: '🌡️', frio: '❄️', desqualificado: '🚫' }[temp] || '📋';
  const sentEmoji = { muito_positivo: '😄', positivo: '😊', neutro: '😐', negativo: '😟', muito_negativo: '😡' }[decision.sentiment] || '📝';

  let note = `${tempEmoji} ${sentEmoji} Score: ${score ?? '?'}/100 (${scoreLabel}) | ${temp.toUpperCase()}\n`;

  // Análise da conversa
  if (decision.analysis) {
    note += `\n📋 ${decision.analysis}\n`;
  }

  // Perfil da persona
  const persona = decision.persona;
  if (persona) {
    const dados = [];
    if (persona.extracted_name) dados.push(`Nome: ${persona.extracted_name}`);
    if (persona.extracted_phone) dados.push(`Tel: ${persona.extracted_phone}`);
    if (persona.extracted_email) dados.push(`Email: ${persona.extracted_email}`);
    if (persona.extracted_company) dados.push(`Empresa: ${persona.extracted_company}`);
    if (dados.length > 0) note += `\n👤 ${dados.join(' | ')}\n`;
    if (persona.profile_type) note += `🧩 Perfil: ${persona.profile_type}\n`;
    if (persona.pain_points?.length > 0) note += `❗ Dores: ${persona.pain_points.join(', ')}\n`;
  }

  // Assunto / especialidade
  if (decision.subject_specialist) {
    note += `🏥 Interesse: ${decision.subject_specialist}\n`;
  }

  // BANT
  const bant = decision.qualification?.bant;
  if (bant) {
    const parts = [];
    if (bant.budget && bant.budget !== 'desconhecido') parts.push(`Budget: ${bant.budget}${bant.budget_value ? ` (${bant.budget_value})` : ''}`);
    if (bant.need && bant.need !== 'desconhecido') parts.push(`Necessidade: ${bant.need}`);
    if (bant.timeline && bant.timeline !== 'desconhecido') parts.push(`Prazo: ${bant.timeline}`);
    if (parts.length > 0) note += `📊 ${parts.join(' | ')}\n`;
  }

  // Agendamento detectado
  if (decision.appointment) {
    const appt = decision.appointment;
    note += `\n📅 CONSULTA MARCADA: ${appt.date || '?'}${appt.time ? ' às ' + appt.time : ''} — ${appt.procedure || 'procedimento'}\n`;
  }

  // Tarefa criada
  if (decision.task_to_create) {
    note += `\n✅ Tarefa: ${decision.task_to_create.text}\n`;
  }

  // Próximo passo
  if (decision.suggested_action) {
    note += `\n💡 ${decision.suggested_action}`;
  }

  return note.slice(0, 1400);
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
