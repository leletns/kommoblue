'use strict';

/**
 * Store persistente de mensagens WhatsApp por lead.
 *
 * Como o Kommo WhatsApp Lite bloqueia /talks/{id}/messages via API (403),
 * salvamos cada mensagem recebida via webhook aqui.
 * O bulk scan lê desse store para ter histórico real.
 *
 * Formato do arquivo: JSON com { [leadId]: [ { timestamp, direction, text, type } ] }
 * Máx 50 mensagens por lead (circular buffer — remove as mais antigas).
 */

const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(process.cwd(), 'data', 'messages.json');
const MAX_PER_LEAD = 50;

// Cache em memória para evitar leitura do disco a cada acesso
let _store = null;
let _dirty = false;

function ensureDir() {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (_store) return _store;
  ensureDir();
  if (fs.existsSync(STORE_FILE)) {
    try {
      _store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    } catch (_) {
      _store = {};
    }
  } else {
    _store = {};
  }
  return _store;
}

function save() {
  if (!_dirty) return;
  ensureDir();
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(_store, null, 2));
    _dirty = false;
  } catch (err) {
    // não fatal — continua em memória
  }
}

// Persiste a cada 5s se houver mudanças
setInterval(save, 5000);

/**
 * Adiciona uma mensagem ao store de um lead.
 * @param {number|string} leadId
 * @param {{ text: string, direction: 'inbound'|'outbound', timestamp?: number, type?: string }} msg
 */
function addMessage(leadId, msg) {
  const store = load();
  const key = String(leadId);
  if (!store[key]) store[key] = [];

  const entry = {
    id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
    direction: msg.direction || 'inbound',
    text: (msg.text || '').trim(),
    type: msg.type || 'whatsapp',
  };

  // Evita duplicatas (mesmo texto nos últimos 30s)
  const recent = store[key].slice(-5);
  const isDuplicate = recent.some(
    (m) => m.text === entry.text && Math.abs(m.timestamp - entry.timestamp) < 30
  );
  if (isDuplicate) return;

  store[key].push(entry);

  // Mantém só os últimos MAX_PER_LEAD
  if (store[key].length > MAX_PER_LEAD) {
    store[key] = store[key].slice(-MAX_PER_LEAD);
  }

  _dirty = true;
}

/**
 * Retorna mensagens de um lead (já normalizadas para o formato do conversation loader).
 * @param {number|string} leadId
 * @returns {Array}
 */
function getMessages(leadId) {
  const store = load();
  return store[String(leadId)] || [];
}

/**
 * Retorna quantidade de mensagens armazenadas por lead.
 */
function getStats() {
  const store = load();
  const total = Object.values(store).reduce((acc, msgs) => acc + msgs.length, 0);
  return { leads: Object.keys(store).length, total };
}

module.exports = { addMessage, getMessages, getStats };
