'use strict';

/**
 * Agente IA do Kommo — usa Claude (Anthropic) para analisar conversas
 * e decidir ações de pipeline automaticamente.
 *
 * Features:
 *   - Prompt caching (economiza tokens no system prompt estático)
 *   - Análise completa de histórico de conversa
 *   - Decisão estruturada em JSON
 *   - Fallback seguro em caso de erro
 */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { buildSystemPrompt, buildUserPrompt } = require('./prompts');
const logger = require('../utils/logger');

let anthropicClient = null;

function getClient() {
  if (!anthropicClient) {
    if (!config.anthropic.apiKey) {
      throw new Error('ANTHROPIC_API_KEY não configurada. Verifique o arquivo .env');
    }
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return anthropicClient;
}

// Cache dos pipelines para evitar fetch repetido no system prompt
let cachedPipelines = null;
let pipelinesLastFetch = 0;
const PIPELINE_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function getPipelines() {
  if (cachedPipelines && Date.now() - pipelinesLastFetch < PIPELINE_CACHE_TTL) {
    return cachedPipelines;
  }

  const kommo = require('../kommo/client');
  cachedPipelines = await kommo.getPipelinesWithStatuses();
  pipelinesLastFetch = Date.now();
  return cachedPipelines;
}

/**
 * Analisa uma conversa e retorna decisão estruturada de pipeline.
 *
 * @param {{ summary, messages, newMessage? }} context - Contexto da conversa
 * @returns {AgentDecision} - Decisão estruturada do agente
 */
async function analyzeConversation(context, { modelOverride } = {}) {
  const client = getClient();
  const pipelines = await getPipelines();

  const systemPrompt = buildSystemPrompt(pipelines);
  const userPrompt = buildUserPrompt(context);

  // Usa modelo configurado, mas permite override (ex: Haiku para bulk scan)
  const model = modelOverride || config.anthropic.model;

  logger.info(
    `Analisando lead ${context.summary.lead_id} (${context.messages.length} msgs) com ${model}...`
  );

  const startTime = Date.now();

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1500,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          // Ativa prompt caching — o system prompt muda apenas quando os pipelines mudam
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    const elapsed = Date.now() - startTime;
    const usage = response.usage;

    logger.info(
      `IA respondeu em ${elapsed}ms | tokens: ${usage.input_tokens} in / ${usage.output_tokens} out` +
        (usage.cache_read_input_tokens
          ? ` / ${usage.cache_read_input_tokens} cached`
          : '')
    );

    const rawText = response.content[0]?.text || '';
    const decision = parseDecision(rawText, context.summary);

    logger.info(
      `Decisão IA — lead ${context.summary.lead_id}: ` +
        `sentimento="${decision.sentiment}", ` +
        `intenção="${decision.client_intent}", ` +
        `mover_para="${decision.move_to_status_name || 'manter'}", ` +
        `urgência="${decision.urgency}"`
    );

    return decision;
  } catch (err) {
    logger.error(`Erro na análise IA do lead ${context.summary.lead_id}:`, err.message);

    // Retorno seguro em caso de falha — não altera nada
    return {
      analysis: `Erro na análise automática: ${err.message}`,
      sentiment: 'neutro',
      client_intent: 'outro',
      move_to_status_id: null,
      move_to_status_name: null,
      move_reason: null,
      note_to_add: `⚠️ Agente IA falhou ao analisar: ${err.message}`,
      tags_to_add: ['erro-ia'],
      urgency: 'media',
      suggested_action: 'Revisar manualmente',
      reply_message: null,
      _error: true,
    };
  }
}

/**
 * Extrai e valida o JSON de decisão da resposta do modelo.
 */
function parseDecision(rawText, summary) {
  // Extrai bloco JSON mesmo que tenha texto ao redor
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn('IA não retornou JSON válido. Resposta bruta:', rawText.slice(0, 200));
    return buildSafeDecision(summary, 'Resposta inválida da IA');
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Garante todos os campos incluindo qualificação, persona e tarefa
    return {
      analysis: parsed.analysis || '',
      persona: parsed.persona || null,
      qualification: parsed.qualification || null,
      temperature: parsed.temperature || null,
      subject_specialist: parsed.subject_specialist || null,
      traffic_source_type: parsed.traffic_source_type || null,
      client_state: parsed.client_state || null,
      client_language: parsed.client_language || 'pt-BR',
      specialist_indicated: parsed.specialist_indicated || null,
      service_value: parsed.service_value || null,
      is_ghosting: parsed.is_ghosting || false,
      sentiment: parsed.sentiment || 'neutro',
      client_intent: parsed.client_intent || 'outro',
      move_to_status_id: parsed.move_to_status_id || null,
      move_to_status_name: parsed.move_to_status_name || null,
      move_reason: parsed.move_reason || null,
      update_lead_name: parsed.update_lead_name || null,
      update_lead_value: parsed.update_lead_value || null,
      update_contact: parsed.update_contact || null,
      note_to_add: parsed.note_to_add || null,
      tags_to_add: Array.isArray(parsed.tags_to_add) ? parsed.tags_to_add : [],
      urgency: parsed.urgency || 'media',
      suggested_action: parsed.suggested_action || '',
      reply_message: parsed.reply_message || null,
      draft_message: parsed.draft_message || null,
      task_to_create: parsed.task_to_create || null,
      appointment: parsed.appointment || null,
    };
  } catch (err) {
    logger.error('Falha ao parsear JSON da IA:', err.message);
    return buildSafeDecision(summary, 'JSON inválido na resposta da IA');
  }
}

function buildSafeDecision(summary, reason) {
  return {
    analysis: reason,
    sentiment: 'neutro',
    client_intent: 'outro',
    move_to_status_id: null,
    move_to_status_name: null,
    move_reason: null,
    note_to_add: `⚠️ ${reason}`,
    tags_to_add: [],
    urgency: 'media',
    suggested_action: 'Revisar manualmente',
    reply_message: null,
    _error: true,
  };
}

module.exports = { analyzeConversation };
