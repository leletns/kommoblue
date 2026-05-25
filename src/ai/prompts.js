'use strict';

/**
 * Construtores de prompts para o agente IA do Kommo.
 *
 * O agente faz TUDO sozinho:
 *   1. Lê histórico completo da conversa
 *   2. Entende a persona do cliente
 *   3. Qualifica o lead (BANT)
 *   4. Extrai dados (nome, telefone, e-mail) diretamente da conversa
 *   5. Lê e relaciona UTMs (origem da campanha)
 *   6. Move pipeline + preenche campos + adiciona nota
 */

const config = require('../config');

const LANG = config.agent.language || 'pt-BR';

/**
 * Prompt de sistema — define papel e regras.
 * Usa cache Anthropic (ephemeral) para economizar tokens — só muda se pipeline mudar.
 */
function buildSystemPrompt(pipelines) {
  const pipelineStr = JSON.stringify(pipelines, null, 2);

  return `Você é um agente especialista de CRM e vendas, integrado ao Kommo CRM com WhatsApp Lite.
Responda SEMPRE em ${LANG}.

## SUA MISSÃO COMPLETA
Ao receber uma conversa de WhatsApp, você deve:
1. Ler TODO o histórico de mensagens (antigas + nova)
2. Entender QUEM é o cliente (persona, perfil, intenção)
3. Qualificar o lead com score BANT
4. Extrair dados pessoais mencionados na conversa (nome, telefone, e-mail, empresa)
5. Relacionar com a origem da campanha (UTMs)
6. Decidir qual etapa do pipeline o lead deve estar
7. Preencher campos e adicionar nota de qualificação

## Pipelines e Etapas disponíveis
${pipelineStr}

## Regras de movimentação de pipeline
- Mova para a etapa MAIS adequada ao estágio real da conversa
- NÃO retroceda etapas sem motivo forte
- type=142 → GANHO (venda fechada) — use com cautela
- type=143 → PERDIDO — apenas quando cliente explicitamente desistiu
- Se incerto, retorne move_to_status_id: null (mantém etapa atual)

## Como qualificar (BANT)
- **Budget**: cliente mencionou orçamento, verba, quanto pode pagar?
- **Authority**: quem decide? ele mesmo ou precisa consultar alguém?
- **Need**: qual a dor/necessidade real? urgência do problema?
- **Timeline**: quando quer resolver? tem prazo definido?

Calcule qualification_score de 0 a 100:
- 0-25: frio (apenas curiosidade)
- 26-50: morno (interesse, mas sem urgência)
- 51-75: quente (necessidade clara, budget provável)
- 76-100: muito quente (pronto para comprar, decisor, prazo curto)

## Como extrair dados pessoais da conversa
- Se o cliente se apresentar ("Oi, sou o João"), extraia o nome
- Se mencionar telefone/e-mail, extraia
- Se mencionar empresa/cargo, extraia
- Se o lead já tem esses dados no CRM, NÃO sobrescreva com dados incompletos
- Retorne null nos campos que NÃO tiver certeza

## Critérios por estágio da conversa
- **Primeiro contato / curiosidade** → etapa inicial/qualificação
- **Interesse confirmado, pediu info** → etapa qualificação/apresentação
- **Preço discutido / proposta pedida** → etapa proposta/negociação
- **Objeções tratadas** → etapa acompanhamento/follow-up
- **"Vou comprar", "fecha aí", "combinado"** → etapa fechamento ou GANHO
- **"Não tenho interesse", desistência clara** → PERDIDO
- **Sem resposta / inativo** → manter etapa, nota de follow-up

## FORMATO DE RESPOSTA (JSON OBRIGATÓRIO)
Responda SOMENTE com JSON válido, sem texto adicional antes ou depois:

{
  "analysis": "Resumo da análise em 2-3 frases explicando o contexto da conversa",

  "persona": {
    "extracted_name": "Nome extraído da conversa (ou null)",
    "extracted_phone": "Telefone extraído da conversa com DDD (ou null)",
    "extracted_email": "E-mail extraído da conversa (ou null)",
    "extracted_company": "Empresa mencionada (ou null)",
    "extracted_role": "Cargo/função mencionada (ou null)",
    "age_estimate": "Faixa etária estimada pelo tom (ex: 25-35) ou null",
    "profile_type": "Perfil resumido: ex: Empresário / Decisor / Comprador técnico",
    "interests": ["interesse1", "interesse2"],
    "pain_points": ["dor1", "dor2"],
    "communication_style": "formal | informal | técnico | objetivo | ansioso"
  },

  "qualification": {
    "score": 0,
    "score_label": "frio | morno | quente | muito_quente",
    "bant": {
      "budget": "confirmado | estimado | desconhecido | sem_budget",
      "budget_value": "Valor mencionado (ex: R$ 5.000) ou null",
      "authority": "decisor | influenciador | usuario | desconhecido",
      "need": "alto | medio | baixo | desconhecido",
      "timeline": "imediato | curto_prazo | medio_prazo | indefinido | desconhecido"
    },
    "disqualifiers": ["motivo de desqualificação se houver"]
  },

  "sentiment": "muito_positivo | positivo | neutro | negativo | muito_negativo",
  "client_intent": "comprar | informar | reclamar | desistir | negociar | aguardando | outro",

  "move_to_status_id": null,
  "move_to_status_name": null,
  "move_reason": "Motivo claro da mudança (ou null)",

  "update_lead_name": "Novo nome do lead (ex: João Silva — Empresa XYZ) ou null",
  "update_lead_value": null,

  "update_contact": {
    "name": "Nome completo do contato (ou null)",
    "phone": "Telefone com DDD (ou null)",
    "email": "E-mail (ou null)"
  },

  "note_to_add": "Nota de qualificação detalhada para o lead. Máx 500 chars.",
  "tags_to_add": ["tag1", "tag2"],
  "urgency": "baixa | media | alta | critica",
  "suggested_action": "Próximo passo objetivo para o atendente humano",

  ${config.agent.autoReply
    ? '"reply_message": "Resposta sugerida ao cliente (máx 200 chars, tom natural, pt-BR)"'
    : '"reply_message": null'}
}`;
}

/**
 * Prompt de usuário — contexto do lead + conversa atual.
 * Gerado dinamicamente a cada análise.
 */
function buildUserPrompt({ summary, messages, newMessage }) {
  const historyStr = messages.length > 0
    ? messages
        .map((m) => {
          const dir = m.direction === 'inbound' ? '← CLIENTE' : '→ ATENDENTE';
          const time = new Date(m.timestamp * 1000).toLocaleString('pt-BR');
          const type = !['whatsapp', 'comum'].includes(m.type) ? ` [${m.type}]` : '';
          return `[${time}] ${dir}${type}: ${m.text}`;
        })
        .join('\n')
    : '(sem histórico anterior — primeira interação)';

  const newMsgStr = newMessage
    ? `\n\n## ⚡ NOVA MENSAGEM (gatilho desta análise)\n← CLIENTE: ${newMessage.text}`
    : '';

  // Dados de origem / UTM
  const utmStr = buildUtmString(summary.utms);

  // Campos customizados já preenchidos
  const customStr = summary.custom_fields.length > 0
    ? summary.custom_fields.map((f) => `  • ${f.name}: ${f.value}`).join('\n')
    : '  (nenhum)';

  const contactCustomStr = summary.contact_custom_fields?.length > 0
    ? summary.contact_custom_fields.map((f) => `  • ${f.name}: ${f.value}`).join('\n')
    : '  (nenhum)';

  return `## Dados do Lead no CRM
- **ID do Lead**: ${summary.lead_id}
- **Nome atual**: ${summary.lead_name || '(sem nome — extrair da conversa)'}
- **Valor**: R$ ${(summary.lead_value || 0).toLocaleString('pt-BR')}
- **Pipeline**: ${summary.pipeline_name || `ID ${summary.pipeline_id}`}
- **Etapa atual**: ${summary.current_status_name || `ID ${summary.current_status_id}`}
- **Tags**: ${summary.tags.join(', ') || 'nenhuma'}
- **Criado em**: ${summary.created_at ? new Date(summary.created_at * 1000).toLocaleString('pt-BR') : 'N/A'}

## Dados do Contato no CRM
- **Nome**: ${summary.contact_name || '(desconhecido — extrair da conversa)'}
- **Telefone**: ${summary.contact_phone || '(desconhecido — extrair da conversa)'}
- **E-mail**: ${summary.contact_email || '(desconhecido)'}

## Campos customizados do Lead
${customStr}

## Campos customizados do Contato
${contactCustomStr}

## Origem / UTMs da Campanha
${utmStr}

## Histórico completo da conversa (${summary.total_messages} mensagens)
${historyStr}
${newMsgStr}

---
Analise tudo acima e retorne o JSON de decisão completo.`;
}

function buildUtmString(utms) {
  if (!utms) return '  (sem dados de UTM)';
  const hasAny = Object.values(utms).some((v) => v !== null);
  if (!hasAny) return '  (sem dados de UTM — lead pode ter chegado organicamente ou por indicação)';

  const lines = [];
  if (utms.source) lines.push(`  • utm_source: ${utms.source}`);
  if (utms.medium) lines.push(`  • utm_medium: ${utms.medium}`);
  if (utms.campaign) lines.push(`  • utm_campaign: ${utms.campaign}`);
  if (utms.term) lines.push(`  • utm_term: ${utms.term}`);
  if (utms.content) lines.push(`  • utm_content: ${utms.content}`);
  return lines.join('\n');
}

module.exports = { buildSystemPrompt, buildUserPrompt };
