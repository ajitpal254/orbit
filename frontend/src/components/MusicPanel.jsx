// Music panel (v0.10.0): the room's music bot UI — now playing, the
// queue, the add-track form, DJ transport, and the listener volume.
//
// The server is the source of truth (music-state broadcasts carry the
// DJ, queue, now-playing and playing flag); this component renders
// that state and emits the socket intents. The DJ's actual playback
// (hidden <audio> element + captureStream into the voice engine)
// lives in RoomView, which stays mounted when the call is minimized —
// this panel is only the controls, so it can open and close freely.
//
// Idle auto-disconnect: the server warns the room 60s before it
// stops the music for idleness (DJ alone for 4 minutes) via
// music-idle-warning, then announces the stop via
// music-idle-disconnect. RoomView owns those listeners and hands the
// countdown / notice down as props; the notice survives the
// accompanying music-state (dj: null) until dismissed or music
// restarts.
import React, { useState } from 'react';
import { Icon } from './icons';
import { resolveYouTube } from '../api';
import {
  detectMusicSource,
  buildRadioTrack,
  buildYouTubeTrack,
  validateTrack,
  formatDuration,
  idleWarningText
} from '../music';

const SOURCE_LABEL = { youtube: 'YouTube', radio: 'Radio' };

export default function MusicPanel({
  roomId,
  musicState,
  isDj,
  canStop,
  musicVolume,
  musicMuted,
  musicLive,
  idleWarning,
  idleNotice,
  onDismissIdleNotice,
  error,
  playbackError,
  onClaim,
  onRelease,
  onPlay,
  onPause,
  onSkip,
  onStop,
  onQueueAdd,
  onQueueRemove,
  onVolumeChange,
  onMuteToggle,
  onClose
}) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [resolving, setResolving] = useState(false);
  const [formError, setFormError] = useState('');

  const { dj, queue, nowPlaying, playing } = musicState || {};
  const musicActive = !!(dj || nowPlaying);
  const canRemove = isDj || canStop;

  const addTrack = async (e) => {
    e.preventDefault();
    const rawUrl = url.trim();
    const source = detectMusicSource(rawUrl);
    if (!source) {
      setFormError('Paste a YouTube link or a direct audio URL (MP3 or stream).');
      return;
    }
    setFormError('');
    if (source === 'youtube') {
      // YouTube needs the server to extract a playable audio URL
      // first — the raw watch URL is not playable in an <audio>
      // element. A 502 leaves the panel usable: radio/MP3 still works.
      setResolving(true);
      try {
        const resolved = await resolveYouTube(rawUrl, roomId);
        const track = buildYouTubeTrack(resolved);
        const check = validateTrack(track);
        if (!check.ok) {
          setFormError(check.error);
          return;
        }
        onQueueAdd(track);
        setUrl('');
        setTitle('');
      } catch (err) {
        if (err?.status === 502 || err?.message === 'YOUTUBE_UNAVAILABLE') {
          setFormError("YouTube couldn't fetch this track right now — try a radio or MP3 link instead.");
        } else if (err?.status === 400 || err?.message === 'INVALID_URL') {
          setFormError("That YouTube link doesn't look valid.");
        } else if (err?.status === 429) {
          setFormError('Too many requests — try again in a bit.');
        } else {
          setFormError(err?.message || "Couldn't add that track — try again.");
        }
      } finally {
        setResolving(false);
      }
      return;
    }
    const track = buildRadioTrack(rawUrl, title);
    const check = validateTrack(track);
    if (!check.ok) {
      setFormError(check.error);
      return;
    }
    onQueueAdd(track);
    setUrl('');
    setTitle('');
  };

  return (
    <section className="music-sheet" aria-label="Music" data-music-live={musicLive ? 'true' : 'false'}>
      <div className="music-head">
        <strong><Icon name="music" size={16} /> Music</strong>
        <button className="btn btn-text" onClick={onClose} aria-label="Close music panel">
          <Icon name="x" size={16} />
        </button>
      </div>

      {idleWarning && (
        <p className="music-idle-warning" role="status">
          <Icon name="music" size={14} /> {idleWarningText(idleWarning.secondsRemaining)}
        </p>
      )}
      {idleNotice && (
        <p className="music-idle-notice" role="status">
          <span>{idleNotice}</span>
          <button className="btn btn-text btn-small" onClick={onDismissIdleNotice}>Dismiss</button>
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {playbackError && <p className="error" role="alert">{playbackError}</p>}

      <div className="music-now">
        {nowPlaying ? (
          <>
            <span className="music-now-label">{playing ? 'Now playing' : 'Paused'}</span>
            <strong className="music-now-title">{nowPlaying.title}</strong>
            <span className="music-source-badge">{SOURCE_LABEL[nowPlaying.source] || nowPlaying.source}</span>
            {nowPlaying.duration != null && (
              <span className="muted">{formatDuration(nowPlaying.duration)}</span>
            )}
            {musicLive && !isDj && <span className="music-live">Live in the room</span>}
            {isDj && <span className="music-live">You are the DJ — playing from your browser</span>}
          </>
        ) : (
          <span className="muted">Nothing playing yet — add a track below.</span>
        )}
        <span className="muted music-dj-line">
          {dj ? `DJ: ${dj.name}` : 'No DJ — take over to play music for the room.'}
        </span>
      </div>

      <div className="music-controls" role="group" aria-label="Playback controls">
        {isDj ? (
          <>
            {playing ? (
              <button className="btn btn-primary btn-small" onClick={onPause} aria-label="Pause music">
                <Icon name="pause" size={15} /> Pause
              </button>
            ) : (
              <button
                className="btn btn-primary btn-small"
                onClick={onPlay}
                disabled={!nowPlaying && queue.length === 0}
                aria-label="Play music"
              >
                <Icon name="play" size={15} /> Play
              </button>
            )}
            <button
              className="btn btn-text btn-small"
              onClick={onSkip}
              disabled={!nowPlaying && queue.length === 0}
              aria-label="Skip to next track"
            >
              <Icon name="skip-forward" size={15} /> Skip
            </button>
            <button className="btn btn-text btn-small" onClick={onRelease}>
              Step down as DJ
            </button>
          </>
        ) : (
          <p className="muted music-hint">Only the DJ can control playback.</p>
        )}
        {!dj && (
          <button className="btn btn-primary btn-small" onClick={onClaim}>
            Take over as DJ
          </button>
        )}
        {canStop && musicActive && (
          <button className="btn btn-text btn-small" onClick={onStop}>
            Stop music
          </button>
        )}
      </div>

      <div className="music-volume">
        <button
          className="btn btn-text btn-small"
          onClick={onMuteToggle}
          aria-label={musicMuted ? 'Unmute music' : 'Mute music'}
          aria-pressed={musicMuted}
          title={musicMuted ? 'Unmute music' : 'Mute music'}
        >
          <Icon name={musicMuted ? 'volume-x' : 'volume'} size={16} />
        </button>
        <label className="music-volume-label">
          <span className="muted">Music volume</span>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(musicVolume * 100)}
            onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
            aria-label="Music volume"
          />
        </label>
      </div>

      {queue.length > 0 && (
        <ul className="music-queue">
          {queue.map((track) => (
            <li key={track.id} className={nowPlaying && track.id === nowPlaying.id ? 'music-queue--playing' : ''}>
              <span className="music-queue-title">{track.title}</span>
              <span className="music-source-badge">{SOURCE_LABEL[track.source] || track.source}</span>
              <span className="muted">{formatDuration(track.duration)}</span>
              {canRemove && (
                <button
                  className="btn btn-text btn-small"
                  onClick={() => onQueueRemove(track.id)}
                  aria-label={`Remove ${track.title} from the queue`}
                >
                  <Icon name="x" size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="music-add" onSubmit={addTrack}>
        <input
          placeholder="Paste a YouTube link or an MP3 / radio URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Track URL"
        />
        <input
          placeholder="Title (optional for radio)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Track title"
        />
        <button className="btn btn-primary btn-small" type="submit" disabled={resolving}>
          {resolving ? 'Fetching…' : 'Add track'}
        </button>
      </form>
      {formError && <p className="error" role="alert">{formError}</p>}
      <p className="muted music-note">
        YouTube links are fetched by the server; anything else plays as a direct radio / MP3 stream.
      </p>
    </section>
  );
}
