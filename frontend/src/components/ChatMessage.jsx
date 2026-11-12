// One chat message: text, an optional inline image, and an optional
// link-preview card. Shared by room chat (RoomView) and DMs
// (DirectMessages) so both render media identically.
//
// - Images render inline (max 320px wide, lazy-loaded, alt text is
//   the filename) and open a full-screen lightbox on tap/click.
// - Link preview: the first URL in the text is unfurled server-side
//   (POST /api/unfurl), debounced 600ms after the message mounts and
//   cached per URL for the session, so the same link in ten messages
//   costs one fetch. No preview on failure — the message just shows
//   its text.
import React, { useEffect, useState } from 'react';
import { unfurlUrl } from '../api';
import { findFirstUrl } from '../media';
import { Icon } from './icons';

// Per-URL preview cache for the session (null = unfurled, nothing there).
const previewCache = new Map();

function LinkPreview({ url }) {
  const [preview, setPreview] = useState(() => previewCache.get(url) || null);
  const [done, setDone] = useState(() => previewCache.has(url));

  useEffect(() => {
    if (previewCache.has(url)) return;
    const timer = setTimeout(() => {
      unfurlUrl(url)
        .then((p) => {
          const hasContent = p && (p.title || p.description || p.image);
          previewCache.set(url, hasContent ? p : null);
          setPreview(hasContent ? p : null);
          setDone(true);
        })
        .catch(() => {
          previewCache.set(url, null);
          setDone(true);
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [url]);

  if (!done || !preview) return null;
  let host = '';
  try { host = new URL(url).hostname; } catch { host = ''; }
  return (
    <a className="link-preview" href={url} target="_blank" rel="noreferrer">
      {preview.image && (
        <img className="link-preview-img" src={preview.image} alt="" loading="lazy" />
      )}
      <span className="link-preview-body">
        <span className="link-preview-title">
          {preview.favicon && (
            <img className="link-preview-favicon" src={preview.favicon} alt="" loading="lazy" />
          )}
          {preview.title || host || url}
        </span>
        {preview.description && (
          <span className="link-preview-desc">{preview.description}</span>
        )}
        {host && <span className="link-preview-host">{host}</span>}
      </span>
    </a>
  );
}

function Lightbox({ media, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={media.name || 'Shared image'} onClick={onClose}>
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close image">
        <Icon name="x" size={20} />
      </button>
      <img
        src={media.url}
        alt={media.name || 'Shared image'}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

export default function ChatMessage({ name, mine, text, media, createdAt }) {
  const [lightbox, setLightbox] = useState(false);
  const url = findFirstUrl(text);
  const time = createdAt
    ? new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  return (
    <div className={`chat-msg ${mine ? 'mine' : ''}`}>
      {name && <span className="chat-name">{name}</span>}
      {text ? <span className="chat-text">{text}</span> : null}
      {media && media.url && (
        <button
          type="button"
          className="chat-media-btn"
          onClick={() => setLightbox(true)}
          aria-label={`View image${media.name ? `: ${media.name}` : ''}`}
        >
          <img
            className="chat-media-img"
            src={media.url}
            alt={media.name || 'Shared image'}
            loading="lazy"
            width={media.width || undefined}
            height={media.height || undefined}
          />
        </button>
      )}
      {url && <LinkPreview url={url} />}
      {time && <span className="chat-time">{time}</span>}
      {lightbox && media && media.url && (
        <Lightbox media={media} onClose={() => setLightbox(false)} />
      )}
    </div>
  );
}
