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

    if (url.pathname === '/api/gim-rank' && request.method === 'GET') {
      return handleGimRank(request);
    }

    if (url.pathname === '/api/dink' && request.method === 'POST') {
      return handleDinkWebhook(request, env);
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
  return new Response(value ?? 'null', {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
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

  if (key === 'gimrank-data') {
    await notifyRankChange(body, env);
  }

  await env.CLAN_KV.put(key, body);
  return json({ ok: true });
}

/* ---------------- Discord "rank update" announcements ----------------
   Fires whenever the saved GIM rank actually changes — whether from the
   "refresh" button's auto-sync or a manual rank entry, since both save
   through this same gimrank-data key. Uses its own DISCORD_HIGHSCORES_WEBHOOK
   secret. */

async function notifyRankChange(newBodyText, env) {
  if (!env.DISCORD_HIGHSCORES_WEBHOOK) {
    console.log('rank notify: skipped — DISCORD_HIGHSCORES_WEBHOOK secret not set');
    return;
  }

  try {
    const oldRaw = await env.CLAN_KV.get('gimrank-data');
    if (oldRaw === null) {
      console.log('rank notify: skipped — first-ever write to gimrank-data, nothing to diff against');
      return;
    }

    const oldData = JSON.parse(oldRaw);
    const newData = JSON.parse(newBodyText || '{}');
    const oldRank = oldData.gimRank;
    const newRank = newData.gimRank;

    if (typeof oldRank !== 'number') {
      console.log('rank notify: skipped — no previous numeric rank to compare against yet');
      return;
    }
    if (typeof newRank !== 'number' || newRank === oldRank) {
      console.log('rank notify: skipped — rank unchanged');
      return;
    }

    const diff = oldRank - newRank; // positive = improved (lower rank number is better)
    const emoji = diff > 0 ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
    const verb = diff > 0 ? 'climbed' : 'dropped';
    const places = Math.abs(diff);
    const content = emoji + ' **Group rank update:** #' + oldRank.toLocaleString() + ' → #' + newRank.toLocaleString() +
      ' (' + verb + ' ' + places.toLocaleString() + ' place' + (places === 1 ? '' : 's') + ')';

    const res = await fetch(env.DISCORD_HIGHSCORES_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('rank notify: post failed — ' + res.status + ' ' + text);
    } else {
      console.log('rank notify: posted ok');
    }
  } catch (e) {
    console.error('rank notify: failed — ' + e.message);
  }
}

/* ---------------- OSRS hiscores proxy ---------------- */

async function handleHiscores(request) {
  const url = new URL(request.url);
  const player = url.searchParams.get('player');

  if (!player) {
    return json({ ok: false, error: 'Missing player name' }, 400);
  }

  const target = 'https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=' + encodeURIComponent(player);

  try {
    const res = await fetch(target);

    if (!res.ok) {
      const error = res.status === 404
        ? 'Player not found on the hiscores (check spelling, or the account may not have logged in yet)'
        : 'Hiscores request failed (status ' + res.status + ')';
      return json({ ok: false, error });
    }

    // JSON variant names every skill/activity, so callers match by name
    // instead of by row position (which shifts whenever Jagex adds a boss)
    const data = await res.json();
    return json({ ok: true, data });
  } catch (e) {
    return json({ ok: false, error: 'Could not reach the OSRS hiscores service' });
  }
}

/* ---------------- Group Ironman rank (best-effort — Jagex's leaderboard
   page has bot protection and no official JSON API for this, so this is a
   fragile HTML scrape. If it stops working, that's why. ---------------- */

async function handleGimRank(request) {
  const url = new URL(request.url);
  const groupName = url.searchParams.get('group') || 'lostboysclan';
  const target = 'https://secure.runescape.com/m=hiscore_oldschool_ironman/group-ironman/?groupName=' + encodeURIComponent(groupName);

  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (!res.ok) {
      return json({ ok: false, error: 'blocked_or_unavailable', status: res.status });
    }

    const html = await res.text();
    const escaped = groupName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rowRe = new RegExp('<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?' + escaped + '(?:(?!</tr>)[\\s\\S])*?</tr>', 'i');
    const rowMatch = html.match(rowRe);

    if (!rowMatch) {
      // Return a small debug snippet so we can see what the page actually looks like if this fails
      return json({ ok: false, error: 'group_not_found', debugSnippet: html.slice(0, 800) });
    }

    const numMatch = rowMatch[0].match(/>\s*([\d,]+)\s*</);
    if (!numMatch) {
      return json({ ok: false, error: 'rank_not_parsed', debugRow: rowMatch[0].slice(0, 800) });
    }

    const rank = parseInt(numMatch[1].replace(/,/g, ''), 10);
    return json({ ok: true, rank });
  } catch (e) {
    return json({ ok: false, error: 'fetch_failed' });
  }
}

/* ---------------- Dink (RuneLite) webhook ingest ----------------
   Dink can send its notifications to multiple webhook URLs at once,
   so this can sit alongside your existing Discord webhook rather than
   replacing it. Dink's payload is Discord-shaped (content/embeds) plus
   a structured "extra" object per event type — we store the raw event
   and pull out a best-effort summary for the site to render later. */

const DINK_FEED_KEY = 'dink-feed';
const DINK_FEED_MAX = 200;

async function handleDinkWebhook(request, env) {
  if (!env.CLAN_KV) {
    return json({ error: 'CLAN_KV namespace is not bound to this project yet' }, 500);
  }

  let payload;
  try {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const raw = form.get('payload_json');
      payload = raw ? JSON.parse(raw) : {};
    } else {
      payload = await request.json();
    }
  } catch (e) {
    return json({ ok: false, error: 'could not parse dink payload' }, 400);
  }

  const embed = (payload.embeds && payload.embeds[0]) || {};
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    type: payload.type || 'UNKNOWN',
    player: payload.playerName || (payload.extra && payload.extra.playerName) || null,
    title: embed.title || payload.content || null,
    description: embed.description || null,
    thumbnail: (embed.thumbnail && embed.thumbnail.url) || null,
    extra: payload.extra || null
  };

  const existing = (await env.CLAN_KV.get(DINK_FEED_KEY, { type: 'json' })) || [];
  existing.unshift(entry);
  await env.CLAN_KV.put(DINK_FEED_KEY, JSON.stringify(existing.slice(0, DINK_FEED_MAX)));

  return json({ ok: true });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json' }
  });
}
