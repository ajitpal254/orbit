const mongoose = require('mongoose');

// An invitation to join a private room. Only accepted friends can be
// invited (enforced at the route), and the invitee accepts or declines
// from the home screen. One pending invite per (room, invitee).
const roomInviteSchema = new mongoose.Schema({
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  inviter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  invitee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending', index: true }
}, { timestamps: true });

roomInviteSchema.index({ room: 1, invitee: 1 }, { unique: true });

module.exports = mongoose.model('RoomInvite', roomInviteSchema);
