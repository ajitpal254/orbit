const mongoose = require('mongoose');
const { UNFURL_CACHE_TTL_MS } = require('../lib/unfurl');

// Cached server-side link preview (POST /api/unfurl). The URL is the
// key — the same link shared twice costs one fetch. Rows are public
// metadata (a page's own Open Graph tags), so nothing here is
// encrypted. The TTL index is the cache eviction: after 7 days the
// row is dropped and the next unfurl re-fetches fresh tags.
const linkPreviewSchema = new mongoose.Schema({
  url: { type: String, required: true, unique: true, trim: true, maxlength: [2048, 'URL too long'] },
  title: { type: String, default: null, maxlength: 500 },
  description: { type: String, default: null, maxlength: 1000 },
  image: { type: String, default: null, maxlength: 2048 },
  favicon: { type: String, default: null, maxlength: 2048 },
  fetchedAt: { type: Date, default: Date.now }
}, { timestamps: true });

linkPreviewSchema.index(
  { fetchedAt: 1 },
  { expireAfterSeconds: Math.floor(UNFURL_CACHE_TTL_MS / 1000) }
);

module.exports = mongoose.model('LinkPreview', linkPreviewSchema);
