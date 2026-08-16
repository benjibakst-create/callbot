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

  const tool = {
    name: 'prospect_turn',
    description: "The prospect's next spoken line and how the call state changes as a result.",
    input_schema: {
      type: 'object',
      properties: {
        speech: {
          type: 'string',
          description: 'What the prospect says out loud, 1-3 short natural spoken sentences.'
        },
        patience_delta: {
          type: 'integer',
          description: 'How much the patience score changes this turn, from -25 to 15.'
        },
        hangup: {
          type: 'boolean',
          description: 'True if the prospect hangs up on this turn.'
        },
        won: {
          type: 'boolean',
          description: 'True if the prospect agrees to a next step (meeting, demo, callback) on this turn.'
        }
      },
      required: ['speech', 'patience_delta', 'hangup', 'won']
    }
  };

  try {
    const parsed = await callClaudeTool({ system, messages, maxTokens: 500, tool });
    res.status(200).json(parsed);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};

// Uses forced tool-use instead of asking the model to write JSON as plain
// text. This is far more reliable — the API guarantees the reply is a
// structured object matching the schema, rather than us hoping the model's
// free-text response happens to be valid, well-formed JSON.
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
    // otherwise loop and try once more
  }

  throw { status: 502, message: lastError };
}
