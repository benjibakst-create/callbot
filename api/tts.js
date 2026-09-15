const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    res.status(500).json({ error: 'Server is missing SUPABASE_URL / SUPABASE_ANON_KEY.' });
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

const { text, voiceHint, speakingRate } = req.body || {};
  if (!text) {
    res.status(400).json({ error: 'Missing text in request body' });
    return;
  }

  if (!process.env.GOOGLE_TTS_API_KEY) {
    res.status(500).json({ error: 'Server is missing GOOGLE_TTS_API_KEY. Set it in your Vercel project settings.' });
    return;
  }

  const voiceName = voiceHint === 'male' ? 'en-US-Wavenet-D' : 'en-US-Wavenet-F';
  try {
    const response = await fetch(
      
  `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'en-US', name: voiceName },
      audioConfig: { audioEncoding: 'MP3', speakingRate: speakingRate || 1.02 }
    })
  }
);
         

    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json({ error: data.error?.message || 'Google TTS error' });
      return;
    }

    res.status(200).json({ audioContent: data.audioContent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
