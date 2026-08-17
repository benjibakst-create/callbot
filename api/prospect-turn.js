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
        speech: { type: 'string', description: 'What the prospect says out loud, 1-3 short natural spoken sentences.' },
        patience_delta: { type: 'integer', description: 'How much the patience score changes this turn, from -25 to 15.' },
        hangup: { type: 'boolean', description: 'True if the prospect hangs up on this turn.' },
        won: { type: 'boolean', description: 'True if the prospect agrees to a next step (meeting, demo, callback) on this turn.' }
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
