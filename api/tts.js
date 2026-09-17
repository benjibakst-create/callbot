// Serverless function (runs on Vercel). Routes Pro users to Deepgram
// Aura-2 (better quality, costs money per character) and everyone else to
// Google TTS (free tier). Pro status is verified server-side against
// Supabase — the client's own claim of being Pro is never trusted, so
// there's no way to force Deepgram usage onto a free account.
//
// TEMPORARY: this version includes extra "debug" fields in the JSON
// response so the actual routing decision is visible in the browser's
// Network tab, since Vercel's log viewer has been unreliable to read
// during setup. Safe to strip out once this is confirmed working.
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

  const { text, voiceHint, speakingRate } = req.body || {};
  if (!text) {
    res.status(400).json({ error: 'Missing text in request body' });
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const proCheck = await checkIsPro(token, user.id);

  const debug = {
    userId: user.id,
    isPro: proCheck.isPro,
    proReason: proCheck.reason,
    hasDeepgramKey: !!process.env.DEEPGRAM_API_KEY
  };

  try {
    if (proCheck.isPro && process.env.DEEPGRAM_API_KEY) {
      try {
        const audioContent = await speakWithDeepgram(text, voiceHint);
        res.status(200).json({ audioContent, provider: 'deepgram', debug });
        return;
      } catch (deepgramErr) {
        // Don't let a Deepgram outage/error break the call for a paying
        // user — fall back to Google rather than surfacing an error.
        debug.deepgramError = deepgramErr.message;
      }
    } else {
      debug.skippedDeepgramBecause = !proCheck.isPro ? 'not Pro' : 'no DEEPGRAM_API_KEY';
    }

    if (!process.env.GOOGLE_TTS_API_KEY) {
      res.status(500).json({ error: 'Server is missing GOOGLE_TTS_API_KEY. Set it in your Vercel project settings.', debug });
      return;
    }
    const audioContent = await speakWithGoogleServer(text, voiceHint, speakingRate);
    res.status(200).json({ audioContent, provider: 'google', debug });
  } catch (err) {
    res.status(500).json({ error: err.message, debug });
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
// Returns { isPro, reason } — reason is included for debugging.
async function checkIsPro(token, userId) {
  if (!token) return { isPro: false, reason: 'no token' };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return { isPro: false, reason: 'missing SUPABASE_URL/SUPABASE_ANON_KEY on server' };
  }

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
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { isPro: false, reason: `Supabase query failed: ${response.status} ${body.slice(0,150)}` };
    }
    const rows = await response.json();
    const row = rows && rows[0];
    if (!row) return { isPro: false, reason: 'no profiles row returned for this user' };
    if (row.free_access) return { isPro: true, reason: 'free_access=true' };
    if (row.plan === 'pro') return { isPro: true, reason: "plan='pro'" };
    if (row.plan_renews_at && new Date(row.plan_renews_at) > new Date()) {
      return { isPro: true, reason: 'plan_renews_at in the future' };
    }
    return { isPro: false, reason: `plan='${row.plan}', free_access=${row.free_access}, plan_renews_at=${row.plan_renews_at}` };
  } catch (e) {
    return { isPro: false, reason: 'exception: ' + e.message };
  }
}

async function speakWithDeepgram(text, voiceHint) {
  const model = voiceHint === 'male' ? 'aura-2-arcas-en' : 'aura-2-asteria-en';
  const response = await fetch(
    `https://api.deepgram.com/v1/speak?model=${model}&encoding=mp3`,
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
