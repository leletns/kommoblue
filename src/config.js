'use strict';

require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) {
    // Em dev, apenas avisa; em prod, lança erro
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
    }
  }
  return val || '';
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  kommo: {
    subdomain: process.env.KOMMO_SUBDOMAIN || '',
    clientId: process.env.KOMMO_CLIENT_ID || '',
    clientSecret: process.env.KOMMO_CLIENT_SECRET || '',
    redirectUri: process.env.KOMMO_REDIRECT_URI || '',
    accessToken: process.env.KOMMO_ACCESS_TOKEN || '',
    refreshToken: process.env.KOMMO_REFRESH_TOKEN || '',
    tokenExpiresAt: process.env.KOMMO_TOKEN_EXPIRES_AT
      ? parseInt(process.env.KOMMO_TOKEN_EXPIRES_AT, 10)
      : 0,
    webhookSecret: process.env.WEBHOOK_SECRET || '',
    get baseUrl() {
      return `https://${this.subdomain}.kommo.com/api/v4`;
    },
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.AI_MODEL || 'claude-opus-4-7',
  },

  agent: {
    language: process.env.AGENT_LANGUAGE || 'pt-BR',
    autoReply: process.env.AGENT_AUTO_REPLY === 'true',
    replyRequiresApproval: process.env.AGENT_REPLY_REQUIRES_APPROVAL !== 'false',
    maxContextMessages: parseInt(process.env.AI_CONTEXT_MAX_MESSAGES || '50', 10),
  },

  tokenStorePath: process.env.TOKEN_STORE_PATH || './data/tokens.json',
};
