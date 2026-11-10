const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, trim: true, maxlength: [60, 'Name too long'], default: '' },
  text: { type: String, required: true, trim: true, maxlength: [1000, 'Message too long'] }
}, { timestamps: true });

// Fast history fetch: latest messages per room, newest first.
messageSchema.index({ roomId: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
