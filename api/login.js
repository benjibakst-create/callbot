const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: 'Missing username or password' });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.' });
    return;
  }

  const cleanUsername = String(username).trim().toLowerCase();

  // service_role bypasses RLS and column grants — this function (and
  // forgot-password.js) are the only places in the app allowed to read
  // the email column at all.
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: profile } = await admin
    .from('profiles')
    .select('email')
    .eq('username', cleanUsername)
    .maybeSingle();

  // Accounts created before real emails were collected fall back to the
  // old synthetic address, so they keep working without needing to reset
  // anything.
  const email = (profile && profile.email) ? profile.email : `${cleanUsername}@dialin.local`;

  const { data, error } = await admin.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    // Same message either way — never reveal which part was wrong.
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  res.status(200).json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    username: data.user.user_metadata?.username || cleanUsername
  });
};
