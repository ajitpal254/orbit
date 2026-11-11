const mongoose = require('mongoose');
const { ACCENTS } = require('../lib/rooms');

const roomSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: [60, 'Room name too long'] },
  // Stored AES-256-GCM ciphertext, so the limit is sized for the encrypted
  // form of a 140-char topic (~230).
  topic: { type: String, trim: true, maxlength: [500, 'Topic too long'], default: '' },
  accent: {
    type: String,
    enum: ACCENTS.map((a) => a.id),
    default: 'violet'
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Private rooms are only visible to their members. The creator is
  // auto-added to members on creation; public rooms ignore this list.
  // Rooms created before this field existed have no isPrivate/members
  // and behave as public.
  //
  // Roles live on the member entry: { user, role } with role 'owner' |
  // 'moderator' | 'member' (see lib/roles.js). Rooms created before roles
  // existed store plain ObjectIds instead — lib/roles.js normalizeMembers
  // treats those as 'member' (creator: 'owner'), so old rooms keep
  // working without a migration. `_id: false`: subdocuments need no own
  // id, which also keeps $set-rewrites of the list predictable.
  isPrivate: { type: Boolean, default: false, index: true },
  members: [{
    _id: false,
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', 'moderator', 'member'], default: 'member' }
  }]
}, { timestamps: true });

module.exports = mongoose.model('Room', roomSchema);
