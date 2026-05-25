'use strict';

/**
 * Gerencia autenticação OAuth2 com o Kommo CRM.
 * Docs: https://www.kommo.com/developers/content/crm_platform/oauth/
 */

const axios = require('axios');
const config = require('../config');
const tokenStore = require('../utils/token-store');
const logger = require('../utils/logger');

const AUTH_URL = 'https://www.kommo.com/oauth2/access_token';

/**
 * Troca o authorization code por access + refresh token.
 * Chamado uma única vez durante o setup inicial.
 */
async function exchangeCode(code) {
  logger.info('Trocando authorization code por tokens...');

  const response = await axios.post(AUTH_URL, {
    client_id: config.kommo.clientId,
    client_secret: config.kommo.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.kommo.redirectUri,
  });

  const tokens = buildTokens(response.data);
  tokenStore.write(tokens);
  return tokens;
}

/**
 * Renova o access token usando o refresh token.
 * Chamado automaticamente quando o token expira.
 */
async function refreshAccessToken() {
  const current = tokenStore.getTokens();
  if (!current?.refresh_token) {
    throw new Error(
      'Nenhum refresh_token disponível. Execute "npm run setup" para autenticar.'
    );
  }

  logger.info('Renovando access token do Kommo...');

  try {
    const response = await axios.post(AUTH_URL, {
      client_id: config.kommo.clientId,
      client_secret: config.kommo.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
      redirect_uri: config.kommo.redirectUri,
    });

    const tokens = buildTokens(response.data);
    tokenStore.write(tokens);
    logger.info('Access token renovado com sucesso');
    return tokens;
  } catch (err) {
    const msg = err.response?.data?.hint || err.message;
    logger.error('Falha ao renovar token:', msg);
    throw new Error(`Falha na renovação do token Kommo: ${msg}`);
  }
}

/**
 * Retorna um access token válido, renovando se necessário.
 */
async function getValidToken() {
  let tokens = tokenStore.getTokens();

  if (!tokens?.access_token) {
    throw new Error(
      'Kommo não autenticado. Execute "npm run setup" para realizar o OAuth.'
    );
  }

  if (tokenStore.isExpired(tokens)) {
    tokens = await refreshAccessToken();
  }

  return tokens.access_token;
}

/**
 * Gera a URL de autorização OAuth para o setup inicial.
 */
function getAuthorizationUrl() {
  const params = new URLSearchParams({
    client_id: config.kommo.clientId,
    mode: 'post_message',
    redirect_uri: config.kommo.redirectUri,
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
