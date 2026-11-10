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
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }
}, { timestamps: true });

module.exports = mongoose.model('Room', roomSchema);
