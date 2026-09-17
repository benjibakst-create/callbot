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

  const { system, messages, voiceHint, speakingRate } = req.body || {};
  if (!system || !messages) {
    res.status(400).json({ error: 'Missing system or messages in request body' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in your Vercel project settings.' });
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  // 1) Ask Claude what the prospect says and how the call state changes.
  let parsed;
  try {
    const tool = {
      name: 'prospect_turn',
      description: "The prospect's next spoken line and how the call state changes as a result.",
      input_schema: {
        type: 'object',
        properties: {
          speech: { type: 'string', description: 'What the prospect says out loud, 1-3 short natural spoken sentences.' },
          patience_delta: { type: 'integer', description: 'How much the patience score changes this turn, from -25 to 15.' },
          hangup: { type: 'boolean', description: 'True if the prospect hangs up on this turn.' },
          won: { type: 'boolean', description: 'True if the prospect agrees to a next step (meeting, demo, callback) on this turn.' }
        },
        required: ['speech', 'patience_delta', 'hangup', 'won']
      }
    };
    parsed = await callClaudeTool({ system, messages, maxTokens: 500, tool });
  } catch (err) {
    console.error('turn.js: Claude call failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'Unknown server error calling Claude' });
    return;
  }

  // 2) Figure out which TTS provider this user gets (same Pro check as tts.js).
  const proCheck = await checkIsPro(token, user.id);

  // 3) The structured fields ride as headers; the audio is the raw response
  //    body. No JSON wrapper, no base64, one round trip total for this turn.
  res.setHeader('X-Speech', encodeURIComponent(parsed.speech || ''));
  res.setHeader('X-Patience-Delta', String(parsed.patience_delta ?? 0));
  res.setHeader('X-Hangup', String(!!parsed.hangup));
  res.setHeader('X-Won', String(!!parsed.won));
  res.setHeader('X-TTS-Is-Pro', String(proCheck.isPro));
  res.setHeader('X-TTS-Pro-Reason', proCheck.reason);
  res.setHeader('X-TTS-Has-Deepgram-Key', String(!!process.env.DEEPGRAM_API_KEY));

  try {
    if (proCheck.isPro && process.env.DEEPGRAM_API_KEY) {
      try {
        const audioBuffer = await speakWithDeepgram(parsed.speech, voiceHint);
        res.setHeader('X-TTS-Provider', 'deepgram');
        res.setHeader('X-Format', 'wav');
        res.setHeader('Content-Type', 'audio/wav');
        res.status(200).send(audioBuffer);
        return;
      } catch (deepgramErr) {
        // Don't let a Deepgram outage/error break the call for a paying
        // user - fall back to Google rather than surfacing an error.
        res.setHeader('X-TTS-Deepgram-Error', deepgramErr.message.slice(0, 200));
      }
    } else {
      res.setHeader('X-TTS-Skipped-Deepgram-Because', !proCheck.isPro ? 'not Pro' : 'no DEEPGRAM_API_KEY');
    }

    if (!process.env.GOOGLE_TTS_API_KEY) {
      res.status(500).json({ error: 'Server is missing GOOGLE_TTS_API_KEY. Set it in your Vercel project settings.' });
      return;
    }
    const audioBuffer = await speakWithGoogleServer(parsed.speech, voiceHint, speakingRate);
    res.setHeader('X-TTS-Provider', 'google');
    res.setHeader('X-Format', 'mp3');
    res.setHeader('Content-Type', 'audio/mp3');
    res.status(200).send(audioBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ---------- Claude (from prospect-turn.js) ----------
async function callClaudeTool({ system, messages, maxTokens, tool }) {
  let lastError = 'no response';
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: maxTokens,
        system,
        messages,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name }
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw { status: response.status, message: data.error?.message || 'Anthropic API error' };
    }
    const toolBlock = (data.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
    if (toolBlock && toolBlock.input) {
      return toolBlock.input;
    }
    lastError = 'Model did not return a structured reply.';
  }
  throw { status: 502, message: lastError };
}

// ---------- Auth + Pro check + TTS (from tts.js) ----------
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
  return Buffer.from(arrayBuffer);
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
  return Buffer.from(data.audioContent, 'base64');
}
