# Meu Mercado — marketplace de supermercados (PWA + Firebase)

App instalável com três áreas — **Cliente**, **Mercado** e **Administração** — em um único `index.html` (HTML/CSS/JS inline, sem build) e Firebase (Authentication, Firestore, Storage, Cloud Functions, Hosting).

> **Leia primeiro — o que esta entrega é e o que não é**
> - Sem configuração, o app abre em **MODO DEMONSTRAÇÃO** (faixa visível no topo): dados fictícios, só no navegador, nenhum pagamento real, nenhum Firebase. É isolado do modo real e some assim que você coloca a configuração do seu projeto.
> - **Nenhum provedor de pagamento foi integrado ou contratado.** O backend tem um contrato pronto (seção 9); enquanto ninguém o implementar, qualquer cobrança é recusada com `PROVIDER_NOT_CONFIGURED`. Pagamento só é confirmado por webhook autenticado — nunca pelo navegador.
> - As Cloud Functions foram testadas com um Firestore **simulado em memória** (seção 11). **Regras de segurança (`firestore.rules`/`storage.rules`) e índices NÃO foram executados contra o emulador oficial** (a instalação das dependências do Firebase não estava disponível no ambiente de construção). Faça os testes da seção 10 no emulador/projeto de teste antes de ir a produção.

---

## 1. Arquivos (todos na raiz, sem subpastas)

| Arquivo | Função |
|---|---|
| `index.html` | O app inteiro (módulos: CONFIG · UTIL · RULES · API real/demo · STATE · UI · ROUTER · VIEWS · PWA · BOOT) |
| `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | PWA |
| `functions.js` | Cloud Functions v2 (região `southamerica-east1`): toda decisão de preço, estoque, pagamento, permissão e estado do pedido |
| `business-rules.js` | Regras puras (centavos): cotação, promoções, cupons, comissão, transições de pedido, agendamento, cobertura, permissões. Uma **cópia exata** fica embutida no `index.html` só para prévia; o servidor sempre recalcula |
| `payment-provider.js` | Camada de pagamento substituível (contrato na seção 9) |
| `firestore.rules`, `storage.rules`, `firestore.indexes.json` | Segurança e índices |
| `firebase.json` | Hosting (rewrites, cabeçalhos de segurança), Functions e emuladores |
| `set-first-admin.js` | Cria o primeiro Administrador Geral com segurança |
| `package.json` | Dependências das Functions e scripts |
| `tests.js`, `tests-functions.js` | Testes (seção 11) |

## 2. Modo demonstração

Abra `index.html` (ou publique) sem alterar a configuração. Na faixa de demonstração há botões para entrar como **Cliente**, **Mercado (Boa Compra)** ou **Administrador**. Há 4 mercados, 31 produtos e pedidos de exemplo. O pagamento Pix tem o botão “Simular confirmação (apenas demo)”, que **não existe** no modo real. Dados somem ao recarregar.

## 3. Configurar o Firebase (modo real)

1. Crie um projeto em <https://console.firebase.google.com>. Funções exigem o plano **Blaze** (pago por uso; há cota gratuita).
2. **Authentication** → Sign-in method → ative **E-mail/senha**. Em Settings → Authorized domains, inclua o domínio onde o app ficará.
3. **Firestore Database** → criar em modo de produção, região `southamerica-east1` (São Paulo).
4. **Storage** → criar (mesma região).
5. Em Configurações do projeto → Seus apps → adicione um app **Web** e copie o objeto `firebaseConfig`.
6. No `index.html`, procure `const MM = {` (módulo CONFIG) e substitua os valores `SUBSTITUIR` de `apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId`. Esses valores **não são segredos** (a proteção está nas regras e nas Functions). Se mudar a região das Functions, ajuste `functionsRegion` e `region` em `functions.js`/`firebase.json`.
7. Instale a CLI e faça login: `npm i -g firebase-tools && firebase login && firebase use --add`.
8. Instale as dependências: `npm install` (na raiz).
9. Defina o segredo do webhook: `firebase functions:secrets:set PAYMENT_WEBHOOK_SECRET`.
10. Publique tudo: `firebase deploy` (ou por partes: `--only firestore:rules,firestore:indexes,storage`, `--only functions`, `--only hosting`). Os índices levam alguns minutos para ficar prontos; consultas que dependem deles falham até lá.
11. Crie o primeiro administrador (seção 5).

Recomendado em produção: **App Check** (reCAPTCHA Enterprise) e `enforceAppCheck: true` nas `OPTS` de `functions.js`; **backups/PITR** do Firestore; alertas de orçamento; revisão de LGPD (base legal, política de privacidade e termos — textos jurídicos não estão incluídos).

## 4. Papéis e permissões

Papéis ficam em *custom claims* gravadas **somente** pelo Admin SDK: `customer`, `market_staff` (+ `marketId`), `platform_admin`, `platform_staff` (+ `perms[]`). Cada Cloud Function confere papel e permissão; as regras do Firestore repetem a verificação. Esconder um botão na tela **não** é proteção.

- **Mercado** (modelos prontos): Gerente, Separador, Expedição, Entregador, Financeiro, Responsável por produtos — ou permissões individuais (pedidos, separação, expedição, entrega, produtos, importação, aprovação de importação, promoções, estoque, configurações, equipe, financeiro, exportação).
- **Administração**: Administrador Geral e equipe com permissões por função (mercados, status, comissão, CRM, catálogo, categorias, cidades, financeiro, repasses, campanhas, suporte, moderação, auditoria, indicadores, configuração).
- Quem convida só concede permissões que **ele mesmo possui**. Convites geram um link para a própria pessoa criar a senha — não existe senha compartilhada.
- Mudanças de permissão têm efeito após renovar o token (o app renova ao reentrar; funções revalidam claims no servidor).

## 5. Primeiro administrador

Nunca é criado pelo navegador nem com senha fixa. Na **sua** máquina (ambiente confiável):

```bash
gcloud auth application-default login          # ou: export GOOGLE_APPLICATION_CREDENTIALS=/caminho/fora-do-repo/chave.json
node set-first-admin.js --project SEU_PROJECT_ID --email voce@empresa.com --name "Seu Nome"
```

O script recusa continuar se já existir um administrador (use `--force` só para recuperação), cria o usuário **sem senha**, grava a claim `platform_admin`, registra na auditoria e imprime um link para você definir a senha. Depois do primeiro acesso, ative a verificação em duas etapas (MFA) no Console do Firebase (Authentication → Sign-in method → Multi-factor). **Nunca** coloque chaves de serviço no repositório.

## 6. Publicar (GitHub e Hosting)

- **Firebase Hosting** (recomendado, pois já inclui reescritas e cabeçalhos de segurança, e o webhook em `/webhooks/payments`): `firebase deploy --only hosting`.
- **GitHub**: crie o repositório, envie todos os arquivos **exceto** `node_modules`, chaves e `.zip`. Para o front-end, o GitHub Pages serve o `index.html` (caminhos são relativos, funciona em subpasta); as Functions e regras continuam sendo publicadas com a CLI do Firebase (ou GitHub Actions com credenciais guardadas em *secrets* — não incluído). Em Pages, as reescritas e cabeçalhos do `firebase.json` não valem: rotas usam `#/` (hash), então funcionam; o webhook de pagamento deve apontar direto para a URL da função `paymentWebhook`.

## 7. Instalar no celular (PWA)

- **Android (Chrome)**: abra o endereço do app → menu ⋮ → **Instalar app** (ou toque em “Instalar” em *Minha conta* quando disponível).
- **iPhone (Safari)**: abra no **Safari** → botão Compartilhar → **Adicionar à Tela de Início**. (Outros navegadores no iOS não instalam PWA.)
- O app exige HTTPS (Hosting já fornece). Há aviso de “nova versão” com botão Atualizar. Dados de pedidos, estoque, pagamento e Firebase **nunca** são guardados em cache offline; sem internet o app mostra o que já carregou e falha de forma explícita nas operações.

## 8. Principais decisões de regra de negócio

- Navegação sem login; **login só no checkout**. **Um mercado por pedido**; carrinhos separados por mercado.
- **Sem reserva ao adicionar ao carrinho.** O estoque é reservado de forma atômica quando o pagamento é iniciado (30 min, configurável 5–120). Estoque do produto = alocado (separado para o app) − reservado − comprometido. Esgotado continua visível.
- Preços e promoções (percentual, preço fixo, leve X pague Y, progressivo, frete grátis acima de valor) são recalculados no servidor; o pedido guarda **fotografia** de preços/descontos/comissão. Se o preço mudou, o cliente revisa antes de pagar — nada é cobrado em silêncio.
- **Comissão** = % do mercado sobre os **produtos efetivamente pagos** (após descontos), **sem** a taxa de entrega; congelada no pedido. Cupons da plataforma são subsídio registrado à parte; o mercado recebe integralmente.
- Pedido pago entra sozinho na fila de separação. Substituição **só com autorização expressa** do cliente; sem resposta no prazo o item é retirado e reembolsado (não há consentimento presumido). Substituto mais caro exige confirmar o valor e pagar a diferença.
- Entrega confirmada por **código de 6 dígitos** que só o cliente vê (e só em “saiu para entrega”); limite de tentativas com bloqueio; uso único.
- Cancelamento: antes da separação é direto com reembolso integral; depois, vira chamado para o suporte (nunca automático).
- Avaliação só de pedido entregue; cliente pode editar (histórico de versões); mercado só **responde**; administração oculta com motivo ou adiciona nota oficial.
- Agendamento até 3 dias úteis respeitando horário, feriados e capacidade. Cobertura por prefixo de CEP, bairro ou raio.
- Combos: cadastrados como **produto-kit** (preço e quantidade próprios). **Não há baixa automática dos itens componentes** (ver pendências).

## 9. Provedor de pagamento (contrato)

Implemente em `payment-provider.js` um objeto com `createCharge`, `getCharge`, `refund` e `verifyWebhook` (assinaturas e formatos documentados no topo do arquivo), registre-o em `PROVIDERS` e defina `PAYMENT_PROVIDER=<nome>`. Requisitos: split entre mercado e plataforma; Pix; débito/crédito **somente por token** do SDK do provedor (dados de cartão nunca passam por este sistema; o app não tem formulário de cartão — as opções de cartão aparecem desabilitadas até existir o gancho `MM.tokenizeCard`); webhook com assinatura em tempo constante e timestamp recente. O servidor não confia no corpo do webhook: consulta `getCharge` antes de confirmar. Eventos são idempotentes (`webhookEvents`) e tolerantes a ordem. Pagamento com valor diferente abre chamado; pagamento tardio sem estoque gera reembolso.
O provedor `sandbox` só existe no emulador (`PAYMENT_PROVIDER=sandbox` **e** `FUNCTIONS_EMULATOR=true`).

## 10. Como testar a segurança (faça no emulador/projeto de teste)

`firebase emulators:start` e use a UI dos emuladores. Todos estes devem **falhar** (permission-denied/rejeitado):

1. Cliente tentando `update` em `orders/{id}` (status, total, `payment.status`), `payments/*`, `reservations/*`, `ledger/*`, `auditLogs/*`.
2. Cliente lendo pedido, endereço, mensagens ou notificações de **outro** cliente; lendo `orders/{id}/secrets/delivery` fora de “saiu para entrega”, ou de pedido que não é dele.
3. Cliente alterando `markets/*/listings/*` (preço/estoque), `marketAdmin/*`, `coupons/*`, `categories/*`.
4. Funcionário do mercado A lendo/escrevendo qualquer coisa do mercado B (pedidos, produtos, equipe, financeiro).
5. Funcionário **sem** a permissão (ex.: separador) chamando funções de preço, promoção, equipe ou financeiro.
6. Qualquer usuário tentando gravar a própria *claim*/papel (`users/{uid}.role`) ou criar documento em `staff`/`marketAdmin`.
7. Funcionário da plataforma sem `commission.write` chamando `adminSetCommission`; sem `finance.payouts` chamando `adminRecordPayout`.
8. Webhook com assinatura errada/ausente (esperado: 401); mesmo evento enviado duas vezes (esperado: “duplicate”, sem efeito duplo).
9. Dois clientes pagando as últimas unidades ao mesmo tempo (esperado: só um passa).
10. Upload de arquivo que não é imagem ou maior que o limite em `Storage`; gravação fora do caminho do próprio mercado.
11. Código de entrega errado 5 vezes (esperado: bloqueio temporário) e reuso do código.
12. Inserir HTML/`<script>` em nome de produto, endereço, chat ou avaliação (esperado: exibido como texto — o app só usa `textContent`).

Os itens 5, 8, 9 e 11 e parte do 1 e 4 também são cobertos por `tests-functions.js`; as **regras** (itens 1–4, 6, 10) só podem ser validadas no emulador/projeto.

## 11. Testes automatizados

```bash
node --test tests.js tests-functions.js     # ou: npm test
```
- `tests.js` (21): regras de negócio — cotação, promoções, comissão, cupons, transições, estoque, agendamento, cobertura, divisão de pagamento.
- `tests-functions.js` (13): Cloud Functions com Firestore/Auth em memória — checkout e idempotência, reserva atômica e disputa por estoque, webhook (assinatura, idempotência), expiração (verificando o provedor antes de cancelar), permissões entre mercados e papéis, separação → expedição → entrega com código, falta de item e substituições, cancelamento e reembolso, comissão sem taxa de entrega. O mock imita regras importantes do Firestore (leituras antes de escritas em transação, `undefined` proibido, transações serializadas). **Não** verifica regras de segurança, índices nem latência.

## 12. Dados e coleções (resumo)

`users/{uid}` (+ `addresses`, `lists`, `notifications`, `couponUses`) · `markets/{id}` (+ `public/settings`, `listings`, `staff`, `imports/rows`, `payouts`, `notifications`, `counters`, `listingHistory`) · `marketAdmin/{id}` (comissão, responsável, histórico — nunca público) · `orders/{id}` (+ `events`, `messages`, `substitutions`, `secrets/delivery`) · `payments`, `reservations`, `ledger`, `idempotency`, `webhookEvents` (somente servidor) · `reviews`, `tickets` (+ `messages`) · `categories`, `categoryRequests`, `globalProducts`, `cities`, `coupons`, `prospects`, `staff`, `departments`, `platform/config`, `auditLogs`. O modelo já prevê entregador/separador (campos `courierId`, fila `picking`, permissões), mas **não há telas dedicadas** ainda.

## 13. Pendências e limitações (declaradas, não escondidas)

- **Pagamento real**: nenhum provedor integrado (seção 9). Cartão desabilitado até haver tokenização. Sem isso, nenhum pedido é cobrado.
- **Combos**: sem baixa automática de estoque dos itens componentes (hoje é um produto-kit independente).
- **WhatsApp**: só cadastro de número/preferências; **nenhum aviso é enviado** (exige contratar a WhatsApp Business Platform).
- **MFA**: recomendado e documentado, mas **sem tela de cadastro** no app (ativação pelo Console do Firebase).
- **Telas de separador e entregador**: não implementadas (o painel do mercado controla todos os estados).
- **Não executado**: regras do Firestore/Storage e índices contra o emulador/projeto real; fluxo com Firebase real (Auth, Storage, Functions publicadas); exportação XLSX/PDF e importação `.xlsx` dependem de bibliotecas carregadas de CDN (SheetJS 0.18.5, jsPDF 2.5.1) e não puderam ser testadas offline — se a CDN falhar, o PDF cai para a impressão do navegador (salvar como PDF); a importação por `.csv` não depende de CDN e funciona normalmente (não há exportação em CSV).
- Textos legais (termos, privacidade/LGPD), notas fiscais e integração com ERPs dos mercados não estão incluídos.
- Notificações são in-app (sem push do navegador).
- Busca por texto usa palavras-chave simples (sem Algolia/Typesense); revise custos de leitura do Firestore ao crescer (paginação já limita listas).
- O app foi verificado no Chromium (Playwright) em largura de celular e desktop; não foi testado em dispositivos iOS/Android reais.
