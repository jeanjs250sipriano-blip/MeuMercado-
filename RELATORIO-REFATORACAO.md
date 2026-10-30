# Relatório de refatoração — Meu Mercado Teste

## Arquitetura atual (auditoria)

- **Frontend:** HTML5 + JS modular (sem bundler), PWA (`sw.js` + manifest).
- **Backend:** `mm-backend.js` — regras de negócio locais (padrão Cloud Functions / `onCall`).
- **Persistência:** IndexedDB via `mm-idb.js` / `mm-store.js` (**100% local neste navegador**).
- **Auth:** `mm-auth.js` — usuário + PIN, hash PBKDF2, rate-limit de tentativas.
- **Pagamento:** simulado (`mm-pay.js`).

### Banco centralizado online

A camada de dados já espelha a API do Firestore (coleções, `onCall`, permissões).  
**Nesta entrega o app continua local** (cada navegador tem seus dados).  
Para multi-dispositivo real é necessário provisionar Firebase/Firestore (ou outro backend) e apontar os adaptadores — as regras de negócio em `mm-backend.js` foram pensadas para essa migração.

## O que foi implementado nesta etapa

1. **Entrega com código → conclusão imediata**  
   Validação do código pelo entregador/mercado grava `delivered` + `completed` na mesma operação. Sem segunda confirmação do cliente. Reclamação/suporte continua possível após conclusão.

2. **Categorias globais (20 + subcategorias)**  
   Seed idempotente (`adminSeedDefaultCategories`) com a árvore completa do prompt (Hortifruti… Naturais) + aliases legados. Botão “Carregar padrões” no admin.

3. **Catálogo Global alimentado pela API**  
   `marketEnsureGlobalProduct`: ao cadastrar via OFF, cria/reutiliza produto global (sem preço/estoque) e a oferta do mercado fica vinculada (`globalProductId`).

4. **Pesquisa de produtos aprimorada**  
   - Ordem: Catálogo Global → Open Food Facts BR → world → Open Products / Beauty / Pet Facts  
   - Variantes de termo, normalização de espaços/unidades  
   - Busca só com **Enter** ou botão **Buscar** (sem spam por tecla)  
   - Mapeamento automático de categoria (arroz → Mercearia básica/Arroz, refrigerante → Bebidas, etc.)  
   - Imagem, marca, código e peso importados

5. **Login simplificado**  
   - PIN de 4 dígitos  
   - Cadastro público: **Cliente** ou **Mercado** (sem opção admin)  
   - Perfil detectado automaticamente no login  
   - Setup inicial pré-preenchido: `jeansipiano` / `3003` (Jean Sipiano)

6. **Indicador de demo discreto**  
   Faixa amarela grande substituída por linha discreta.

## Preservado

- Fluxos de pedido, carrinho, checkout, importação CSV, promoções, CRM, suporte, backup/restore, testes e2e/unitários.
- Isolamento de ofertas (preço/estoque por mercado).
- Snapshots de itens no pedido.

## Como executar

```bash
python3 -m http.server 8080
# abrir http://localhost:8080/
```

1. Tela `/configurar` → criar admin (sugerido jeansipiano / 3003).  
2. Admin → Categorias → “Carregar padrões” (ou seed automático no setup).  
3. Admin → Mercados → criar mercado **ou** cadastro público “Mercado”.  
4. Painel do mercado → Produtos → Novo → Open Food Facts.

## Arquivos alterados

- `mm-backend.js` — entrega, categorias, ensure global, publicSignUpMarket  
- `app-market.js` — busca multi-fonte, catálogo global, mapeamento  
- `app-checkout.js` — login PIN, cadastro, setup admin  
- `app-shell.js` + `styles.css` — demo bar  
- `app-admin.js` — seed categorias  
- `app-core.js` — emojis  
- `mm-auth.js` — mensagem de senha  

## Limitações conscientes

- **Sem Firebase configurado:** dados não são compartilhados entre dispositivos.  
- CRM/suporte/notificações já existiam; evoluções profundas ficam para próxima etapa.  
- Integração ERP e WhatsApp: arquitetura preparada, não implementada nesta etapa.
