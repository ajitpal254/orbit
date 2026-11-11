// Shared avatar: one component everywhere a person is shown (Profile,
// members panel, Friends rows, DM rows, room invite picker).
//
// Precedence: uploaded photo (avatarImage) wins over a preset, and a
// preset wins over plain initials. The preset is an animated gradient
// orb (see avatars.js + the .avatar-motion-* CSS) so the avatar feels
// alive without any external image. Sizes: sm = list rows (32px),
// md = headers (48px), lg = profile (96px).
import React from 'react';
import { avatarPresetById } from '../avatars';
import { initials } from '../orbLayout';

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
