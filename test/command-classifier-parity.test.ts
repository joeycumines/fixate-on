// Parity between the operation classifier, the bare-objective detector, the canonical
// dispatch identity, and the read-only detector: every one must agree on the
// execution grammar. Lifecycle roots require a horizontal separator; reporting
// commands retain their documented flag/whitespace forms, including bare --full.
import {describe, expect, test} from 'bun:test';
import {
  canonicalGoalDispatch,
  classifyGoalCommandOperation,
  isBareGoalObjective,
  isReadOnlyGoalCommand,
  type GoalCommandOperation,
} from '../src/commands-args.ts';

const CASES: Array<[string, GoalCommandOperation]> = [
  // [line, expected classifyGoalCommandOperation]
  ['clear the stale cache', 'set'],
  ['clear stale-cache', 'clear'],
  ['clear', 'clear'],
  ['clear\nplain multiline objective', 'set'],
  ['status-page needs dark mode', 'set'],
  ['status', 'other'],
  ['status --full', 'other'],
  ['status\n--full', 'other'],
  ['status\nsecond line', 'set'],
  ['history --verbose', 'other'],
  ['history\n--full', 'other'],
  ['list all', 'other'],
  ['list\nall', 'other'],
  ['ls', 'other'],
  ['info', 'other'],
  ['log', 'other'],
  ['resume', 'resume'],
  ['resume abc', 'resume'],
  ['edit new objective', 'edit'],
  ['add new goal', 'add'],
  ['sequence a; b', 'sequence'],
  ['pause', 'other'],
  ['handback', 'other'],
  ['review', 'other'],
  ['review-payload', 'other'],
  ['fix the login bug', 'set'],
  // The command handler has always treated bare status flags as status output.
  ['--full', 'other'],
  ['--verbose', 'other'],
];

describe('classifier / bare-objective / canonical / read-only parity', () => {
  for (const [line, expectedOp] of CASES) {
    test(`classify(${JSON.stringify(line)}) === ${expectedOp}`, () => {
      expect(classifyGoalCommandOperation(line)).toBe(expectedOp);
    });
  }

  test('read-only detector matches the reporting roots exactly', () => {
    const readOnly = [
      '',
      '   ',
      'status',
      'status --full',
      'status\n--full',
      'info',
      'history --verbose',
      'history\n--full',
      'log',
      'list all',
      'list\nall',
      'ls',
      '--full',
      '--verbose',
      'handback',
      'review',
      'review-payload',
    ];
    for (const line of readOnly) {
      expect(isReadOnlyGoalCommand(line)).toBe(true);
    }
    const notReadOnly = [
      'status-page needs dark mode',
      'status\nsecond line',
      'clear',
      'clear stale-cache',
      'pause',
      'resume',
      'edit x',
      'add x',
      'fix the login bug',
    ];
    for (const line of notReadOnly) {
      expect(isReadOnlyGoalCommand(line)).toBe(false);
    }
  });

  test('bare-objective and read-only are disjoint over the case set', () => {
    const READ_ONLY_ROOTS = new Set([
      'status',
      'info',
      'history',
      'log',
      'list',
      'ls',
      '--full',
      '--verbose',
      'handback',
      'review',
      'review-payload',
    ]);
    for (const [line, op] of CASES) {
      const bare = isBareGoalObjective(line);
      const ro = isReadOnlyGoalCommand(line);
      // A bare objective is never read-only and vice versa (empty line is
      // read-only but not bare).
      expect(bare && ro).toBe(false);
      // 'other' means a dispatched non-clear root; exactly the read-only
      // reporting roots and bare status flags dispatch as 'other' AND are
      // read-only; lifecycle roots such as pause are not read-only.
      if (op === 'other') {
        const root = line.trim().toLowerCase().split(/\s/)[0] ?? '';
        expect(ro).toBe(READ_ONLY_ROOTS.has(root));
      }
      if (op === 'set') {
        expect(ro).toBe(false);
      }
    }
  });

  test('canonical dispatch identity is stable across whitespace variants', () => {
    expect(canonicalGoalDispatch('  status  ')).toBe(
      canonicalGoalDispatch('status'),
    );
    // Newline after root is NOT a token separator: treated as bare objective.
    expect(canonicalGoalDispatch('clear\nx')).not.toBe(
      canonicalGoalDispatch('clear x'),
    );
    expect(classifyGoalCommandOperation('clear\nx')).toBe('set');
    expect(canonicalGoalDispatch('status-page x')).toBe(
      canonicalGoalDispatch('status-page x'),
    );
    expect(classifyGoalCommandOperation('status--full')).toBe('set');
    expect(classifyGoalCommandOperation('info--verbose')).toBe('set');
    expect(canonicalGoalDispatch('list ALL')).toBe(
      canonicalGoalDispatch('list all'),
    );
  });
});
