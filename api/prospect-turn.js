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
    const parsed = await callClaudeForJSON({ system, messages, maxTokens: 500 });
    res.status(200).json(parsed);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};

const JSON_INSTRUCTION = "\n\nCRITICAL FORMATTING RULE: Output ONLY the raw JSON object — no markdown, no code fences, no explanation before or after it. The JSON must be syntactically valid: double-quote every key and string value, escape any double quotes or apostrophes that appear inside the \"speech\" text properly, and never include a trailing comma.";

async function callClaudeForJSON({ system, messages, maxTokens }) {
  const fullSystem = system + JSON_INSTRUCTION;
  let lastRawText = '';

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
        system: fullSystem,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw { status: response.status, message: data.error?.message || 'Anthropic API error' };
    }

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    lastRawText = clean;

    const parsed = extractJSON(clean);
    if (parsed) return parsed;

    // Last resort: even if the full object isn't valid JSON, try to pull
    // just the spoken line out with a direct pattern match, so the call can
    // keep going instead of surfacing a raw JSON error to the user.
    if (attempt === 1) {
      const speech = extractSpeechOnly(clean);
      if (speech) {
        return { speech, patience_delta: 0, hangup: false, won: false };
      }
    }
    // otherwise loop and try once more
  }

  throw { status: 502, message: 'Model did not return valid JSON after retry: ' + lastRawText.slice(0, 200) };
}

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

// Pulls just the "speech" field's text out with a pattern match, for cases
// where the overall JSON is broken (e.g. an unescaped quote elsewhere) but
// the speech value itself is still intact.
function extractSpeechOnly(text) {
  const match = text.match(/"speech"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  return match[1]
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\\\/g, '\\')
    .trim() || null;
}
