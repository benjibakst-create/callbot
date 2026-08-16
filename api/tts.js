// Serverless function (runs on Vercel). Calls Google Cloud Text-to-Speech
// and returns base64-encoded MP3 audio. The Google API key stays server-side.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (process.env.APP_PASSWORD) {
    const provided = req.headers['x-app-code'];
    if (provided !== process.env.APP_PASSWORD) {
      res.status(401).json({ error: 'Invalid access code' });
      return;
    }
  }

  const { text, voiceHint } = req.body || {};
  if (!text) {
    res.status(400).json({ error: 'Missing text in request body' });
    return;
  }

  if (!process.env.GOOGLE_TTS_API_KEY) {
    res.status(500).json({ error: 'Server is missing GOOGLE_TTS_API_KEY. Set it in your Vercel project settings.' });
    return;
  }

  // WaveNet voices — natural-sounding and covered by Google's free tier
  // (1M characters/month). Swap these names for other Google voices if
  // you want a different accent or tone; see cloud.google.com/text-to-speech/docs/voices.
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
          audioConfig: { audioEncoding: 'MP3', speakingRate: 1.02 }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json({ error: data.error?.message || 'Google TTS error' });
      return;
    }

    // data.audioContent is already base64-encoded MP3 audio
    res.status(200).json({ audioContent: data.audioContent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
