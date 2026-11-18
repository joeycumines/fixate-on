// Parity between the operation classifier, the bare-objective detector, the canonical
// dispatch identity, and the read-only detector: every one must agree on the
// whole-token root rule (a root is followed by a space/tab or end-of-line,
// never another word character or a newline).
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
  ['status\nsecond line', 'set'],
  ['history --verbose', 'other'],
  ['list all', 'other'],
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
  ['fix the login bug', 'set'],
  ['--full', 'set'],
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
      'info',
      'history --verbose',
      'log',
      'list all',
      'ls',
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
      '--full',
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
    ]);
    for (const [line, op] of CASES) {
      const bare = isBareGoalObjective(line);
      const ro = isReadOnlyGoalCommand(line);
      // A bare objective is never read-only and vice versa (empty line is
      // read-only but not bare).
      expect(bare && ro).toBe(false);
      // 'other' means a dispatched non-clear root; exactly the read-only
      // roots dispatch as 'other' AND are read-only. Non-read-only 'other'
      // roots (pause/handback/review...) are not read-only.
      if (op === 'other') {
        const root = line.trim().toLowerCase().split(/[ \t]/)[0] ?? '';
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
  });
});
