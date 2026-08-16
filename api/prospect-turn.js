// Serverless function (runs on Vercel). Keeps the Anthropic API key on the
// server — it is never sent to the browser.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Optional access-code gate. Set APP_PASSWORD in your Vercel project's
  // environment variables to require it. If APP_PASSWORD is not set, this
  // check is skipped and the app is open to anyone with the URL.
  if (process.env.APP_PASSWORD) {
    const provided = req.headers['x-app-code'];
    if (provided !== process.env.APP_PASSWORD) {
      res.status(401).json({ error: 'Invalid access code' });
      return;
    }
  }

  const { system, messages } = req.body || {};
  if (!system || !messages) {
    res.status(400).json({ error: 'Missing system or messages in request body' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in your Vercel project settings.' });
    return;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 500,
        system,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
      return;
    }

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();

    const parsed = extractJSON(clean);
    if (!parsed) {
      res.status(502).json({ error: 'Model did not return valid JSON: ' + clean.slice(0, 200) });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Tries a direct parse first; if that fails (e.g. the model added stray
// text around the JSON), falls back to grabbing the outermost {...} block.
function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (e2) {
      return null;
    }
  }
}
