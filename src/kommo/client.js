'use strict';

/**
 * Cliente HTTP para a API do Kommo CRM v4.
 * Docs: https://www.kommo.com/developers/content/crm_platform/api-reference/
 *
 * Inclui:
 *   - Auto-renovação de token
 *   - Rate limiting (7 req/s no Kommo)
 *   - Retry com backoff exponencial
 *   - Suporte a paginação automática
 */

const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const config = require('../config');
const auth = require('./auth');
const logger = require('../utils/logger');

// Cria instância axios com retry
const http = axios.create({
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

axiosRetry(http, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err) => {
    const status = err.response?.status;
    // Retry em 429 (rate limit) e erros 5xx
    return axiosRetry.isNetworkOrIdempotentRequestError(err) || status === 429;
  },
  onRetry: (retryCount, err) => {
    logger.warn(`Kommo API retry ${retryCount}: ${err.message}`);
  },
});

// Interceptor: injeta Bearer token em toda requisição
http.interceptors.request.use(async (reqConfig) => {
  const token = await auth.getValidToken();
  reqConfig.headers.Authorization = `Bearer ${token}`;
  reqConfig.baseURL = config.kommo.baseUrl;
  return reqConfig;
});

// Interceptor: log de respostas de erro
http.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status;
    const url = err.config?.url;
    const detail = JSON.stringify(err.response?.data || err.message);
    logger.error(`Kommo API erro ${status} em ${url}: ${detail}`);
    return Promise.reject(err);
  }
);

/**
 * Busca todas as páginas de um endpoint paginado.
 * @param {string} endpoint - Ex: '/leads'
 * @param {object} params - Query params
 * @returns {Array} - Array com todos os itens
 */
async function fetchAllPages(endpoint, params = {}) {
  const allItems = [];
  let page = 1;

  while (true) {
    let response;
    try {
      response = await http.get(endpoint, {
        params: { ...params, page, limit: 250 },
      });
    } catch (err) {
      const status = err.response?.status;
      const baseUrl = config.kommo.baseUrl;
      const detail = JSON.stringify(err.response?.data || err.message);
      logger.error(`[fetchAllPages] Erro ${status} em ${baseUrl}${endpoint} (página ${page}): ${detail}`);
      throw err; // propaga para o caller tratar
    }

    const embedded = response.data?._embedded;
    if (!embedded) {
      // 204 No Content ou resposta sem _embedded = lista vazia (não é erro)
      logger.debug(`[fetchAllPages] ${endpoint} página ${page}: sem _embedded, encerrando`);
      break;
    }

    const items = Object.values(embedded)[0];
    if (!Array.isArray(items) || items.length === 0) break;

    allItems.push(...items);

    const links = response.data?._links;
    if (!links?.next) break;
    page++;
  }

  return allItems;
}

// ─── LEADS ─────────────────────────────────────────────────────────────────

async function getLead(leadId, withParams = {}) {
  const res = await http.get(`/leads/${leadId}`, { params: withParams });
  return res.data;
}

async function updateLead(leadId, data) {
  const res = await http.patch('/leads', [{ id: leadId, ...data }]);
  return res.data;
}

async function getLeads(params = {}) {
  return fetchAllPages('/leads', params);
}

// ─── NOTAS DO LEAD ─────────────────────────────────────────────────────────

async function getLeadNotes(leadId, params = {}) {
  return fetchAllPages(`/leads/${leadId}/notes`, params);
}

async function addLeadNote(leadId, { text, noteType = 'common', params: noteParams }) {
  const payload = { note_type: noteType, params: noteParams || { text } };
  const res = await http.post(`/leads/${leadId}/notes`, [payload]);
  return res.data;
}

// ─── PIPELINES ─────────────────────────────────────────────────────────────

async function getPipelines() {
  // Kommo API v4: pipelines ficam em /leads/pipelines (não /pipelines)
  return fetchAllPages('/leads/pipelines');
}

async function getPipelineStatuses(pipelineId) {
  const res = await http.get(`/leads/pipelines/${pipelineId}/statuses`);
  const statuses = res.data?._embedded?.statuses || {};
  return Object.values(statuses);
}

/**
 * Retorna todos os pipelines com suas etapas já incluídas.
 */
async function getPipelinesWithStatuses() {
  const pipelines = await getPipelines();
  const result = [];

  for (const pipeline of pipelines) {
    const statuses = await getPipelineStatuses(pipeline.id);
    result.push({
      id: pipeline.id,
      name: pipeline.name,
      is_main: pipeline.is_main,
      statuses: statuses.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type, // 0=normal, 142=won, 143=lost
        sort: s.sort,
        color: s.color,
      })),
    });
  }

  return result;
}

// ─── CONTATOS ──────────────────────────────────────────────────────────────

async function getContact(contactId) {
  const res = await http.get(`/contacts/${contactId}`, {
    params: { with: 'custom_fields_values' },
  });
  return res.data;
}

/**
 * Atualiza dados do contato: nome, telefone, e-mail.
 * @param {number} contactId
 * @param {{ name?, phone?, email? }} data
 */
async function updateContact(contactId, { name, phone, email }) {
  const payload = { id: contactId };

  if (name) payload.name = name;

  const customFieldsValues = [];
  if (phone) {
    customFieldsValues.push({
      field_code: 'PHONE',
      values: [{ value: phone, enum_code: 'WORK' }],
    });
  }
  if (email) {
    customFieldsValues.push({
      field_code: 'EMAIL',
      values: [{ value: email, enum_code: 'WORK' }],
    });
  }
  if (customFieldsValues.length > 0) {
    payload.custom_fields_values = customFieldsValues;
  }

  const res = await http.patch('/contacts', [payload]);
  return res.data;
}

// ─── USUÁRIOS ──────────────────────────────────────────────────────────────

async function getUsers() {
  return fetchAllPages('/users');
}

// ─── TALKS (conversas/WhatsApp Lite) ───────────────────────────────────────

async function getTalk(talkId) {
  const res = await http.get(`/talks/${talkId}`);
  return res.data;
}

async function getTalksByLead(leadId) {
  // Kommo espera: /talks?filter[entity_id]=X&filter[entity_type]=leads
  // Usando bracket notation direta como chave evita problema de serialização aninhada do axios
  try {
    const res = await http.get('/talks', {
      params: {
        'filter[entity_id]': leadId,
        'filter[entity_type]': 'leads',
        limit: 50,
        page: 1,
      },
    });
    const talks = res.data?._embedded?.talks;
    return Array.isArray(talks) ? talks : [];
  } catch (err) {
    if ([403, 404].includes(err.response?.status)) return [];
    // Fallback: flat params sem filter[]
    try {
      const res2 = await http.get('/talks', {
        params: { entity_id: leadId, entity_type: 'leads', limit: 50 },
      });
      const talks2 = res2.data?._embedded?.talks;
      return Array.isArray(talks2) ? talks2 : [];
    } catch (_) {
      return [];
    }
  }
}

/**
 * Busca mensagens de uma talk.
 * ATENÇÃO: endpoint específico do WhatsApp Lite no Kommo.
 */
async function getTalkMessages(talkId, limit = 100) {
  try {
    const res = await http.get(`/talks/${talkId}/messages`, {
      params: { limit },
    });
    return res.data?._embedded?.messages || [];
  } catch (err) {
    if (err.response?.status === 404) {
      logger.warn(`Talk ${talkId} não possui endpoint de mensagens. Usando notas do lead.`);
      return [];
    }
    throw err;
  }
}

// ─── EVENTS (histórico de atividades) ──────────────────────────────────────

async function getLeadEvents(leadId) {
  return fetchAllPages('/events', {
    filter: { entity: { id: [leadId], type: 'lead' } },
  });
}

// ─── UNSORTED (leads não classificados — WhatsApp Lite entrada) ────────────

async function acceptUnsorted(uid, pipelineId, statusId, responsibleUserId) {
  const body = {
    pipeline_id: pipelineId,
    status_id: statusId,
  };
  if (responsibleUserId) body.responsible_user_id = responsibleUserId;

  const res = await http.post(`/leads/unsorted/${uid}/accept`, body);
  return res.data;
}

// ─── TAREFAS ───────────────────────────────────────────────────────────────

async function createTask(leadId, { text, completeTillTimestamp, taskTypeId = 1, responsibleUserId }) {
  const payload = {
    entity_id: leadId,
    entity_type: 'leads',
    text,
    complete_till: completeTillTimestamp || Math.floor(Date.now() / 1000) + 86400, // default: tomorrow
    task_type_id: taskTypeId, // 1=call, 2=meeting, 3=email
  };
  if (responsibleUserId) payload.responsible_user_id = responsibleUserId;

  const res = await http.post('/tasks', [payload]);
  return res.data;
}

// ─── TAGS ──────────────────────────────────────────────────────────────────

async function addTagsToLead(leadId, tagNames) {
  const tags = tagNames.map((name) => ({ name }));
  const res = await http.patch('/leads', [{ id: leadId, _embedded: { tags } }]);
  return res.data;
}

// ─── CAMPOS CUSTOMIZADOS ───────────────────────────────────────────────────

/**
 * Atualiza campos customizados de um lead.
 * @param {number} leadId
 * @param {Array<{field_code: string, values: Array}>} customFieldsValues
 */
async function updateLeadCustomFields(leadId, customFieldsValues) {
  const res = await http.patch('/leads', [
    { id: leadId, custom_fields_values: customFieldsValues },
  ]);
  return res.data;
}

module.exports = {
  http,
  getLead,
  updateLead,
  getLeads,
  getLeadNotes,
  addLeadNote,
  getPipelines,
  getPipelineStatuses,
  getPipelinesWithStatuses,
  getContact,
  updateContact,
  updateLeadCustomFields,
  getUsers,
  getTalk,
  getTalksByLead,
  getTalkMessages,
  getLeadEvents,
  acceptUnsorted,
  addTagsToLead,
  createTask,
  fetchAllPages,
};
