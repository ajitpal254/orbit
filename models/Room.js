const mongoose = require('mongoose');
const { ACCENTS } = require('../lib/rooms');

const roomSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: [60, 'Room name too long'] },
  topic: { type: String, trim: true, maxlength: [140, 'Topic too long'], default: '' },
  accent: {
    type: String,
    enum: ACCENTS.map((a) => a.id),
    default: 'violet'
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }
}, { timestamps: true });

module.exports = mongoose.model('Room', roomSchema);
