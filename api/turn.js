// Serverless function (runs on Vercel). Combines the prospect's next line
// (Claude) and its spoken audio (Deepgram/Google) into a single request —
// cuts one full network round trip off every turn versus calling
// /api/prospect-turn then /api/tts separately.
//
// To avoid the overhead of base64-encoding audio into JSON, the small
// structured fields (speech text, patience change, hangup/won) travel as
// response headers, and the raw audio bytes are the response body directly.
// On success: status 200, headers carry metadata, body is the audio file.
// On failure: status 4xx/5xx, a normal JSON { error } body (no headers/audio).
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

  let result;
  const t0 = Date.now();
  try {
    result = await callClaudeTool({ system, messages, maxTokens: 500, tool });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
    return;
  }
  const claudeMs = Date.now() - t0;

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const proCheck = await checkIsPro(token, user.id);

  let audioBuffer, format, provider;
  const t1 = Date.now();
  try {
    if (proCheck.isPro && process.env.DEEPGRAM_API_KEY) {
      try {
        audioBuffer = await speakWithDeepgram(result.speech, voiceHint);
        format = 'wav';
        provider = 'deepgram';
      } catch (deepgramErr) {
        console.error('Deepgram TTS failed, falling back to Google:', deepgramErr.message);
      }
    }
    if (!audioBuffer) {
      if (!process.env.GOOGLE_TTS_API_KEY) {
        res.status(500).json({ error: 'Server is missing GOOGLE_TTS_API_KEY.' });
        return;
      }
      audioBuffer = await speakWithGoogleServer(result.speech, voiceHint, speakingRate);
      format = 'mp3';
      provider = 'google';
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
    return;
  }
  const ttsMs = Date.now() - t1;

  res.setHeader('X-Speech', encodeURIComponent(result.speech));
  res.setHeader('X-Patience-Delta', String(result.patience_delta || 0));
  res.setHeader('X-Hangup', result.hangup ? 'true' : 'false');
  res.setHeader('X-Won', result.won ? 'true' : 'false');
  res.setHeader('X-Provider', provider);
  res.setHeader('X-Format', format);
  // Temporary: timing breakdown so we can see where time is actually going,
  // visible in the browser's Network tab under Response Headers.
  res.setHeader('X-Timing-Claude-Ms', String(claudeMs));
  res.setHeader('X-Timing-TTS-Ms', String(ttsMs));
  res.setHeader('X-Timing-Total-Ms', String(Date.now() - t0));
  res.setHeader('Content-Type', format === 'wav' ? 'audio/wav' : 'audio/mpeg');
  res.status(200).send(audioBuffer);
};

async function verifySupabaseUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_ANON_KEY }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    return null;
  }
}

async function checkIsPro(token, userId) {
  if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return { isPro: false };
  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/profiles?select=plan,plan_renews_at,free_access&id=eq.${userId}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_ANON_KEY } }
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
    if (toolBlock && toolBlock.input) return toolBlock.input;
    lastError = 'Model did not return a structured reply.';
  }
  throw { status: 502, message: lastError };
}

async function speakWithDeepgram(text, voiceHint) {
  const model = voiceHint === 'male' ? 'aura-2-arcas-en' : 'aura-2-asteria-en';
  const response = await fetch(
    `https://api.deepgram.com/v1/speak?model=${model}&encoding=linear16&sample_rate=24000&container=wav`,
    {
      method: 'POST',
      headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    }
  );
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Deepgram API ${response.status}: ${errBody.slice(0, 200)}`);
  }
  return Buffer.from(await response.arrayBuffer());
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
        audioConfig: { audioEncoding: 'MP3', speakingRate: typeof speakingRate === 'number' ? speakingRate : 1.02 }
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
