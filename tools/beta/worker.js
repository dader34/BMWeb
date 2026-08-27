// BMWeb beta report collector -- a Cloudflare Worker in front of a KV
// namespace (R2 needs a dashboard opt-in; KV does not, and a beta's report
// volume sits well inside KV's free tier). POST /report stores a JSON
// report; GET /reports lists them and GET /report?key= fetches one (both
// behind a bearer token).
//
//   wrangler kv namespace create BETA   # id goes into wrangler.toml
//   wrangler secret put TOKEN           # any long random string, for reading
//   wrangler deploy
//
// Then in the app (once, per tester or baked into the build):
//   Settings.set('betaEndpoint', 'https://<worker-url>/report')

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};
const MAX_BYTES = 1_000_000;   // a report with a full wire ring is ~50-200 KB

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (req.method === 'POST' && url.pathname === '/report') {
      const len = Number(req.headers.get('content-length') || 0);
      if (len > MAX_BYTES) return json({ error: 'too large' }, 413);
      const text = await req.text();
      if (text.length > MAX_BYTES) return json({ error: 'too large' }, 413);
      let body;
      try { body = JSON.parse(text); }
      catch { return json({ error: 'not json' }, 400); }
      const day = new Date().toISOString().slice(0, 10);
      const key = `r/${day}/${Date.now()}-`
        + `${(body.tester || 'anon').slice(0, 16)}-`
        + `${crypto.randomUUID().slice(0, 8)}.json`;
      body._received = new Date().toISOString();
      body._country = req.headers.get('cf-ipcountry') || null;
      await env.BETA.put(key, JSON.stringify(body));
      return json({ ok: true, key });
    }

    // reading is yours alone
    const auth = req.headers.get('authorization') || '';
    if (auth !== `Bearer ${env.TOKEN}`) {
      if (url.pathname === '/reports' || url.pathname === '/report') {
        return json({ error: 'unauthorized' }, 401);
      }
      return json({ error: 'not found' }, 404);
    }

    if (req.method === 'GET' && url.pathname === '/reports') {
      const list = await env.BETA.list({
        prefix: url.searchParams.get('prefix') || 'r/',
        cursor: url.searchParams.get('cursor') || undefined,
        limit: 200,
      });
      return json({
        keys: list.keys.map((k) => ({ key: k.name })),
        cursor: list.list_complete ? null : list.cursor,
      });
    }

    if (req.method === 'GET' && url.pathname === '/report') {
      const body = await env.BETA.get(url.searchParams.get('key') || '');
      if (body == null) return json({ error: 'not found' }, 404);
      return new Response(body, {
        headers: { 'content-type': 'application/json', ...CORS },
      });
    }

    return json({ error: 'not found' }, 404);
  },
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}
