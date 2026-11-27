import {describe, expect, test} from 'bun:test';
import {handleCommandOutcome} from '../src/commands.ts';
import {deserializeGoal, serializeGoal} from '../src/persistence.ts';
import {createIdleStateFixture, idleAssistant} from './idle-state-fixture.ts';

describe('progress evaluation remains scoped to one assistant turn', () => {
  test('repetitive text is counted once despite repeated idle events', async () => {
    const f = createIdleStateFixture();
    f.setMessages([
      idleAssistant('a1', 'Still working on the same thing.\n'.repeat(4), 10),
    ]);
    for (let n = 0; n < 5; n++) {
      await f.idle();
      expect(f.machine.snapshot().noProgressTurns).toBe(1);
    }
    expect(f.machine.snapshot().status).toBe('active');
    expect(f.errors).toEqual([]);
  });

  test('a keyless message cannot be counted as distinct stalled turns', async () => {
    const f = createIdleStateFixture();
    f.setMessages([idleAssistant(undefined, 'Continuing the analysis.', 10)]);
    for (let n = 0; n < 5; n++) {
      await f.idle();
      expect(f.machine.snapshot().noProgressTurns).toBe(0);
    }
    expect(f.machine.snapshot().status).toBe('active');
  });

  test('timestamp-only messages count distinct stalls and deduplicate repeats', async () => {
    const f = createIdleStateFixture({lastAssistantText: 'No new result.'});
    for (let n = 1; n <= 3; n++) {
      f.setMessages([
        idleAssistant(undefined, 'No new result.', 10, {
          time: {created: n * 1000, completed: n * 1000 + 1},
        }),
      ]);
      await f.idle();
      expect(f.machine.snapshot().noProgressTurns).toBe(n);
      await f.idle();
      expect(f.machine.snapshot().noProgressTurns).toBe(n);
    }
    expect(f.machine.snapshot().status).toBe('paused');
    expect(f.machine.snapshot().stopReason).toBe('no progress');
  });

  test('productive new prose breaks a previous stalled-turn streak', async () => {
    const f = createIdleStateFixture({
      noProgressTurns: 2,
      lastCountedProgressMessageID: 'prior',
      stalledTurnCounted: true,
      lastAssistantMessageID: 'prior',
      lastAssistantText: 'Prior stalled result.',
    });
    const productiveText =
      'I derived the result and identified the next requirement.';
    f.setMessages([idleAssistant('productive', productiveText, 100)]);
    await f.idle();
    expect(f.machine.snapshot().noProgressTurns).toBe(0);
    expect(f.machine.snapshot().stalledTurnCounted).toBe(false);
    // Re-observing productive work must preserve its progress decision.
    await f.idle();
    expect(f.machine.snapshot().noProgressTurns).toBe(0);
    f.setMessages([idleAssistant('next-stall', productiveText, 10)]);
    await f.idle();
    expect(f.machine.snapshot().noProgressTurns).toBe(1);
    expect(f.machine.snapshot().status).toBe('active');
  });

  test('new short prose never inherits the preceding turn stall flag', async () => {
    const f = createIdleStateFixture({
      noProgressTurns: 2,
      lastCountedProgressMessageID: 'prior',
      stalledTurnCounted: true,
      lastAssistantMessageID: 'prior',
      lastAssistantText: 'Old result.',
    });
    f.setMessages([idleAssistant('new', 'A new observation.', 10)]);
    await f.idle();
    expect(f.machine.snapshot().noProgressTurns).toBe(0);
    expect(f.machine.snapshot().stalledTurnCounted).toBeUndefined();
    await f.idle();
    expect(f.machine.snapshot().noProgressTurns).toBe(1);
    await f.idle();
    expect(f.machine.snapshot().noProgressTurns).toBe(1);
  });

  test('later tool evidence can clear a stall already counted on the same turn', async () => {
    const f = createIdleStateFixture({lastAssistantText: 'Working.'});
    f.setMessages([idleAssistant('a1', 'Working.', 10)]);
    await f.idle();
    expect(f.machine.snapshot().noProgressTurns).toBe(1);
    f.setMessages([
      idleAssistant('a1', 'Working.', 10, {
        parts: [
          {type: 'text', text: 'Working.'},
          {type: 'tool', name: 'read'},
        ],
      }),
    ]);
    await f.idle();
    expect(f.machine.snapshot().noProgressTurns).toBe(0);
    expect(f.machine.snapshot().stalledTurnCounted).toBe(false);
    f.setMessages([idleAssistant('a1', 'Working.', 10)]);
    await f.idle();
    expect(f.machine.snapshot().noProgressTurns).toBe(0);
  });
});

describe('progress state survives persistence and resets with its turn key', () => {
  test('all three evaluation states survive JSON persistence', () => {
    for (const flag of [undefined, false, true]) {
      const f = createIdleStateFixture({
        lastCountedProgressMessageID: 'a1',
        stalledTurnCounted: flag,
      });
      const restored = deserializeGoal(
        JSON.parse(JSON.stringify(serializeGoal(f.machine.snapshot()))),
      );
      expect(restored.lastCountedProgressMessageID).toBe('a1');
      expect(restored.stalledTurnCounted).toBe(flag);
    }
    expect(
      deserializeGoal({stalledTurnCounted: 'true'}).stalledTurnCounted,
    ).toBeUndefined();
  });

  test('a tentative persisted observation remains eligible for exactly one stall', async () => {
    const before = createIdleStateFixture();
    const message = idleAssistant('tentative', 'Continuing the analysis.', 10);
    before.setMessages([message]);
    await before.idle();
    const restored = deserializeGoal(
      JSON.parse(JSON.stringify(serializeGoal(before.machine.snapshot()))),
    );
    const after = createIdleStateFixture(restored);
    after.setMessages([message]);
    await after.idle();
    expect(after.machine.snapshot().noProgressTurns).toBe(1);
    await after.idle();
    expect(after.machine.snapshot().noProgressTurns).toBe(1);
  });

  test('recovery rearm clears both the persisted stall decision and its key', async () => {
    const before = createIdleStateFixture({
      noProgressTurns: 2,
      lastCountedProgressMessageID: 'before-restart',
      stalledTurnCounted: true,
    });
    const restored = deserializeGoal(serializeGoal(before.machine.snapshot()));
    const f = createIdleStateFixture(restored);
    await f.machine.transition('paused', {
      source: 'recovery',
      stopReason: 'recovery',
    });
    await f.machine.transition('active', {source: 'idle-handler'});
    expect(f.machine.snapshot()).toMatchObject({
      noProgressTurns: 0,
      lastCountedProgressMessageID: '',
      stalledTurnCounted: false,
    });
  });

  test('compaction clears the stall decision with its key and counters', async () => {
    const f = createIdleStateFixture({
      noProgressTurns: 2,
      lastCountedProgressMessageID: 'before-compaction',
      stalledTurnCounted: true,
    });
    await f.hooks.event!({
      type: 'session.compacted',
      sessionID: f.session.sessionID,
    });
    expect(f.machine.snapshot()).toMatchObject({
      noProgressTurns: 0,
      lastCountedProgressMessageID: '',
      stalledTurnCounted: false,
    });
    f.setMessages([idleAssistant('after-compaction', 'A short result.', 10)]);
    await f.idle();
    await f.idle();
    expect(f.machine.snapshot().noProgressTurns).toBe(1);
  });

  test('editing an active objective clears the old stall decision', async () => {
    const f = createIdleStateFixture({
      noProgressTurns: 2,
      lastCountedProgressMessageID: 'before-edit',
      stalledTurnCounted: true,
    });
    const result = await handleCommandOutcome(
      'edit Complete the revised analysis',
      f.session,
    );
    expect(result.ok).toBe(true);
    expect(f.machine.snapshot()).toMatchObject({
      noProgressTurns: 0,
      lastCountedProgressMessageID: '',
      stalledTurnCounted: false,
    });
  });
});
