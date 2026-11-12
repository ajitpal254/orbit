// Shared avatar: one component everywhere a person is shown (Profile,
// members panel, Friends rows, DM rows, room invite picker).
//
// Precedence: uploaded photo (avatarImage) wins over a character,
// a character wins over a gradient preset, and a preset wins over
// plain initials. Characters are animated SVG (see characters.js +
// CharacterAvatar.jsx); presets are animated gradient orbs (see
// avatars.js + the .avatar-motion-* CSS). Sizes: sm = list rows (32px),
// md = headers (48px), lg = profile (96px).
import React from 'react';
import { avatarPresetById, avatarCharacterById } from '../avatars';
import { initials } from '../orbLayout';
import CharacterArt from './CharacterAvatar';

export default function Avatar({ user, size = 'sm', className = '' }) {
  const u = user || {};
  if (u.avatarImage) {
    return (
      <img
        className={`avatar avatar-photo avatar-${size} ${className}`}
        src={u.avatarImage}
        alt={u.name ? `${u.name}'s profile picture` : 'Profile picture'}
      />
    );
  }
  // Animated character (v0.7.0): the .avatar span only sizes/clips —
  // the character draws its own circular gradient backdrop, so no
  // inline gradient style is set here (unlike presets below).
  const character = avatarCharacterById(u.avatarPreset);
  if (character) {
    return (
      <span
        className={`avatar avatar-character avatar-${size} ${className}`}
        style={{ background: 'transparent' }}
        title={character.name}
      >
        <CharacterArt characterId={character.id} label={`${character.name} avatar`} />
      </span>
    );
  }
  const preset = avatarPresetById(u.avatarPreset);
  if (preset) {
    return (
      <span
        className={`avatar avatar-preset avatar-${size} avatar-motion-${preset.motion} ${className}`}
        style={{ background: `linear-gradient(135deg, ${preset.from}, ${preset.to})` }}
        title={preset.name}
      >
        {initials(u.name || u.email || '')}
      </span>
    );
  }
  return (
    <span className={`avatar avatar-initials avatar-${size} ${className}`}>
      {initials(u.name || u.email || '')}
    </span>
  );
}
