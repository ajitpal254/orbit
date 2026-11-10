const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    maxlength: [120, 'Email too long']
  },
  name: { type: String, trim: true, maxlength: [60, 'Name too long'], default: '' },
  passwordHash: { type: String, required: true },
  passwordSalt: { type: String, required: true }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
