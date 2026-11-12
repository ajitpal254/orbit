// CharacterAvatar: renders one hand-drawn animated character avatar
// (see characters.js + CharacterAvatar.css). SVG + CSS only, no images.
//
// The markup comes from characterSvg(id), which is built ONLY from our
// own static art constants — never from user input — so injecting it
// via dangerouslySetInnerHTML is safe here. An unknown id renders
// nothing (the caller — Avatar — falls through to the gradient preset
// / initials path instead).
import React from 'react';
import { characterSvg } from '../characters';
import './CharacterAvatar.css';

export default function CharacterArt({ characterId, className = '', label }) {
  const svg = characterSvg(characterId);
  if (!svg) return null;
  return (
    <span
      className={`char-art ${className}`}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
