'use strict';

/**
 * Construtores de prompts para o agente IA do Kommo.
 * O agente analisa conversas e toma decisões de pipeline.
 */

const config = require('../config');

const LANG = config.agent.language || 'pt-BR';

/**
 * Prompt de sistema — define o papel e as regras do agente.
 * Usa cache Anthropic para economizar tokens (estático).
 */
function buildSystemPrompt(pipelines) {
  const pipelineStr = JSON.stringify(pipelines, null, 2);

  return `Você é um agente de CRM especialista em vendas e atendimento, integrado ao Kommo CRM com WhatsApp.

Sua missão: analisar conversas de WhatsApp e decidir automaticamente como atualizar o pipeline de vendas.

## Idioma
Responda sempre em ${LANG}.

## Sua função
1. Ler TODO o histórico da conversa (mensagens antigas + nova mensagem)
2. Entender o contexto, intenção e estágio do cliente
3. Decidir qual etapa do pipeline o lead deve estar
4. Sugerir notas e ações relevantes

## Pipelines e Etapas disponíveis
${pipelineStr}

## Regras para mudança de etapa
- Mova o lead para a etapa mais adequada com base na conversa
- NÃO mova para etapas anteriores sem motivo forte
- Etapas com type=142 = GANHO (venda fechada) — use com cautela
- Etapas com type=143 = PERDIDO — use quando cliente claramente desistiu
- Se não tiver certeza, mantenha a etapa atual (retorne move_to_status_id: null)

## Critérios de análise
- **Interesse inicial**: cliente pedindo informações → etapa de qualificação
- **Proposta enviada**: preço discutido → etapa de negociação
- **Objeções**: cliente com dúvidas → etapa de acompanhamento
- **Decisão positiva**: "vou comprar", "pode fechar", "combinado" → etapa de fechamento/ganho
- **Recusa clara**: "não tenho interesse", "vai embora" → etapa perdido
- **Sem resposta/inativo**: manter etapa atual, adicionar nota

## Formato de resposta (JSON OBRIGATÓRIO)
Responda SOMENTE com JSON válido, sem texto adicional:

{
  "analysis": "Resumo da análise da conversa em 2-3 frases",
  "sentiment": "positivo | neutro | negativo | muito_positivo | muito_negativo",
  "client_intent": "comprar | informar | reclamar | desistir | negociar | aguardando | outro",
  "move_to_status_id": <number ou null>,
  "move_to_status_name": "<nome da etapa ou null>",
  "move_reason": "Motivo claro da mudança de etapa (ou null)",
  "note_to_add": "Nota resumida para o lead. Máx 300 chars. null se não necessário",
  "tags_to_add": ["tag1", "tag2"],
  "urgency": "baixa | media | alta | critica",
  "suggested_action": "Próximo passo sugerido para o atendente humano",
  "reply_message": null
}

${config.agent.autoReply ? `
## Resposta automática
Quando pertinente, preencha "reply_message" com uma resposta em português ao cliente.
Seja cordial, profissional e objetivo. Máx 160 chars para WhatsApp.
` : '## Resposta automática: DESABILITADA — reply_message deve ser sempre null'}`;
}

/**
 * Prompt de usuário — contexto específico do lead e mensagem atual.
 * Gerado dinamicamente a cada análise.
 */
function buildUserPrompt({ summary, messages, newMessage }) {
  const historyStr = messages
    .map((m) => {
      const dir = m.direction === 'inbound' ? '← CLIENTE' : '→ ATENDENTE';
      const time = new Date(m.timestamp * 1000).toLocaleString('pt-BR');
      const type = m.type !== 'whatsapp' && m.type !== 'comum' ? ` [${m.type}]` : '';
      return `[${time}] ${dir}${type}: ${m.text}`;
    })
    .join('\n');

  const newMsgStr = newMessage
    ? `\n\n## ⚡ NOVA MENSAGEM (gatilho desta análise)\n← CLIENTE: ${newMessage.text}`
    : '';

  return `## Informações do Lead
- **Nome**: ${summary.lead_name || 'Sem nome'}
- **Contato**: ${summary.contact_name || 'Desconhecido'} | Tel: ${summary.contact_phone || 'N/A'}
- **Pipeline atual**: ${summary.pipeline_name || `ID ${summary.pipeline_id}`}
- **Etapa atual**: ${summary.current_status_name || `ID ${summary.current_status_id}`}
- **Valor do lead**: R$ ${(summary.lead_value || 0).toLocaleString('pt-BR')}
- **Tags**: ${summary.tags.join(', ') || 'nenhuma'}
- **Total de mensagens no histórico**: ${summary.total_messages}

## Histórico completo da conversa
${historyStr || '(sem histórico anterior)'}
${newMsgStr}

Analise esta conversa e retorne o JSON de decisão.`;
}

module.exports = { buildSystemPrompt, buildUserPrompt };
