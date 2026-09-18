// Serverless function (Vercel, Node runtime). Two-phase design to cut
// perceived latency without giving up forced-JSON reliability:
//
//   phase: 'opener'   -> Claude generates ONLY the prospect's first
//                        reaction line (small maxTokens = fast),
//                        synthesized to audio and returned immediately
//                        so the user hears something in well under a
//                        second.
//   phase: 'continue' -> Claude generates whatever comes AFTER the
//                        opener (can be empty) plus patience/hangup/won,
//                        synthesized to audio and returned separately.
//
// The frontend calls 'opener' first, plays that audio right away, and
// fires 'continue' immediately after (NOT waiting for opener playback
// to finish) so the two Claude calls + two TTS calls happen back to
// back instead of one big call chain blocking all the way through.
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

  const { phase, system, messages, opener, voiceHint, speakingRate } = req.body || {};
  if (!phase || !system || !messages) {
    res.status(400).json({ error: 'Missing phase, system, or messages in request body' });
    return;
  }
  if (phase !== 'opener' && phase !== 'continue') {
    res.status(400).json({ error: "phase must be 'opener' or 'continue'" });
    return;
  }
  if (phase === 'continue' && typeof opener !== 'string') {
    res.status(400).json({ error: "phase 'continue' requires the 'opener' text from the previous call" });
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const proCheck = await checkIsPro(token, user.id);

  const t0 = Date.now();
  let result;
  try {
    result = phase === 'opener'
      ? await getOpener({ system, messages })
      : await getContinuation({ system, messages, opener });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
    return;
  }
  const claudeMs = Date.now() - t0;

  const textToSpeak = phase === 'opener' ? result.opener : result.continuation;

  // Continuation can legitimately be empty (opener said it all) — skip
  // TTS entirely rather than synthesizing silence.
  if (phase === 'continue' && !textToSpeak) {
    res.setHeader('X-Speech', '');
    res.setHeader('X-Empty', 'true');
    res.setHeader('X-Patience-Delta', String(result.patience_delta || 0));
    res.setHeader('X-Hangup', result.hangup ? 'true' : 'false');
    res.setHeader('X-Won', result.won ? 'true' : 'false');
    res.setHeader('X-Timing-Claude-Ms', String(claudeMs));
    res.setHeader('X-Timing-Tts-Ms', '0');
    res.setHeader('X-Timing-Total-Ms', String(Date.now() - t0));
    res.status(200).send(Buffer.alloc(0));
    return;
  }

  let audioBuffer, format, provider;
  const t1 = Date.now();
  try {
    if (proCheck.isPro && process.env.DEEPGRAM_API_KEY) {
      try {
        audioBuffer = await speakWithDeepgram(textToSpeak, voiceHint);
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
      audioBuffer = await speakWithGoogleServer(textToSpeak, voiceHint, speakingRate);
      format = 'mp3';
      provider = 'google';
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
    return;
  }
  const ttsMs = Date.now() - t1;

  res.setHeader('X-Speech', encodeURIComponent(textToSpeak));
  res.setHeader('X-Empty', 'false');
  if (phase === 'continue') {
    res.setHeader('X-Patience-Delta', String(result.patience_delta || 0));
    res.setHeader('X-Hangup', result.hangup ? 'true' : 'false');
    res.setHeader('X-Won', result.won ? 'true' : 'false');
  }
  res.setHeader('X-Provider', provider);
  res.setHeader('X-Format', format);
  res.setHeader('X-Timing-Claude-Ms', String(claudeMs));
  res.setHeader('X-Timing-Tts-Ms', String(ttsMs));
  res.setHeader('X-Timing-Total-Ms', String(Date.now() - t0));
  res.setHeader('Content-Type', format === 'wav' ? 'audio/wav' : 'audio/mpeg');
  res.status(200).send(audioBuffer);
};

async function getOpener({ system, messages }) {
  const tool = {
    name: 'opening_line',
    description: "The prospect's very first spoken reaction, as fast and short as possible.",
    input_schema: {
      type: 'object',
      properties: {
        opener: { type: 'string', description: 'ONE short natural spoken sentence — just the immediate gut reaction, not the full response.' }
      },
      required: ['opener']
    }
  };
  const openerSystem = `${system}

Give ONLY the prospect's immediate, gut-reaction opening line (one short sentence). Don't resolve the whole exchange yet — a fuller continuation will be requested separately right after.`;
  return callClaudeTool({ system: openerSystem, messages, maxTokens: 100, tool });
}

async function getContinuation({ system, messages, opener }) {
  const tool = {
    name: 'continue_turn',
    description: 'What the prospect says right after their opening line (can be empty), plus how the call state changes.',
    input_schema: {
      type: 'object',
      properties: {
        continuation: { type: 'string', description: 'What the prospect says immediately after their opener, 0-2 short natural spoken sentences. Empty string if the opener already fully covered their reaction.' },
        patience_delta: { type: 'integer', description: 'How much the patience score changes this turn, from -25 to 15.' },
        hangup: { type: 'boolean', description: 'True if the prospect hangs up on this turn.' },
        won: { type: 'boolean', description: 'True if the prospect agrees to a next step (meeting, demo, callback) on this turn.' }
      },
      required: ['continuation', 'patience_delta', 'hangup', 'won']
    }
  };
  const continueSystem = `${system}

The prospect has already said this opening line out loud: "${opener}"
Now provide whatever comes next (can be nothing) plus the turn's metadata.`;
  return callClaudeTool({ system: continueSystem, messages, maxTokens: 400, tool });
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
