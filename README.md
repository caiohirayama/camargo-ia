# Camargo IA

Agente comercial da Camargo Atacarejo de Bebidas para atendimento pelo WhatsApp via Evolution API e OpenAI.

## Responsabilidades

- incluir clientes em `Bot.Cliente`;
- registrar mensagens recebidas e enviadas em `Bot.Mensagens`;
- responder dúvidas com prompt operacional e base RAG separados;
- transcrever áudios e analisar imagens enviadas pelo cliente (produtos, rótulos, embalagens);
- consultar o catálogo real (preço, unidade de venda e disponibilidade) via `consultar_produtos` antes de informar qualquer valor, e montar o orçamento com os itens confirmados;
- pausar a IA quando um atendente assumir ou quando o atendimento exigir transferência, e retomar o histórico de conversa a partir de `Bot.Mensagens` — ambos sobrevivem a um restart do processo;
- reativar a IA sozinha (sem ação manual) quando o cliente volta a escrever depois de `PAUSE_EXPIRATION_HOURS` sem nenhuma mensagem — a pausa protege uma conversa em andamento com atendente, não silencia o cliente para sempre (compra é recorrente).

As respostas são enviadas diretamente pela Evolution API e registradas em `Bot.Mensagens`; não há fila comercial nem persistência de estado de lead. A loja trabalha só com retirada no local: o orçamento fechado pela IA não reserva estoque nem horário, e o pedido é finalizado presencialmente na loja.

O projeto não cria leads no CRM, não atualiza status comerciais e não grava resumos de atendimento no PostgreSQL — o orçamento em si (itens, valores) nunca é persistido ali, só passa em memória durante o turno e, se confirmado, vai para o GestãoClick (ver "Orçamento no GestãoClick"). As únicas exceções de escrita fora de `INSERT` em `Bot.Cliente` são a flag operacional `iaPausada` (liga/desliga a resposta automática para aquele contato) e `gestaoClickClienteId` (vínculo com o cliente correspondente no GestãoClick, pra não duplicar cadastro a cada pedido) — nenhuma das duas é um status comercial, e `Bot.Mensagens` continua um log de auditoria imutável (nunca sofre `UPDATE` ou `DELETE`).

## Requisitos

- Node.js 20 ou superior;
- PostgreSQL 14 ou superior;
- credenciais da Evolution API e OpenAI;
- acesso à API de produtos/preços da Camargo (catálogo).
- bucket Cloudflare R2 para persistência das mídias recebidas.

## Evolution API

Esta aplicação usa exclusivamente o contrato da Evolution API (Node.js/TypeScript), validado contra a versão estável `2.3.7`, não o Evolution Go. Existe somente a instância Camargo, configurada pelo `.env`, usando os endpoints `/message/sendText/{instance}`, `/chat/sendPresence/{instance}`, `/chat/findContacts/{instance}`, `/chat/getBase64FromMediaMessage/{instance}` e `/webhook/set/{instance}`.

O webhook usa o payload aninhado `webhook` da Evolution API 2.3.7 e é configurado para `MESSAGES_UPSERT` e `CONNECTION_UPDATE`, sem base64 embutido. As mídias são obtidas pelo endpoint da Evolution API e depois persistidas no Cloudflare R2.

## Configuração

Copie `.env.example` para `.env` e informe as credenciais. A conexão pode ser configurada por uma única `DATABASE_URL` ou pelas variáveis `POSTGRES_*`.

Toda a configuração da instância única vem do ambiente: `CAMARGO_INSTANCE_NAME`, `CAMARGO_PHONE_NUMBER`, `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_URL`, `OPENAI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` e `TYPING_*`. O PostgreSQL não armazena credenciais nem configuração da Evolution API/OpenAI.

Quando a aplicação e o PostgreSQL estão em containers na mesma rede Docker, use o nome do container como `POSTGRES_HOST`. SSL normalmente fica desativado nessa comunicação interna.

### Cloudflare R2

Crie um bucket no R2 e um token de API com permissão de gravação de objetos somente nesse bucket. Configure `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` e `R2_PUBLIC_BASE_URL` conforme `.env.example`.

Em produção, conecte o bucket a um domínio como `media.seudominio.com.br` e use `https://media.seudominio.com.br` em `R2_PUBLIC_BASE_URL`. O endpoint `r2.dev` é adequado somente para desenvolvimento. O bucket precisa permitir leitura pública pelo domínio informado para que as URLs gravadas em `Bot.Mensagens.mediaUrl` funcionem.

Os objetos recebem caminhos opacos, sem telefone ou nome da instância. Configure no bucket uma política de ciclo de vida compatível com o prazo de retenção desejado. `MEDIA_MAX_BYTES` limita downloads e uploads em memória; o padrão é 25 MiB. Quando o upload falha, a aplicação não grava a URL temporária do WhatsApp como se fosse permanente.

### API de produtos (catálogo GestãoClick)

A IA consulta o catálogo real do [GestãoClick](https://gestaoclick.com/integracao_api/documentacao/index) via function calling (`consultar_produtos`, `GET /api/produtos?nome=...`) antes de informar preço, estoque ou código de qualquer item — nunca responde por suposição ou memória de conversa.

Configure:

- `GESTAOCLICK_ACCESS_TOKEN`;
- `GESTAOCLICK_SECRET_TOKEN`.

Gere os dois em **Configurações > Integração via API** no GestãoClick. O Secret Access Token só é exibido uma vez no momento da geração — guarde-o com segurança (gerenciador de segredos ou `.env`, nunca versionado) e, se ele for exposto (print, log, chat), gere um novo.

Sem as duas variáveis configuradas, a ferramenta fica indisponível e a IA trata toda pergunta de preço/produto como "catálogo indisponível", encaminhando para um atendente (`transferir_humano: true`) em vez de inventar valores.

Cada produto pode ter mais de um valor de venda cadastrado no GestãoClick (ex: faixas "Pequena quantidade"/"Ofertas"); `src/services/productService.js` só expõe à IA o `valor_venda` padrão (a faixa "Pequena quantidade"). Qualquer condição diferente (quantidade grande, negociação) é confirmada por um atendente, não decidida pela IA.

### Orçamento no GestãoClick

Depois que o cliente confirma explicitamente o resumo do pedido no WhatsApp (ver `camargo_agent_prompt.md`, seção "Confirmação do pedido"), `src/services/orcamentoService.js` registra o pedido de verdade no GestãoClick, usando as mesmas credenciais `GESTAOCLICK_ACCESS_TOKEN`/`GESTAOCLICK_SECRET_TOKEN`:

1. Localiza o cliente no GestãoClick — usa `Bot.Cliente.gestaoClickClienteId` se já tiver sido resolvido antes; senão busca por telefone (`GET /clientes?telefone=`, sem o DDI) antes de criar um novo, pra não duplicar cadastro do mesmo contato.
2. Cria o cliente (`POST /clientes`, sempre `tipo_pessoa: PF` + celular) só se a busca por telefone não encontrar nada.
3. Cria o orçamento (`POST /orcamentos`) com os itens confirmados (`produto_id`, `variacao_id` e `valor_venda` vêm da última consulta ao catálogo feita nesta conversa — a API do GestãoClick não preenche o preço sozinha, um item sem `valor_venda` explícito entra com valor zero).

Antes da confirmação explícita, o orçamento fica só em memória (`src/services/pendingOrderService.js`) — nada é criado no GestãoClick nem persistido no PostgreSQL enquanto o cliente não confirma.

## Criação do esquema

Crie primeiro um banco PostgreSQL vazio. O projeto não mantém migrations numeradas; para uma instalação nova, aplique o schema operacional:

```bash
psql -v ON_ERROR_STOP=1 -d camargo -f sql/camargo_schema.sql
```

Antes de aplicar em um banco já existente, transfira as credenciais de `Bot.Instancias` para o `.env` e faça backup. O schema remove explicitamente a tabela legada `Bot.Instancias` e mantém somente `Bot.Cliente` e `Bot.Mensagens`; não existe seed de instância.

Em um banco já existente (sem as colunas `iaPausada`/`gestaoClickClienteId`), basta reaplicar o schema: os `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` são idempotentes e não afetam dados já gravados. Aplique o schema (e o `GRANT` novo) antes de subir uma versão do app que já grave em `gestaoClickClienteId`, senão o boot falha na validação de permissões.

### Permissões do usuário da aplicação

Execute o schema com o usuário proprietário do banco. Depois conceda ao usuário usado pela aplicação apenas as permissões de runtime:

```sql
GRANT CONNECT ON DATABASE camargo TO camargo_app;
GRANT USAGE ON SCHEMA bot TO camargo_app;
GRANT SELECT, INSERT ON TABLE bot.cliente, bot.mensagens TO camargo_app;
GRANT UPDATE (iaPausada, gestaoClickClienteId, updatedAt) ON TABLE bot.cliente TO camargo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA bot TO camargo_app;
```

O `UPDATE` é restrito às colunas `iaPausada`, `gestaoClickClienteId` e `updatedAt` — a aplicação nunca altera nome, telefone ou os demais dados do cliente, e `bot.mensagens` não recebe nenhum privilégio de `UPDATE`/`DELETE`.

Não use o superusuário do PostgreSQL na aplicação. Guarde a senha somente no `.env` ou no gerenciador de segredos do ambiente e faça rotação periódica.

## Execução

```bash
npm install
npm run dev
```

O servidor usa a porta `3001` por padrão. Também são obrigatórios:

- `WEBHOOK_SECRET`: segredo aceito na URL do webhook ou no header `x-webhook-secret`;
- `TEST_API_KEY`: chave exigida no header `x-api-key` em todos os endpoints `/test/*`.

Os endpoints `/test/set-webhook` e `/test/send-test` usam automaticamente `CAMARGO_INSTANCE_NAME`; não aceitam seleção de instância pelo corpo da requisição.

### Pausa da IA e expiração automática

Quando um atendente manda mensagem manualmente pelo número conectado, o cliente manda uma mensagem interativa (botão/lista) ou a IA marca `transferir_humano: true`, a IA para de responder aquele cliente (`Bot.Cliente.iaPausada = true`). Essa pausa não é permanente: se ninguém — nem cliente, nem atendente — mandar mensagem por `PAUSE_EXPIRATION_HOURS` (padrão 12h), a próxima mensagem do cliente já reativa a IA sozinha, sem precisar de intervenção manual. Isso existe porque a compra é recorrente: um cliente não pode voltar dias depois e continuar sem resposta só porque ficou pausado uma vez por qualquer motivo pontual.

### Modo de teste (restringir IA a números específicos)

Defina `TEST_MODE_ALLOWED_NUMBER` (com DDI, ex: `5519978287957`, ou uma lista separada por vírgula, ex: `5519978287957,5511999999999`) para que a IA só responda mensagens recebidas desses números; mensagens de qualquer outro remetente são ignoradas antes de entrar na fila de conversa (não geram resposta nem pausam/alteram estado). Deixe a variável vazia ou removida para atender todos os números normalmente.

## Estrutura de IA

- `src/prompts/camargo_agent_prompt.md`: comportamento, fluxo e contrato de saída;
- `src/rag/knowledge/`: empresa, endereço, horário e políticas comerciais da Camargo (preço e estoque de produtos **não** ficam aqui, vêm da API de produtos);
- `src/projects/camargo/`: schema de resposta e execução de cada turno;
- `src/services/productService.js`: consulta ao catálogo real (preço, unidade, estoque);
- `src/services/orcamentoService.js` + `src/services/gestaoClickService.js`: registram o pedido confirmado como cliente + orçamento no GestãoClick;
- `src/services/pendingOrderService.js`: orçamento apresentado ao cliente, em memória, enquanto aguarda confirmação explícita;
- `src/services/ragService.js`: indexação e busca lexical da base local.

## Endpoints úteis

- `GET /health`: saúde do serviço;
- `POST /webhook/evolution`: webhook principal, protegido por `WEBHOOK_SECRET`;
- `GET /test/rag/status`: estado do índice RAG;
- `POST /test/rag/search`: busca manual na base RAG;
- `POST /test/chat`: testa a IA isoladamente (sem WhatsApp/Evolution API e sem gravar nada no PostgreSQL) — corpo `{ "message": "texto", "history": [{ "role": "user"|"assistant", "content": "..." }] }`, `history` é opcional. Exige só `OPENAI_API_KEY` configurada; `GESTAOCLICK_ACCESS_TOKEN`/`GESTAOCLICK_SECRET_TOKEN` para testar consulta de produtos.

## Teste de integração PostgreSQL

O teste destrói e recria apenas o schema `bot`, por isso exige uma URL cujo nome do banco termine em `_test`:

```bash
TEST_DATABASE_URL=postgresql://usuario:senha@localhost:5432/camargo_test npm run test:postgres
```
