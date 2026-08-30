import { describe, it, expect } from 'vitest';
import { audioFromMessage } from '../src/plugins/transcribe';

describe('audioFromMessage', () => {
  it('reads a voice note (ogg)', () => {
    expect(audioFromMessage({ voice: { file_id: 'v1' } })).toEqual({ fileId: 'v1', filename: 'voice.ogg' });
  });
  it('reads an audio file, keeping its name', () => {
    expect(audioFromMessage({ audio: { file_id: 'a1', file_name: 'song.m4a' } })).toEqual({ fileId: 'a1', filename: 'song.m4a' });
    expect(audioFromMessage({ audio: { file_id: 'a2' } })).toEqual({ fileId: 'a2', filename: 'audio.mp3' });
  });
  it('reads a video note (mp4)', () => {
    expect(audioFromMessage({ video_note: { file_id: 'n1' } })).toEqual({ fileId: 'n1', filename: 'note.mp4' });
  });
  it('reads an audio document but ignores non-audio documents', () => {
    expect(audioFromMessage({ document: { file_id: 'd1', mime_type: 'audio/ogg', file_name: 'rec.ogg' } })).toEqual({
      fileId: 'd1',
      filename: 'rec.ogg',
    });
    expect(audioFromMessage({ document: { file_id: 'd2', mime_type: 'application/pdf', file_name: 'x.pdf' } })).toBeNull();
  });
  it('returns null when there is no audio', () => {
    expect(audioFromMessage({ text: 'hi' })).toBeNull();
    expect(audioFromMessage(undefined)).toBeNull();
  });
});
