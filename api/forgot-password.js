const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { username, redirectTo } = req.body || {};
  if (!username) {
    res.status(400).json({ error: 'Missing username' });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.' });
    return;
  }

  const cleanUsername = String(username).trim().toLowerCase();
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: profile } = await admin
    .from('profiles')
    .select('email')
    .eq('username', cleanUsername)
    .maybeSingle();

  if (profile && profile.email) {
    await admin.auth.resetPasswordForEmail(profile.email, {
      redirectTo: redirectTo || undefined
    });
  }

  // Always the same response, whether or not the username or email
  // existed — don't let this endpoint be used to check which usernames
  // are registered.
  res.status(200).json({ ok: true });
};
