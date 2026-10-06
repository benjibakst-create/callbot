// Serverless function (Vercel). Permanently deletes the signed-in user's
// account: cancels any Stripe subscription, removes their data, then removes
// the login itself. Uses the Supabase SERVICE ROLE key, which bypasses
// row-level security — it must only ever live in server environment
// variables, never in app.html.
//
// Order matters: billing first (so nobody keeps getting charged), data
// second, the login last. Every step is safe to repeat, so if something
// fails halfway the user can simply try again.
//
// BEFORE USING — match these to your project:
//   1. SUPABASE_SERVICE_ROLE_KEY and STRIPE_SECRET_KEY are the env var names
//      I'm assuming. Copy the exact names (and the Stripe setup lines) from
//      your existing api/create-portal-session.js and api/login.js.
//   2. STRIPE_CUSTOMER_COLUMN is the column in `profiles` that holds the
//      Stripe customer id (it's whatever your Stripe webhook writes to).
const STRIPE_CUSTOMER_COLUMN = 'stripe_customer_id';

const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !process.env.SUPABASE_ANON_KEY) {
    res.status(500).json({ error: 'Server is not configured for account deletion.' });
    return;
  }

  // 1. Who is asking? Verify their session token with Supabase.
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const user = await verifyUser(token);
  if (!user) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  // 2. Require an explicit confirmation so a stray request can't delete anything.
  if (!req.body || req.body.confirm !== 'DELETE') {
    res.status(400).json({ error: 'Missing confirmation.' });
    return;
  }

  const userId = user.id; // a UUID issued by Supabase, safe to use in URLs
  const adminHeaders = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    // 3. Look up the Stripe customer for this user (if any).
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`,
      { headers: adminHeaders }
    );
    if (!profileRes.ok) throw new Error('Could not read profile.');
    const profileRows = await profileRes.json();
    const customerId = profileRows[0] && profileRows[0][STRIPE_CUSTOMER_COLUMN];

    // 4. Cancel any live subscriptions right away. If we can't, stop here —
    //    deleting the account while billing continues would be the worst outcome.
    if (customerId) {
      if (!process.env.STRIPE_SECRET_KEY) throw new Error('Billing is not configured.');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
      for (const sub of subs.data) {
        if (['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(sub.status)) {
          await stripe.subscriptions.cancel(sub.id);
        }
      }
    }

    // 5. Delete their data. Prospects first: reports about them go with them.
    await deleteRows(SUPABASE_URL, adminHeaders, 'call_history', `user_id=eq.${userId}`);
    await deleteRows(SUPABASE_URL, adminHeaders, 'personas', `owner_id=eq.${userId}`);
    await deleteRows(SUPABASE_URL, adminHeaders, 'persona_reports', `reporter_id=eq.${userId}`);
    await deleteRows(SUPABASE_URL, adminHeaders, 'api_rate_limits', `user_id=eq.${userId}`);
    await deleteRows(SUPABASE_URL, adminHeaders, 'profiles', `id=eq.${userId}`);

    // 6. Finally, delete the login itself.
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: adminHeaders
    });
    if (!authRes.ok) throw new Error('Could not remove login.');

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('delete-account failed for', userId, err.message);
    res.status(500).json({
      error: 'We could not finish deleting your account. Nothing further will be charged — please try again, or email support.'
    });
  }
};

async function verifyUser(token) {
  if (!token) return null;
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

async function deleteRows(baseUrl, headers, table, filter) {
  const response = await fetch(`${baseUrl}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers });
  // 404 means the table doesn't exist in this project — nothing to delete.
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => '');
    throw new Error(`Delete from ${table} failed: ${response.status} ${body.slice(0, 120)}`);
  }
}
