// Serverless function (runs on Vercel). Verifies the caller is a real
// logged-in Supabase user before spending your Anthropic API budget.
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

  const { system, transcript } = req.body || {};
  if (!system || !transcript) {
    res.status(400).json({ error: 'Missing system or transcript in request body' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in your Vercel project settings.' });
    return;
  }

  const tool = {
    name: 'call_feedback',
    description: 'Structured coaching feedback scoring the cold call that just happened.',
    input_schema: {
      type: 'object',
      properties: {
        overall_score: { type: 'integer', description: '0-100 overall score.' },
        opener_score: { type: 'integer', description: '0-100 score for the opening of the call.' },
        objection_handling_score: { type: 'integer', description: '0-100 score for handling objections.' },
        closing_score: { type: 'integer', description: '0-100 score for the close / next-step ask.' },
        strengths: {
          type: 'array',
          items: { type: 'string' },
          description: '2-3 concrete, specific things the caller did well, one sentence each.'
        },
        improvements: {
          type: 'array',
          items: { type: 'string' },
          description: '2-3 concrete, specific things to improve, one sentence each.'
        },
        key_moment: {
          type: 'string',
          description: 'A short paraphrase of the single most important moment in the call and why it mattered.'
        }
      },
      required: ['overall_score', 'opener_score', 'objection_handling_score', 'closing_score', 'strengths', 'improvements', 'key_moment']
    }
  };

  try {
    const parsed = await callClaudeTool({
      system,
      messages: [{ role: 'user', content: `Transcript:\n${transcript}` }],
      maxTokens: 1200,
      tool
    });
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
