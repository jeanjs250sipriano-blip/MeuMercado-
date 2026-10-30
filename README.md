# Meu Mercado Teste — simulador local

Simulador **independente e 100% local** do marketplace de supermercados "Meu Mercado". Roda inteiro no navegador: sem Firebase, sem servidor, sem e-mail/SMS, sem pagamento real, sem CDN, sem ViaCEP, sem rastreadores. Os dados ficam no **IndexedDB** do seu navegador.

> ⚠️ **Isto é um simulador de testes.** Nada aqui é pedido, venda, cobrança ou entrega reais. Os pagamentos são **fictícios**. A autenticação (usuário + senha simples) **não é segurança adequada para produção**.

## 1. Como abrir e rodar
- É preciso servir os arquivos por HTTP (IndexedDB, service worker e PWA não funcionam bem em `file://`). Na pasta do projeto:
  `python3 -m http.server 8080` e abra `http://localhost:8080/`. Qualquer servidor estático serve.
- Não há build nem `npm install` para usar o app. Node só é necessário para os testes automatizados.
- Navegador moderno (Chrome/Edge/Firefox/Safari recentes) com IndexedDB.

## 2. GitHub Pages
Todos os caminhos são relativos. Basta enviar o conteúdo desta pasta (arquivos na raiz do repositório ou numa subpasta) e ativar Pages. **Cada visitante tem os próprios dados** no próprio navegador — nada é compartilhado. O código não contém senhas, chaves ou credenciais. (Este pacote não foi publicado por mim em nenhum repositório.)

## 3. PWA / offline
`manifest.webmanifest` + `sw.js` guardam o "shell" estático em cache; o app abre offline depois da primeira visita. Os dados nunca passam pelo service worker. Instalável pelo menu do navegador.

## 4. Primeiro acesso: o administrador inicial
O simulador **começa completamente vazio** — sem contas, mercados, produtos ou pedidos de exemplo. A primeira tela exige criar manualmente o administrador (usuário, nome, senha). Depois disso a tela é **bloqueada** para sempre. Reset ou recuperação só por ação explícita do administrador (Admin → *Backup e dados* → *Zerar ambiente*, que exige digitar `APAGAR TUDO`) ou pelo link "Esqueci a senha do administrador" na tela de entrada (que apenas leva ao mesmo reset total confirmado).

## 5. Criando mercados e clientes
- **Admin → Cidades e regras / Categorias**: cadastre ao menos uma cidade e uma categoria.
- **Admin → Mercados → Novo mercado**: cria o mercado e o usuário dono (login + senha simples). Faixas de CEP com ≥ 3 dígitos definem a área de entrega.
- **Admin → Contas e acessos**: cria/ativa/desativa contas (admin, equipe da plataforma, mercado, cliente), redefine senhas (senha temporária mostrada uma vez). O último admin ativo não pode ser desativado.
- **Cliente**: navega sem login; precisa entrar/cadastrar (usuário + senha) apenas no checkout. Um pedido pertence a **um** mercado. Endereços ficam só no navegador (digitação manual; geolocalização opcional e local).
- "Trocar de conta" na barra do simulador alterna entre perfis.

## 6. Produtos e imagens
Painel do mercado → Produtos (catálogo global ou produto local/combo), preços em centavos inteiros, estoque alocado/reservado/comprometido. Imagens são redimensionadas no navegador, deduplicadas por SHA‑256 e guardadas no IndexedDB (entram nos backups). Importação em lote: somente CSV.

## 7. Fluxos para testar
1. Admin: criar cidade, categoria, mercado.
2. Mercado (login do dono): cadastrar produtos, estoque, horários, cupons.
3. Cliente: cadastrar, adicionar endereço, montar carrinho, cupom, checkout → tela do pedido com **painel de pagamento simulado**: *Aprovar*, *Recusar*, *Deixar processando*, *Expirar* (idempotente; histórico de tentativas; recusa mantém a reserva até expirar; reserva padrão 30 min, configurável por mercado).
4. Mercado: separar → expedir → em rota. O cliente vê o **código de entrega de 6 dígitos**; o mercado o digita (tentativas limitadas, bloqueio temporário, uso único).
5. Entregue → cliente confirma (ou contesta dentro da janela; senão conclui automaticamente) → pedido concluído gera crédito/comissão no livro-razão.
6. Admin: Financeiro, Repasses (simulados, idempotentes, com estorno em vez de exclusão), Reembolsos, Auditoria, Verificação de integridade.

Exemplo financeiro (testado): item R$ 100,00, desconto R$ 10,00, frete R$ 8,00, comissão 10% → comissão R$ 9,00, mercado recebe R$ 89,00, cliente paga R$ 98,00. Todo valor é inteiro em centavos; o livro-razão tem ids determinísticos (sem duplicar em reprocessamento).

## 8. Onde os dados ficam
IndexedDB do navegador (`docs`, `blobs`, `meta`). Limpar dados do site, trocar de navegador/aparelho ou usar janela anônima **apaga/isola tudo**. Exporte backups com frequência. Uma aba por vez opera os dados (trava via `navigator.locks`).

## 9. Backup, mesclagem, substituição e reset
Admin → **Backup e dados**:
- **Baixar backup completo**: JSON versionado (`meu-mercado-teste-backup` v1) com metadados, imagens (base64) e **checksum SHA‑256**; senhas só como hash PBKDF2+salt.
- **Importar → Mesclar (padrão)**: mostra resumo antes de aplicar: novos, iguais (ignorados), conflitos (mesmo id, conteúdo diferente → você escolhe *manter local / usar backup / cancelar*, por item ou em bloco), referências ausentes (não inventadas), duplicados financeiros (pedidos, pagamentos, comissões, lançamentos, reembolsos, repasses, movimentos de estoque e confirmações de entrega nunca duplicam). Aplicação atômica.
- **Importar → Substituir tudo**: ação separada, com confirmação, validação prévia e **reversão automática** se falhar.
- **Zerar ambiente**: confirmação digitando `APAGAR TUDO`.
- O arquivo é tratado só como **dado**: nunca se executa código de um backup (parse JSON seguro, chaves `__proto__/constructor/prototype` descartadas, caminhos validados).
- O histórico de backups guarda apenas metadados, não os arquivos.

## 10. Limites de segurança (leia)
- Usuário + senha simples (mín. 4 caracteres) com PBKDF2‑SHA256 + salt e limitação de tentativas. **Não é segurança de produção**: tudo roda no navegador do próprio usuário, que pode inspecionar/alterar o IndexedDB e o código. As verificações de permissão existem nas funções de leitura/escrita do simulador, mas qualquer pessoa com acesso ao navegador pode contorná-las.
- Não use senhas reais. Não use para dados reais de clientes.
- Notificações são internas (sino). Não há push remoto.

## 11. O que foi testado (executado de verdade)
- `npm test` (Node): **52 testes passando** — regras de negócio (`tests.js`, 21), camada de dados (`tests-store.js`, 9), backend/finanças (`tests-backend.js`, 12), backup/mesclagem/substituição/reset (`tests-backup.js`, 10).
- E2E com Chromium/Playwright (`e2e/`, requer Playwright instalado): fluxo completo cliente→mercado→entrega→conclusão→repasse (18 verificações OK: idempotência, reserva/liberação de estoque, código de entrega com bloqueio e uso único, saldo e repasse idempotente, persistência após recarregar); backup exportar/mesclar/substituir/zerar pela interface; criação de usuário de mercado; sem overflow horizontal em 390 px; service worker registrado e shell abrindo offline; zero erros de JS no console.

## 12. Limitações conhecidas (honestas)
- Não foi feito teste manual exaustivo de todas as telas; telas pouco exercitadas nos testes: relatórios com filtros além do financeiro, chamados de suporte do mercado, preferências de notificação, upload de imagem pela tela de edição (o armazenamento de imagens foi testado por API), cupons com escopo/primeira compra pela interface (a regra é testada por Node), importação de arquivo `.xlsx` (removida; só CSV).
- Notificações do navegador (Notification API) não foram implementadas; só o sino interno.
- Funções de separador/entregador têm permissões, mas telas dedicadas não existem (usa-se o painel do mercado).
- Os testes de backup (exemplos A–D) foram executados em Node e parcialmente pela interface (mesclar/substituir/zerar); a restauração a partir da tela inicial vazia foi coberta em Node, não por clique no navegador.
- O teste "não executa código do backup" é fraco (verifica que conteúdo malicioso vira dado inerte).
- Não há emulador de outros navegadores; só Chromium foi usado. Safari/Firefox não testados.
- Cache do IndexedDB é gravado primeiro e a memória atualizada depois (write‑through); em falha de gravação nenhuma alteração parcial é visível (testado com gancho de falha).

## 13. Arquivos
`index.html`, `styles.css`, `app-*.js` (interface), `mm-store.js` (banco local), `mm-idb.js` (IndexedDB/imagens), `mm-auth.js` (contas), `mm-api.js` (política de acesso), `mm-backend.js` (regras de pedido/finanças, adaptado do `functions.js` original), `mm-pay.js` (pagamento fictício), `mm-backup.js`, `business-rules.js`, `sw.js`, `manifest.webmanifest`, ícones, `tests*.js`, `e2e/`.
Removidos desta cópia (específicos do Firebase): `functions.js`, `payment-provider.js`, `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `firebase.json`, `set-first-admin.js`, `tests-functions.js`. O ZIP original **não foi alterado**.
