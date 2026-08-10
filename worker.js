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

    if (url.pathname === '/api/verify-gear-pw' && request.method === 'POST') {
      return handleVerifyGearPassword(request, env);
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

  if (key === 'clan-events') {
    await notifyNewEvents(body, env);
  }

  if (key === 'clan-availability') {
    await notifyNewAvailability(body, env);
  }

  if (key === 'gear-edit-lock') {
    // short-lived advisory lock — expires on its own if the editor's tab
    // closes or goes idle, instead of needing an explicit "release" call
    await env.CLAN_KV.put(key, body, { expirationTtl: 120 });
    return json({ ok: true });
  }

  await env.CLAN_KV.put(key, body);
  return json({ ok: true });
}

/* ---------------- Gear-edit password gate ----------------
   A shared passphrase to stop accidental edits on Gear Progression, not a
   real auth system — the whole app is an unauthenticated shared link, so
   this only guards against fat-fingering, not a determined attacker. The
   password itself is kept out of the public repo via a Worker secret. */

async function handleVerifyGearPassword(request, env) {
  if (!env.GEAR_EDIT_PASSWORD) {
    return json({ ok: false, error: 'not_configured' }, 200);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  const match = typeof body.password === 'string' && body.password === env.GEAR_EDIT_PASSWORD;
  return json({ ok: match });
}

/* ---------------- Discord "new event" announcements ----------------
   Diffs the incoming calendar events against what's already in KV and
   pings Discord only for genuinely new events (not edits or deletes),
   so this doesn't fire during the old-blob migration or on every save.
   Needs a DISCORD_EVENTS_WEBHOOK secret set on the Worker — without it,
   this is a silent no-op and saving events still works normally. */

async function notifyNewEvents(newBodyText, env) {
  if (!env.DISCORD_EVENTS_WEBHOOK) {
    console.log('discord notify: skipped — DISCORD_EVENTS_WEBHOOK secret not set');
    return;
  }

  try {
    const oldRaw = await env.CLAN_KV.get('clan-events');
    if (oldRaw === null) {
      console.log('discord notify: skipped — first-ever write to clan-events, nothing to diff against');
      return;
    }

    const oldEvents = JSON.parse(oldRaw);
    const newEvents = JSON.parse(newBodyText || '[]');
    const oldIds = new Set(oldEvents.map(e => e.id));
    const added = newEvents.filter(e => !oldIds.has(e.id));
    console.log('discord notify: ' + added.length + ' new event(s) found out of ' + newEvents.length + ' total');

    for (const evt of added) {
      await postDiscordEventNotice(evt, env);
    }
  } catch (e) {
    console.error('discord notify: failed — ' + e.message);
  }
}

async function postDiscordEventNotice(evt, env) {
  const lines = [
    '@everyone :calendar_spiral: **New event added: ' + (evt.title || 'Untitled') + '**',
    (evt.date || '') + (evt.time ? ' at ' + evt.time + ' (BST)' : '')
  ];
  if (evt.attendees && evt.attendees.length) lines.push("Who's in: " + evt.attendees.join(', '));
  if (evt.notes) lines.push(evt.notes);

  try {
    const res = await fetch(env.DISCORD_EVENTS_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('discord notify: webhook post failed — ' + res.status + ' ' + text);
    } else {
      console.log('discord notify: posted event "' + evt.title + '" ok');
    }
  } catch (e) {
    console.error('discord notify: webhook fetch failed — ' + e.message);
  }
}

/* ---------------- Discord "new availability" announcements ----------------
   Same diff-and-notify shape as new events, so people find out when a
   teammate marks themselves free without having to check the site.
   Also needs DISCORD_EVENTS_WEBHOOK — reuses the same webhook/channel
   as event announcements rather than a separate one. */

async function notifyNewAvailability(newBodyText, env) {
  if (!env.DISCORD_EVENTS_WEBHOOK) {
    console.log('discord notify: availability skipped — DISCORD_EVENTS_WEBHOOK secret not set');
    return;
  }

  let added = [];
  try {
    const oldRaw = await env.CLAN_KV.get('clan-availability');
    if (oldRaw === null) {
      console.log('discord notify: skipped — first-ever write to clan-availability, nothing to diff against');
      return;
    }

    const oldEntries = JSON.parse(oldRaw);
    const newEntries = JSON.parse(newBodyText || '[]');
    const oldIds = new Set(oldEntries.map(a => a.id));
    added = newEntries.filter(a => !oldIds.has(a.id));
    console.log('discord notify: ' + added.length + ' new availability entr' + (added.length===1?'y':'ies') + ' found');
  } catch (e) {
    console.error('discord notify: availability diff failed — ' + e.message);
    return;
  }
  if (!added.length) return;

  let playerNames = {};
  try {
    const playersRaw = await env.CLAN_KV.get('players-data');
    const playersData = playersRaw ? JSON.parse(playersRaw) : null;
    ((playersData && playersData.players) || []).forEach(p => {
      playerNames[p.id] = (p.rsn || 'Someone').replace(/^GIM\s*/i, '');
    });
  } catch (e) {
    // best-effort — entries just fall back to "Someone" below
  }

  for (const a of added) {
    await postDiscordAvailabilityNotice(a, playerNames[a.pid] || 'Someone', env);
  }
}

async function postDiscordAvailabilityNotice(a, name, env) {
  const dateLabel = formatDiscordDate(a.date);
  const content = '@everyone :clock3: **' + name + '** is free ' + dateLabel + ' — ' + a.start + '–' + a.end + ' (BST)';

  try {
    const res = await fetch(env.DISCORD_EVENTS_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('discord notify: availability webhook post failed — ' + res.status + ' ' + text);
    } else {
      console.log('discord notify: posted availability for "' + name + '" ok');
    }
  } catch (e) {
    console.error('discord notify: availability webhook fetch failed — ' + e.message);
  }
}

function formatDiscordDate(dateStr) {
  try {
    return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  } catch (e) {
    return dateStr;
  }
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
