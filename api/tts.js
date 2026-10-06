// Checks and atomically increments a per-user request count in a sliding
// window, via a Postgres function (so concurrent requests can't race past
// the limit). Fails OPEN on error — a rate-limiter outage should never be
// the thing that breaks the app for legitimate users.
async function checkRateLimit(token, userId, limit, windowSeconds) {
  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/check_and_increment_rate_limit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_user_id: userId, p_limit: limit, p_window_seconds: windowSeconds })
    });
    if (!response.ok) return true;
    return (await response.json()) === true;
  } catch (e) {
    return true;
  }
}

// Serverless function (runs on Vercel). Only speaks the call opener.
// Pro users get Deepgram Aura-2 (better quality, costs per character);
// everyone else gets Google TTS. Pro status is verified server-side
// against Supabase — the client's own claim is never trusted.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const user = await verifySupabaseUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  const withinLimit = await checkRateLimit(token, user.id, 20, 60); // 20/minute
  if (!withinLimit) {
    res.status(429).json({ error: "You're going a bit fast — try again in a moment." });
    return;
  }

  const { text, voiceHint, speakingRate } = req.body || {};

  // The only line the browser ever needs spoken here is the opener.
  // Everything after that comes back as audio from /api/turn.
  if (text !== 'Hello?') {
    res.status(400).json({ error: 'Not allowed.' });
    return;
  }

  const rate = Number(speakingRate);
  const safeRate = Number.isFinite(rate) ? Math.max(0.8, Math.min(1.4, rate)) : 1.02;

  const proCheck = await checkIsPro(token, user.id);

  try {
    if (proCheck.isPro && process.env.DEEPGRAM_API_KEY) {
      try {
        const audioContent = await speakWithDeepgram(text, voiceHint);
        res.status(200).json({ audioContent, provider: 'deepgram', format: 'wav' });
        return;
      } catch (deepgramErr) {
        // Don't break the call for a paying user if Deepgram has a hiccup —
        // fall back to Google. Logged server-side only, never sent to the browser.
        console.error('Deepgram TTS failed, falling back to Google:', deepgramErr.message);
      }
    }

    if (!process.env.GOOGLE_TTS_API_KEY) {
      res.status(500).json({ error: 'Voice service is not configured.' });
      return;
    }
    const audioContent = await speakWithGoogleServer(text, voiceHint, safeRate);
    res.status(200).json({ audioContent, provider: 'google', format: 'mp3' });
  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: 'Could not generate audio.' });
  }
};

async function verifySupabaseUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;

  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_ANON_KEY
      }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    return null;
  }
}

// Reads plan/plan_renews_at/free_access for this user directly from
// Supabase's REST API, using their own token — RLS restricts this to
// exactly their own row, so there's no way to query anyone else's status.
async function checkIsPro(token, userId) {
  if (!token) return { isPro: false };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return { isPro: false };

  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/profiles?select=plan,plan_renews_at,free_access&id=eq.${userId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'apikey': process.env.SUPABASE_ANON_KEY
        }
      }
    );
    if (!response.ok) return { isPro: false };
    const rows = await response.json();
    const row = rows && rows[0];
    if (!row) return { isPro: false };
    if (row.free_access) return { isPro: true };
    if (row.plan === 'pro') return { isPro: true };
    if (row.plan_renews_at && new Date(row.plan_renews_at) > new Date()) return { isPro: true };
    return { isPro: false };
  } catch (e) {
    return { isPro: false };
  }
}

async function speakWithDeepgram(text, voiceHint) {
  const model = voiceHint === 'male' ? 'aura-2-arcas-en' : 'aura-2-asteria-en';
  // WAV (linear16 + container=wav) instead of raw mp3 — WAV's header states
  // the exact byte length up front, which avoids the start/end clipping
  // that raw MP3 streams can suffer when embedded directly as a data URI.
  const response = await fetch(
    `https://api.deepgram.com/v1/speak?model=${model}&encoding=linear16&sample_rate=24000&container=wav`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    }
  );

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Deepgram API ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

async function speakWithGoogleServer(text, voiceHint, speakingRate) {
  const voiceName = voiceHint === 'male' ? 'en-US-Wavenet-D' : 'en-US-Wavenet-F';
  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'en-US', name: voiceName },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: typeof speakingRate === 'number' ? speakingRate : 1.02
        }
      })
    }
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message || 'Google TTS error');
  }

  const data = await response.json();
  if (!data.audioContent) throw new Error('Google TTS returned no audio');
  return data.audioContent;
}
