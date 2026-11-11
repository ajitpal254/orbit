const mongoose = require('mongoose');

// One row per friendship, in either direction. A friendship is pending
// until the recipient accepts it; check both directions when testing
// "are these two users friends" (see lib/friends.js).
const friendshipSchema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'accepted'], default: 'pending', index: true }
}, { timestamps: true });

// At most one row per ordered pair — duplicates are rejected at the route
// level too, but the index makes it impossible to create two.
friendshipSchema.index({ requester: 1, recipient: 1 }, { unique: true });

module.exports = mongoose.model('Friendship', friendshipSchema);
