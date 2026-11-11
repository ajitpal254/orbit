const mongoose = require('mongoose');

// One Web Push subscription per (user, browser/device) — audit M5.
// The endpoint is per-origin per-device, so two accounts on the same
// phone share one endpoint. Keying by endpoint alone (the old unique
// index) meant subscribing as account B silently reassigned account
// A's row and A's pushes stopped arriving with no error anywhere.
// The compound unique index below lets both accounts keep their own
// row for the same endpoint; a re-subscribe from the same browser
// updates that user's row instead of duplicating it. Subscriptions
// that come back 410/404 from the push service are deleted on send
// (see lib/push.js), so dead browsers do not accumulate.
//
// Migration: the old endpoint-only unique index (`endpoint_1`) is NOT
// dropped by Mongoose's auto-index creation — server.js calls
// PushSubscription.syncIndexes() at boot, which drops it. Until that
// runs, the old index would still reject a second user on the same
// endpoint; see tests/pushSubscriptions.test.js for the regression
// test that drives the old index through syncIndexes().
//
// The keys are the browser's own encryption keys (p256dh + auth) —
// they are needed to encrypt the payload for that endpoint and are
// useless without the VAPID private key, which lives only in env.
const pushSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true }
  }
}, { timestamps: true });

pushSubscriptionSchema.index({ user: 1, endpoint: 1 }, { unique: true });

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
