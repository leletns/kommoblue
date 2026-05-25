#!/usr/bin/env node
'use strict';

/**
 * Script de setup inicial — guia o usuário pelo processo OAuth2 do Kommo.
 * Execute: node scripts/setup-oauth.js
 */

require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const config = require('../src/config');
const auth = require('../src/kommo/auth');
const logger = require('../src/utils/logger');

async function setup() {
  console.log('\n🔧 Kommo Blue — Setup OAuth2\n');

  // Valida config mínima
  const missing = ['KOMMO_SUBDOMAIN', 'KOMMO_CLIENT_ID', 'KOMMO_CLIENT_SECRET', 'KOMMO_REDIRECT_URI']
    .filter((k) => !process.env[k]);

  if (missing.length > 0) {
    console.error('❌ Variáveis de ambiente faltando:');
    missing.forEach((k) => console.error(`   • ${k}`));
    console.error('\n📋 Copie o .env.example para .env e preencha os valores.');
    process.exit(1);
  }

  // Extrai porta da REDIRECT_URI para servidor local de callback
  let callbackPort = 3000;
  try {
    const redirectUrl = new URL(config.kommo.redirectUri);
    if (redirectUrl.hostname === 'localhost' || redirectUrl.hostname === '127.0.0.1') {
      callbackPort = parseInt(redirectUrl.port, 10) || 3000;
    }
  } catch (_) {}

  const authUrl = auth.getAuthorizationUrl();

  console.log('1. Abra a URL abaixo no navegador para autorizar o Kommo:');
  console.log('\n   ' + authUrl + '\n');
  console.log('2. Após autorizar, você será redirecionado para o callback.');
  console.log('3. Aguardando callback na porta ' + callbackPort + '...\n');

  // Inicia servidor temporário para capturar o code
  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${callbackPort}`);

      if (!url.pathname.includes('callback')) {
        res.end('Aguardando callback...');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.end(`<h1>Erro: ${error}</h1>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.end('<h1>Código não encontrado</h1>');
        return;
      }

      try {
        const tokens = await auth.exchangeCode(code);
        console.log('\n✅ Autenticação concluída com sucesso!');
        console.log(`   Access token expira em: ${new Date(tokens.expires_at * 1000).toLocaleString('pt-BR')}`);
        console.log('\n🚀 Execute "npm start" para iniciar o agente.\n');

        res.end(`
          <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center">
            <h1>✅ Kommo conectado!</h1>
            <p>Tokens salvos. Você pode fechar esta janela.</p>
          </body></html>
        `);

        server.close();
        resolve();
      } catch (err) {
        console.error('\n❌ Falha na troca do código:', err.message);
        res.end(`<h1>Erro: ${err.message}</h1>`);
        server.close();
        reject(err);
      }
    });

    server.listen(callbackPort, () => {
      console.log(`Servidor de callback ativo em http://localhost:${callbackPort}`);
    });

    server.on('error', reject);

    // Timeout de 5 minutos
    setTimeout(() => {
      server.close();
      reject(new Error('Timeout aguardando callback OAuth (5 min)'));
    }, 5 * 60 * 1000);
  });
}

setup().catch((err) => {
  console.error('❌ Setup falhou:', err.message);
  process.exit(1);
});
