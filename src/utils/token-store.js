'use strict';

/**
 * Armazena tokens OAuth do Kommo em arquivo JSON + variáveis de ambiente em memória.
 * Em produção, substitua pelo seu banco de dados preferido.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');

const storePath = path.resolve(config.tokenStorePath);

function ensureDir() {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function read() {
  try {
    ensureDir();
    if (!fs.existsSync(storePath)) return null;
    const raw = fs.readFileSync(storePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    logger.warn('Não foi possível ler token store:', err.message);
    return null;
  }
}

function write(tokens) {
  try {
    ensureDir();
    fs.writeFileSync(storePath, JSON.stringify(tokens, null, 2), 'utf8');
    // Atualiza config em memória
    if (tokens.access_token) config.kommo.accessToken = tokens.access_token;
    if (tokens.refresh_token) config.kommo.refreshToken = tokens.refresh_token;
    if (tokens.expires_at) config.kommo.tokenExpiresAt = tokens.expires_at;
    logger.info('Tokens Kommo salvos com sucesso');
  } catch (err) {
    logger.error('Falha ao salvar tokens:', err.message);
  }
}

function getTokens() {
  // Prioridade: arquivo > env
  const stored = read();
  if (stored && stored.access_token) return stored;

  const { accessToken, refreshToken, tokenExpiresAt } = config.kommo;
  if (accessToken) {
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: tokenExpiresAt,
    };
  }
  return null;
}

function isExpired(tokens) {
  if (!tokens || !tokens.expires_at) return true;
  // Considera expirado 5 minutos antes
  return Date.now() / 1000 > tokens.expires_at - 300;
}

module.exports = { getTokens, write, isExpired };
