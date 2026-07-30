// Cloudflare Pages Function: /api/data
// Simple key-value read/write backed by a Workers KV namespace bound as CLAN_KV.
// GET  /api/data?key=clan-data   -> returns the stored JSON value (or "null")
// POST /api/data?key=clan-data   -> body is the JSON to store under that key

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) {
    return new Response(JSON.stringify({ error: 'missing key' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  if (!env.CLAN_KV) {
    return new Response(JSON.stringify({ error: 'CLAN_KV namespace is not bound to this project yet' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }

  const value = await env.CLAN_KV.get(key);
  return new Response(value ?? 'null', {
    headers: { 'content-type': 'application/json' }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) {
    return new Response(JSON.stringify({ error: 'missing key' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  if (!env.CLAN_KV) {
    return new Response(JSON.stringify({ error: 'CLAN_KV namespace is not bound to this project yet' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }

  const body = await request.text();
  await env.CLAN_KV.put(key, body);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' }
  });
}
