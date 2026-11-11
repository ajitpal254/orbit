const mongoose = require('mongoose');

// One Web Push subscription per browser/device. The endpoint is globally
// unique (one row per push endpoint) — a user re-subscribing from the
// same browser updates their row instead of duplicating it. Subscriptions
// that come back 410/404 from the push service are deleted on send (see
// lib/push.js), so dead browsers do not accumulate.
//
// The keys are the browser's own encryption keys (p256dh + auth) —
// they are needed to encrypt the payload for that endpoint and are
// useless without the VAPID private key, which lives only in env.
const pushSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true, unique: true, index: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true }
  }
}, { timestamps: true });

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
