# Integrar Meu Mercado ao Firebase (multi-celular / multi-navegador)

Com o Firebase ativo, **todos os dispositivos compartilham os mesmos dados** (contas, mercados, produtos, pedidos).

## 1. Criar o projeto no Firebase

1. Acesse https://console.firebase.google.com/
2. **Adicionar projeto** → nome (ex.: `meu-mercado-teste`)
3. Desative Google Analytics se quiser (opcional)
4. No projeto:
   - **Build → Authentication → Get started → Sign-in method → Anonymous → Enable**
   - **Build → Firestore Database → Create database → Start in production mode** (as rules serão publicadas depois) → escolha região (ex.: `southamerica-east1`)

## 2. Registrar o app Web

1. Ícone **Web** (`</>`) → apelido `meumercado-web` → Registrar
2. Copie o objeto `firebaseConfig` (apiKey, authDomain, projectId, etc.)

## 3. Configurar o código

1. No repositório, copie:
   ```bash
   cp firebase-config.example.js firebase-config.js
   ```
2. Cole os valores do console em `firebase-config.js`
3. Mantenha `FIREBASE_ENABLED = true`
4. **Commit do `firebase-config.js`:** a apiKey web é pública por design; proteja o projeto com as **rules** (já incluídas). Não coloque service account no frontend.

## 4. Publicar as rules

Com [Firebase CLI](https://firebase.google.com/docs/cli):

```bash
npm install -g firebase-tools
firebase login
firebase use SEU_PROJECT_ID
firebase deploy --only firestore:rules,storage
```

Ou no Console → Firestore → Rules → cole o conteúdo de `firestore.rules` → Publish.

## 5. Subir o site

### Opção A — GitHub Pages (como você já usa)
- Envie `firebase-config.js`, `mm-firebase.js` e o `index.html` atualizado
- Abra o site no celular A e no celular B

### Opção B — Firebase Hosting
```bash
firebase deploy --only hosting
```

## 6. Testar o fluxo em 2–3 aparelhos

1. Aparelho 1: abra o site → `/configurar` → crie admin (`jeansipiano` / `3003`)
2. Admin → Categorias → **Carregar padrões**
3. Admin → Mercados → crie um mercado **ou** use cadastro “Mercado”
4. Aparelho 2: **mesmo site** → entre com a conta do mercado → cadastre produto (Open Food Facts)
5. Aparelho 3: entre como cliente → veja o produto → faça pedido
6. No aparelho do mercado: veja o pedido aparecer (pode precisar recarregar a lista; watches escutam o Firestore)

## 7. Como saber se está no Firebase

Abra o console do navegador (remoto no celular ou DevTools):

```
[Meu Mercado] Modo Firebase ativo — dados compartilhados entre dispositivos.
```

Se aparecer `Modo local (IndexedDB)`, o `firebase-config.js` não foi carregado ou `FIREBASE_ENABLED` está false.

## 8. Segurança (importante)

As rules atuais permitem **qualquer usuário autenticado (anônimo) ler e escrever** a coleção `mm_docs`.  
Isso é adequado para **teste controlado** (você e poucos celulares).

Para produção pública:
- mover escritas sensíveis para **Cloud Functions** (Admin SDK)
- rules só com leitura filtrada + custom claims (role, marketId)
- desativar Auth anônimo aberto ou restringir por domínio

## 9. Problemas comuns

| Sintoma | Causa | Solução |
|--------|--------|---------|
| Continua local | config não no ar | Confirme que `firebase-config.js` está no GitHub Pages |
| `permission-denied` | rules não publicadas / Auth anônimo off | Enable Anonymous + deploy rules |
| Dados não aparecem no outro celular | cache / outro projectId | Mesmo `projectId` nos dois; force refresh |
| “Já está aberto em outra aba” | modo local | Só no local; no Firebase essa trava não se aplica |

