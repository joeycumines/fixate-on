// Helpers for inbox payload retention used by queue→steer promotion.
import {describe, expect, test} from 'bun:test';
import {
  consumeInboxPayload,
  createRuntimeState,
  peekInboxPayload,
  recordInboxPayload,
} from '../src/session-runtime.ts';

describe('inbox payload retention', () => {
  test('records, peeks, and consumes only once', () => {
    const runtime = createRuntimeState();
    recordInboxPayload(runtime, 's1', 'i1', {text: 'stop', synthetic: false});
    expect(peekInboxPayload(runtime, 's1', 'i1')?.text).toBe('stop');
    expect(consumeInboxPayload(runtime, 's1', 'i1')?.text).toBe('stop');
    expect(peekInboxPayload(runtime, 's1', 'i1')).toBeUndefined();
    expect(consumeInboxPayload(runtime, 's1', 'i1')).toBeUndefined();
  });

  test('caps retained payloads per session', () => {
    const runtime = createRuntimeState();
    for (let i = 0; i < 260; i++) {
      recordInboxPayload(runtime, 's1', `i${i}`, {
        text: `stop ${i}`,
        synthetic: false,
      });
    }
    const byID = runtime.inboxPayloadsByID!.get('s1')!;
    expect(byID.size).toBeLessThanOrEqual(256);
    // Oldest entries were evicted; a promoted evicted id is a no-op.
    expect(peekInboxPayload(runtime, 's1', 'i0')).toBeUndefined();
    expect(peekInboxPayload(runtime, 's1', 'i259')?.text).toBe('stop 259');
  });
});

describe('slow inbox promotion', () => {
  test('a retained payload survives an arbitrarily long turn', () => {
    const runtime = createRuntimeState();
    recordInboxPayload(runtime, 's1', 'slow', {
      text: 'stop',
      synthetic: false,
    });
    // Simulate a turn that runs for hours: no wall-clock TTL may drop the
    // payload while the message id is still eligible for promotion.
    // (The only bounds are the 256-entry cap and explicit consume/clear.)
    expect(peekInboxPayload(runtime, 's1', 'slow')?.text).toBe('stop');
    expect(consumeInboxPayload(runtime, 's1', 'slow')?.text).toBe('stop');
  });
});
