const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).send('Server is missing required environment variables.');
    return;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    // Signature verification needs the exact raw request bytes — this only
    // works because bodyParser is disabled below (see module.exports.config).
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const sub = event.data.object;
      const userId = sub.metadata && sub.metadata.supabase_user_id;

      if (userId) {
        const activeStatuses = ['active', 'trialing'];
        const plan = activeStatuses.includes(sub.status) ? 'pro' : 'free';

        await admin.from('profiles').update({
          plan,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          plan_renews_at: sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null
        }).eq('id', userId);
      } else {
        console.warn(`Subscription event ${event.id} had no supabase_user_id in metadata`);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Webhook handler error');
  }
};

// Disable Vercel's automatic JSON body parsing for this route — Stripe's
// signature check needs the untouched raw bytes, not a re-serialized copy.
module.exports.config = { api: { bodyParser: false } };

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}
