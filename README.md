# Kommo Blue — Agente IA para WhatsApp Lite

Agente de IA que **lê automaticamente todas as mensagens do WhatsApp Lite no Kommo CRM** e move os leads pelos pipelines sem intervenção manual.

## Como funciona

```
WhatsApp → Kommo (webhook) → Agente IA (Claude) → Move pipeline + Adiciona nota
```

1. **Cliente manda mensagem** no WhatsApp
2. **Kommo dispara webhook** para este servidor
3. **Agente lê TODO o histórico** da conversa (mensagens antigas + nova)
4. **Claude analisa** sentimento, intenção e estágio do cliente
5. **Pipeline atualizado** automaticamente + nota adicionada ao lead

---

## Instalação

### Requisitos
- Node.js 18+
- Conta Kommo com WhatsApp Lite ativo
- API key da Anthropic (Claude)

### 1. Clonar e instalar
```bash
git clone <repo>
cd kommoblue
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Edite o .env com suas credenciais
```

Variáveis obrigatórias:

| Variável | Descrição |
|----------|-----------|
| `KOMMO_SUBDOMAIN` | Seu subdomínio Kommo (ex: `minhaempresa`) |
| `KOMMO_CLIENT_ID` | Client ID da integração OAuth |
| `KOMMO_CLIENT_SECRET` | Client Secret da integração OAuth |
| `KOMMO_REDIRECT_URI` | URL de callback OAuth (deve ser público) |
| `ANTHROPIC_API_KEY` | Sua API key da Anthropic |

### 3. Criar integração no Kommo

1. Acesse **Configurações → Integrações → Criar** no Kommo
2. Escolha **OAuth 2.0**
3. Configure `Redirect URI` = `https://seudominio.com/auth/kommo/callback`
4. Copie `Client ID` e `Client Secret` para o `.env`

### 4. Autenticar OAuth
```bash
npm run setup
```
Abrirá um servidor local e abrirá o link de autorização. Após aprovar, os tokens são salvos automaticamente.

### 5. Iniciar o servidor
```bash
npm start
# ou em desenvolvimento:
npm run dev
```

### 6. Configurar webhook no Kommo

No painel Kommo → **Configurações → Webhooks**:
- URL: `https://seudominio.com/webhook/kommo`
- Eventos: ✅ Leads (add, update) | ✅ Mensagens | ✅ Notas

---

## Rotas disponíveis

| Método | Rota | Descrição |
|--------|------|-----------|
| `POST` | `/webhook/kommo` | Recebe eventos do Kommo |
| `GET` | `/auth/kommo` | Inicia fluxo OAuth |
| `GET` | `/auth/kommo/callback` | Callback OAuth |
| `GET` | `/health` | Status do servidor |
| `GET` | `/status` | Status detalhado + pipelines |
| `POST` | `/analyze/:leadId` | Análise manual de um lead |

---

## Configurações do agente

No `.env`:

```env
# A IA deve responder ao cliente automaticamente?
AGENT_AUTO_REPLY=false

# Quantas mensagens anteriores incluir no contexto da IA
AI_CONTEXT_MAX_MESSAGES=50

# Idioma das análises e notas
AGENT_LANGUAGE=pt-BR
```

---

## Deploy com Docker

```bash
# Produção
docker-compose up -d

# Desenvolvimento (com ngrok)
NGROK_AUTHTOKEN=seu_token docker-compose --profile dev up
```

---

## Testar manualmente

Analisar um lead específico sem esperar webhook:
```bash
curl -X POST http://localhost:3000/analyze/12345
```

Ver status do sistema:
```bash
curl http://localhost:3000/status
```

---

## Arquitetura

```
src/
├── server.js                    # Express + rotas
├── config.js                    # Configuração via .env
├── kommo/
│   ├── auth.js                  # OAuth2 (troca código, renova token)
│   ├── client.js                # Kommo API v4 (leads, notas, talks)
│   ├── conversation-loader.js   # Carrega histórico completo da conversa
│   └── webhook-handler.js       # Parser de webhooks + fila de processamento
├── ai/
│   ├── agent.js                 # Agente Claude (análise + decisão)
│   └── prompts.js               # System/user prompts com cache Anthropic
├── processors/
│   └── conversation.js          # Orquestrador: webhook → IA → atualiza Kommo
└── utils/
    ├── logger.js                # Winston logger
    └── token-store.js           # Persistência de tokens OAuth
```

---

## Decisões do agente IA

O agente retorna um JSON estruturado a cada análise:

```json
{
  "analysis": "Cliente demonstrou forte interesse e pediu proposta formal",
  "sentiment": "muito_positivo",
  "client_intent": "comprar",
  "move_to_status_id": 12345,
  "move_to_status_name": "Proposta Enviada",
  "move_reason": "Cliente solicitou proposta comercial explicitamente",
  "note_to_add": "Cliente quer proposta até sexta. Budget confirmado.",
  "tags_to_add": ["quente", "proposta-solicitada"],
  "urgency": "alta",
  "suggested_action": "Enviar proposta formal com prazo até sexta-feira"
}
```