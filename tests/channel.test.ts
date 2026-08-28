import { describe, it, expect } from 'vitest';
import { channelCommand } from '../src/plugins/channel';

describe('channelCommand', () => {
  it('passes through a real slash command', () => {
    expect(channelCommand('/decorate hello')).toEqual({ cmd: 'decorate', full: '/decorate hello' });
    expect(channelCommand('/id')).toEqual({ cmd: 'id', full: '/id' });
  });
  it('strips a @botname suffix from the command name', () => {
    expect(channelCommand('/tr@MyBot مرحبا')).toEqual({ cmd: 'tr', full: '/tr@MyBot مرحبا' });
  });
  it('resolves an Arabic alias to its command', () => {
    expect(channelCommand('زخرف كلمه')).toEqual({ cmd: 'decorate', full: '/decorate كلمه' });
    expect(channelCommand('اقتباس')).toEqual({ cmd: 'quote', full: '/quote' });
  });
  it('returns null for plain text and empties', () => {
    expect(channelCommand('مرحبا بالجميع')).toBeNull();
    expect(channelCommand('')).toBeNull();
    expect(channelCommand('   ')).toBeNull();
  });
});
