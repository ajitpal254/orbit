// Client-side media helpers (pure, no React): URL detection for link
// previews, client-side file validation (mirrors the server limits so
// a bad file fails before any upload starts), and reading an image's
// dimensions off the file for the message's media field.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB, same as the server
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;

// First http(s) URL in a message, or null. Trailing punctuation the
// user almost never meant as part of the URL is trimmed.
export const findFirstUrl = (text) => {
  if (typeof text !== 'string') return null;
  const m = text.match(URL_PATTERN);
  if (!m) return null;
  return m[0].replace(/[.,;:!?]+$/, '');
};

export const isSupportedImageFile = (file) =>
  !!file && ALLOWED_IMAGE_TYPES.includes(file.type);

export const validateImageFile = (file) => {
  if (!file) return { ok: false, error: 'No image selected' };
  if (!isSupportedImageFile(file)) {
    return { ok: false, error: 'Only images are allowed (JPEG, PNG, GIF, WebP)' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: 'Image must be 10MB or smaller' };
  }
  return { ok: true };
};

// Read width/height off the file itself (the server only sanity-checks
// the range). Rejects when the file is not a decodable image.
export const readImageDimensions = (file) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const dims = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not a valid image'));
    };
    img.src = url;
  });
