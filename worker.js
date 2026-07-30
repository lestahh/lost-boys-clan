export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/data') {
      if (request.method === 'GET')  return handleDataGet(request, env);
      if (request.method === 'POST') return handleDataPost(request, env);
    }

    if (url.pathname === '/api/hiscores' && request.method === 'GET') {
      return handleHiscores(request);
    }

    // everything else falls through to the static site (index.html, etc.)
    return env.ASSETS.fetch(request);
  }
};

/* ---------------- KV-backed key/value storage ---------------- */

async function handleDataGet(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) {
    return json({ error: 'missing key' }, 400);
  }
  if (!env.CLAN_KV) {
    return json({ error: 'CLAN_KV namespace is not bound to this project yet' }, 500);
  }

  const value = await env.CLAN_KV.get(key);
  return new Response(value ?? 'null', { headers: { 'content-type': 'application/json' } });
}

async function handleDataPost(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) {
    return json({ error: 'missing key' }, 400);
  }
  if (!env.CLAN_KV) {
    return json({ error: 'CLAN_KV namespace is not bound to this project yet' }, 500);
  }

  const body = await request.text();
  await env.CLAN_KV.put(key, body);
  return json({ ok: true });
}

/* ---------------- OSRS hiscores proxy ---------------- */

async function handleHiscores(request) {
  const url = new URL(request.url);
  const player = url.searchParams.get('player');

  if (!player) {
    return json({ ok: false, error: 'Missing player name' }, 400);
  }

  const target = 'https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=' + encodeURIComponent(player);

  try {
    const res = await fetch(target);

    if (!res.ok) {
      const error = res.status === 404
        ? 'Player not found on the hiscores (check spelling, or the account may not have logged in yet)'
        : 'Hiscores request failed (status ' + res.status + ')';
      return json({ ok: false, error });
    }

    const raw = await res.text();
    return json({ ok: true, raw });
  } catch (e) {
    return json({ ok: false, error: 'Could not reach the OSRS hiscores service' });
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json' }
  });
}
