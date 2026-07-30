// Cloudflare Pages Function: /api/hiscores
// Proxies the official OSRS hiscores lite endpoint server-side, since Jagex's
// API blocks direct browser (CORS) requests. Returns the raw CSV so the
// front end can parse it (skill order is stable and well documented).

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const player = url.searchParams.get('player');

  if (!player) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing player name' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const target = 'https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=' + encodeURIComponent(player);

  try {
    const res = await fetch(target);

    if (!res.ok) {
      const error = res.status === 404
        ? 'Player not found on the hiscores (check spelling, or the account may not have logged in yet)'
        : 'Hiscores request failed (status ' + res.status + ')';
      return new Response(JSON.stringify({ ok: false, error }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    const raw = await res.text();
    return new Response(JSON.stringify({ ok: true, raw }), {
      headers: { 'content-type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'Could not reach the OSRS hiscores service' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
}
