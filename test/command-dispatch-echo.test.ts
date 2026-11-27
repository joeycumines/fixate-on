import {expect, spyOn, test} from 'bun:test';
import {
  isSlashEchoMessage,
  markSlashDispatch,
  recordSlashEchoMessage,
} from '../src/command-dispatch.ts';
import {createIdleStateFixture, idleAssistant} from './idle-state-fixture.ts';

for (const delivery of [undefined, 'queue'] as const) {
  test(`a recognized ${delivery ?? 'ordinary'} slash echo stays classified when idle is delayed`, async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const sessionID = `delayed-echo-${delivery ?? 'ordinary'}`;
      const fixture = createIdleStateFixture({sessionID});
      const echo = {
        id: 'slash-echo',
        role: 'user',
        delivery,
        time: {created: 1001},
        parts: [{type: 'text', text: 'status'}],
      };
      markSlashDispatch(sessionID, 'status');
      const input = {sessionID, messageID: echo.id};
      await fixture.hooks['chat.message']!(input, {parts: echo.parts});
      expect(isSlashEchoMessage(sessionID, echo.id)).toBe(true);
      const assistant = idleAssistant(
        'prior-assistant',
        'Useful progress.',
        100,
        {
          time: {created: 999},
        },
      );
      // A read-only command or a failed turn can leave the replay as the newest
      // persisted user message. A queued replay is scanned even behind a reply.
      fixture.setMessages(
        delivery
          ? [
              echo,
              {
                ...assistant,
                time: {created: 2000},
              },
            ]
          : [assistant, echo],
      );
      clock.mockReturnValue(10_000);
      await fixture.idle();
      expect(fixture.machine.state.status).toBe('active');
      expect(
        fixture.machine.state.history.some(
          entry =>
            entry.type === 'notice' && entry.detail.includes('Queued message'),
        ),
      ).toBe(false);
      expect(fixture.announcements).toHaveLength(0);
      expect(fixture.prompts).toHaveLength(1);

      // Only the known ID is suppressed: identical later human text still wins.
      fixture.setMessages([
        assistant,
        {
          ...echo,
          id: 'genuine-human-input',
          delivery: undefined,
          time: {created: 10_001},
        },
      ]);
      await fixture.idle();
      expect(fixture.machine.state.status).toBe('paused');
      expect(fixture.machine.state.stopReason).toBe('user intervention');
    } finally {
      clock.mockRestore();
    }
  });
}

test('echo identity memory is bounded per session and repeated IDs consume one slot', () => {
  const sessionID = 'bounded-echo-identities';
  recordSlashEchoMessage(sessionID, 'first');
  for (let index = 1; index < 256; index++)
    recordSlashEchoMessage(sessionID, `echo-${index}`);
  for (let index = 0; index < 256; index++)
    recordSlashEchoMessage(sessionID, 'echo-255');
  expect(isSlashEchoMessage(sessionID, 'first')).toBe(true);
  recordSlashEchoMessage(sessionID, 'newest');
  expect(isSlashEchoMessage(sessionID, 'first')).toBe(false);
  expect(isSlashEchoMessage(sessionID, 'newest')).toBe(true);
});

test('echo identity memory is bounded across sessions', () => {
  const oldest = 'oldest-echo-session';
  recordSlashEchoMessage(oldest, 'echo');
  for (let index = 0; index < 256; index++)
    recordSlashEchoMessage(`echo-session-${index}`, 'echo');
  expect(isSlashEchoMessage(oldest, 'echo')).toBe(false);
  expect(isSlashEchoMessage('echo-session-255', 'echo')).toBe(true);
});
