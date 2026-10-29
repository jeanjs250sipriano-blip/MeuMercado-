#!/usr/bin/env node
'use strict';
/**
 * Cria o PRIMEIRO Administrador Geral do Meu Mercado.
 *
 * Roda SOMENTE na máquina de quem administra o projeto Firebase (ambiente confiável),
 * usando credenciais administrativas que NUNCA vão para o navegador nem para o repositório:
 *   - recomendado:  gcloud auth application-default login   (ou)
 *   - alternativa:  export GOOGLE_APPLICATION_CREDENTIALS=/caminho/fora-do-repo/chave.json
 *
 * Uso:
 *   node set-first-admin.js --project SEU_PROJECT_ID --email voce@empresa.com [--name "Seu Nome"]
 *
 * O script:
 *   1) recusa continuar se já existir um Administrador Geral (use --force apenas para recuperação);
 *   2) cria (ou localiza) o usuário no Firebase Authentication SEM definir senha;
 *   3) grava a claim { role: 'platform_admin' } — só o Admin SDK consegue gravar claims;
 *   4) imprime um link para a própria pessoa definir a senha (não há senha universal);
 *   5) registra o ato na trilha de auditoria.
 * Depois do primeiro acesso, ative a autenticação multifator para esta conta.
 */
const admin = require('firebase-admin');

function arg(name) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : null; }
const project = arg('project') || process.env.GCLOUD_PROJECT;
const email = (arg('email') || '').toLowerCase().trim();
const name = arg('name') || 'Administrador Geral';
const force = process.argv.includes('--force');

(async () => {
  if (!project || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Uso: node set-first-admin.js --project SEU_PROJECT_ID --email voce@empresa.com [--name "Seu Nome"]');
    process.exit(1);
  }
  admin.initializeApp({ projectId: project });
  const db = admin.firestore();

  const existing = await db.collection('staff').where('role', '==', 'platform_admin').limit(1).get();
  if (!existing.empty && !force) {
    console.error('Já existe um Administrador Geral. Peça a ele que convide você pelo painel. (Use --force só para recuperação.)');
    process.exit(2);
  }

  let user;
  try { user = await admin.auth().getUserByEmail(email); }
  catch { user = await admin.auth().createUser({ email, displayName: name, emailVerified: false }); }

  await admin.auth().setCustomUserClaims(user.uid, { role: 'platform_admin' });
  await db.collection('staff').doc(user.uid).set({
    name, email, role: 'platform_admin', department: 'Diretoria', active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: 'set-first-admin.js'
  }, { merge: true });
  await db.collection('auditLogs').add({
    at: admin.firestore.FieldValue.serverTimestamp(), actor: 'set-first-admin.js', actorRole: 'operator-local',
    action: 'admin.bootstrap', target: `staff/${user.uid}`, after: { email }, note: force ? 'executado com --force' : null
  });
  const link = await admin.auth().generatePasswordResetLink(email);

  console.log(`\nAdministrador Geral configurado: ${email} (uid ${user.uid})`);
  console.log('\nAbra este link para DEFINIR a sua senha (use-o apenas você; ele expira):\n' + link);
  console.log('\nPróximos passos: entre no app, vá em Administração → ative a autenticação multifator e convide a equipe.');
  process.exit(0);
})().catch((e) => { console.error('Falha:', e.message); process.exit(1); });
