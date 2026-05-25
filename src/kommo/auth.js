'use strict';

/**
 * Gerencia autenticação OAuth2 com o Kommo CRM.
 * Docs: https://www.kommo.com/developers/content/crm_platform/oauth/
 *
 * IMPORTANTE: Kommo exige application/x-www-form-urlencoded no token exchange,
 * NÃO application/json. Enviar JSON causa 403 Forbidden no nginx deles.
 */

const axios = require('axios');
const qs = require('querystring');
const config = require('../config');
const tokenStore = require('../utils/token-store');
const logger = require('../utils/logger');

// Troca de token SEMPRE usa o subdomínio da conta
function getTokenUrl() {
  return `https://${config.kommo.subdomain}.kommo.com/oauth2/access_token`;
}

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };

/**
 * Troca o authorization code por access + refresh token.
 */
async function exchangeCode(code) {
  logger.info(`Trocando authorization code (${code.slice(0, 12)}...) por tokens via ${getTokenUrl()}`);

  const body = qs.stringify({
    client_id: config.kommo.clientId,
    client_secret: config.kommo.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.kommo.redirectUri,
  });

  const response = await axios.post(getTokenUrl(), body, { headers: FORM_HEADERS });

  const tokens = buildTokens(response.data);
  tokenStore.write(tokens);
  logger.info('Tokens obtidos com sucesso!');
  return tokens;
}

/**
 * Renova o access token usando o refresh token.
 */
async function refreshAccessToken() {
  const current = tokenStore.getTokens();
  if (!current?.refresh_token) {
    throw new Error('Nenhum refresh_token disponível. Acesse /auth/kommo para autenticar.');
  }

  logger.info('Renovando access token do Kommo...');

  const body = qs.stringify({
    client_id: config.kommo.clientId,
    client_secret: config.kommo.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    redirect_uri: config.kommo.redirectUri,
  });

  try {
    const response = await axios.post(getTokenUrl(), body, { headers: FORM_HEADERS });
    const tokens = buildTokens(response.data);
    tokenStore.write(tokens);
    logger.info('Access token renovado com sucesso');
    return tokens;
  } catch (err) {
    const msg = err.response?.data?.hint || err.response?.data?.message || err.message;
    logger.error('Falha ao renovar token:', msg);
    throw new Error(`Falha na renovação do token Kommo: ${msg}`);
  }
}

/**
 * Retorna um access token válido, renovando se necessário.
 * Token de longa duração (expires_at > ano 2100) nunca é renovado.
 */
async function getValidToken() {
  let tokens = tokenStore.getTokens();

  if (!tokens?.access_token) {
    throw new Error('Kommo não autenticado. Acesse /auth/kommo para autenticar.');
  }

  // Token de longa duração: expires_at muito alto = não renova nunca
  const isLongDurationToken = tokens.expires_at > 4_000_000_000; // > ano 2096
  if (!isLongDurationToken && tokenStore.isExpired(tokens)) {
    tokens = await refreshAccessToken();
  }

  return tokens.access_token;
}

/**
 * Gera a URL de autorização OAuth.
 * Auth SEMPRE usa www.kommo.com — NÃO o subdomínio.
 */
function getAuthorizationUrl() {
  const params = new URLSearchParams({
    client_id: config.kommo.clientId,
    redirect_uri: config.kommo.redirectUri,
    response_type: 'code',
    state: 'kommoblue_auth',
  });
  return `https://www.kommo.com/oauth?${params.toString()}`;
}

function buildTokens(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type || 'Bearer',
    expires_in: data.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 86400),
  };
}

module.exports = { exchangeCode, refreshAccessToken, getValidToken, getAuthorizationUrl };
