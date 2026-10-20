// Verifica que el token del usuario del sistema de Meta tenga acceso a la Página y a Instagram.
// Uso: node scripts/testMetaPublisher.js   (desde backend/)
// No publica nada y nunca imprime tokens.
import 'dotenv/config';

const {
  META_SYSTEM_USER_TOKEN: token,
  META_PAGE_ID: pageId,
  META_IG_USER_ID: igUserId,
  META_GRAPH_VERSION: version = 'v23.0',
} = process.env;

const graph = async (path, params = {}, accessToken = token) => {
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', accessToken);
  const res = await fetch(url);
  const body = await res.json();
  if (body.error) throw new Error(`${path}: ${body.error.message} (code ${body.error.code})`);
  return body;
};

const ok = (msg) => console.log(`  OK  ${msg}`);
const fail = (msg) => console.log(`  FAIL ${msg}`);

const main = async () => {
  if (!token) return fail('META_SYSTEM_USER_TOKEN está vacío en .env');
  if (!pageId || !igUserId) return fail('Faltan META_PAGE_ID o META_IG_USER_ID en .env');

  let failed = false;
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { failed = true; fail(`${name}: ${e.message}`); }
  };

  await step('Token', async () => {
    const me = await graph('me', { fields: 'id,name' });
    ok(`Token válido: ${me.name} (${me.id})`);
  });

  await step('Permisos', async () => {
    const { data } = await graph('me/permissions');
    const granted = data.filter((p) => p.status === 'granted').map((p) => p.permission);
    const required = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];
    const missing = required.filter((p) => !granted.includes(p));
    if (missing.length) throw new Error(`faltan permisos: ${missing.join(', ')}`);
    ok(`Permisos concedidos: ${required.join(', ')}`);
  });

  let pageToken;
  await step('Página', async () => {
    const page = await graph(pageId, { fields: 'name,access_token,instagram_business_account' });
    pageToken = page.access_token;
    if (!pageToken) throw new Error('no se obtuvo el token de la Página (¿asignaste la Página al usuario del sistema?)');
    ok(`Página: ${page.name} — token de página obtenido`);
    const linkedIg = page.instagram_business_account?.id;
    if (linkedIg !== igUserId) throw new Error(`Instagram vinculado a la Página es ${linkedIg ?? 'ninguno'}, pero META_IG_USER_ID es ${igUserId}`);
    ok(`Instagram vinculado a la Página coincide con META_IG_USER_ID`);
  });

  await step('Instagram', async () => {
    const ig = await graph(igUserId, { fields: 'username,media_count' });
    ok(`Instagram: @${ig.username} (${ig.media_count} publicaciones)`);
    const limit = await graph(`${igUserId}/content_publishing_limit`, { fields: 'quota_usage,config' });
    const info = limit.data?.[0];
    if (info) ok(`Cuota de publicación IG: ${info.quota_usage}/${info.config?.quota_total} en 24 h`);
  });

  console.log(failed ? '\nHay errores: revisa los FAIL de arriba.' : '\nTodo listo para publicar en Facebook e Instagram.');
  process.exitCode = failed ? 1 : 0;
};

main();
