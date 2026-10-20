// Serverless function (runs on Vercel). Turns a short free-text description
// ("a skeptical CFO who hates buzzwords") into a complete, structured
// prospect persona that the builder form pre-fills. Pro-only (verified
// server-side, not just hidden in the UI), rate limited, and the output is
// validated and clamped before being returned. The person still reviews
// and edits everything in the form before anything is saved.
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

  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  const withinLimit = await checkRateLimit(token, user.id, 8, 60); // 8 generations per minute
  if (!withinLimit) {
    res.status(429).json({ error: "You're going a bit fast — try again in a moment." });
    return;
  }

  if (!(await checkIsPro(token, user.id))) {
    res.status(403).json({ error: 'Building custom prospects is a Pro feature.' });
    return;
  }

  const description = String((req.body && req.body.description) || '').trim();
  if (description.length < 10) {
    res.status(400).json({ error: 'Describe the prospect in a sentence or two.' });
    return;
  }
  if (description.length > 600) {
    res.status(400).json({ error: 'Keep the description under 600 characters.' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY.' });
    return;
  }

  const tool = {
    name: 'build_prospect',
    description: 'A complete fictional cold-call prospect persona, or a polite decline if the request cannot be built.',
    input_schema: {
      type: 'object',
      properties: {
        declined: {
          type: 'boolean',
          description: 'True only if the request asks for a real, identifiable person, or for hateful, harassing, sexual, or otherwise inappropriate content. Otherwise false.'
        },
        decline_reason: {
          type: 'string',
          description: 'If declined, one short friendly sentence explaining why and suggesting a fictional alternative. Empty string otherwise.'
        },
        name: { type: 'string', description: 'A realistic fictional first and last name. Never a real public figure.' },
        role: { type: 'string', description: 'Job title and company context, e.g. "Head of Procurement · Mid-size manufacturer".' },
        difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
        start_patience: {
          type: 'integer',
          description: 'Starting patience from 10 (hostile, hangs up fast) to 90 (very receptive). Roughly: easy 65-80, medium 45-60, hard 25-40.'
        },
        voice_hint: { type: 'string', enum: ['female', 'male'], description: 'Which voice best fits the name.' },
        card_desc: {
          type: 'string',
          description: 'One sentence, under 140 characters, shown on the picker card, telling the caller what to expect.'
        },
        personality: {
          type: 'string',
          description: '3-5 sentences of behavioral brief for an actor playing this person on a phone call: how they sound, what they care about, which objections they raise, what warms them up, and what makes them cut the call short.'
        }
      },
      required: ['declined', 'decline_reason', 'name', 'role', 'difficulty', 'start_patience', 'voice_hint', 'card_desc', 'personality']
    }
  };

  const system = `You design fictional prospects for a cold-calling sales training simulator. Given a short description from a user, produce one complete, believable persona that a salesperson could practice calling.

Guidelines:
- Everyone you create is fictional. Never use the name or identity of a real public figure or a real private individual. If the description asks for a specific real person (including a named coworker, boss, ex, or celebrity), decline.
- Decline requests for hateful, harassing, sexual, or otherwise inappropriate content, or anything meant to demean a group of people. Keep the decline short and friendly, and suggest a fictional alternative.
- The "personality" field is a behavioral brief that an actor will read before playing this person on a phone call. Make it specific and behavioral, written as plain prose. Avoid stereotypes tied to gender, race, age, or nationality.
- Match difficulty to the description: a friendly, easily engaged person is easy; a busy or skeptical person is medium; a gatekeeper, a hostile person, or someone extremely short on time is hard.
- Keep everything grounded in realistic business behavior, not caricature.`;

  let out;
  try {
    out = await callClaudeTool({ system, description, tool });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
    return;
  }

  if (out.declined) {
    res.status(200).json({
      declined: true,
      reason: clip(out.decline_reason, 200) || "I can't build that one. Try describing a fictional prospect instead."
    });
    return;
  }

  const result = {
    name: clip(out.name, 40),
    role: clip(out.role, 90),
    difficulty: ['easy', 'medium', 'hard'].includes(out.difficulty) ? out.difficulty : 'medium',
    start_patience: Math.max(10, Math.min(90, parseInt(out.start_patience, 10) || 55)),
    voice_hint: out.voice_hint === 'male' ? 'male' : 'female',
    card_desc: clip(out.card_desc, 140),
    personality: clip(out.personality, 900)
  };

  if (!result.name || !result.role || !result.personality) {
    res.status(502).json({ error: 'The generator did not return a complete prospect. Try again.' });
    return;
  }

  res.status(200).json(result);
};

function clip(value, max) {
  return String(value || '').trim().slice(0, max);
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

// Reads this user's own plan row (RLS limits it to exactly their own row).
async function checkIsPro(token, userId) {
  if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return false;
  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/profiles?select=plan,plan_renews_at,free_access&id=eq.${userId}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_ANON_KEY } }
    );
    if (!response.ok) return false;
    const rows = await response.json();
    const row = rows && rows[0];
    if (!row) return false;
    if (row.free_access) return true;
    if (row.plan === 'pro') return true;
    if (row.plan_renews_at && new Date(row.plan_renews_at) > new Date()) return true;
    return false;
  } catch (e) {
    return false;
  }
}

// Atomic per-user rate limit via the Postgres function from the rate-limiting
// migration. Fails OPEN on any error, so if that migration hasn't been run
// yet (or Supabase hiccups), this endpoint keeps working instead of breaking.
async function checkRateLimit(token, userId, limit, windowSeconds) {
  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/check_and_increment_rate_limit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_user_id: userId, p_limit: limit, p_window_seconds: windowSeconds })
    });
    if (!response.ok) return true;
    return (await response.json()) === true;
  } catch (e) {
    return true;
  }
}

async function callClaudeTool({ system, description, tool }) {
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
        max_tokens: 900,
        system,
        messages: [{
          role: 'user',
          content: `The user's description of the prospect they want to practice calling:\n"""\n${description}\n"""`
        }],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name }
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw { status: response.status, message: data.error?.message || 'Anthropic API error' };
    }
    const block = (data.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
    if (block && block.input) return block.input;
    lastError = 'The generator did not return a structured result.';
  }
  throw { status: 502, message: lastError };
}
