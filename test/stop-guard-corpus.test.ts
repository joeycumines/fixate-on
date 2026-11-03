// stop-guard-corpus.test.ts — Verify the rebuilt phrase triage against the
// 16-case adversarial corpus (guard-corpus.tsv).
//
// GROUNDING: the adversarial corpus documents the result as
// total=16 tp=6 fp=4 fn=2 tn=4. These counts are "deliberately adversarial
// regression set... not precision or recall estimates".
// The false positives (negation, quotation, genuine blockers, material
// questions) and false negatives (terse "Done.", "migration pending") are
// the documented product boundary, retained deliberately. This is why the
// triage is ADVISORY and cannot override the verifier.
//
// A drift in these counts signals a pattern regression and MUST fail.

import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {scanPrematureExit} from '../src/stop-guard.ts';

interface CorpusRow {
  id: string;
  truth: string;
  expectedBlock: boolean;
  message: string;
}

function loadCorpus(): CorpusRow[] {
  const path = join(import.meta.dir, 'fixtures', 'guard-corpus.tsv');
  const text = readFileSync(path, 'utf8');
  const lines = text.trim().split('\n');
  // Skip header line.
  return lines.slice(1).map(line => {
    // TSV: id, truth, expected_block, message. The message may contain tabs.
    const parts = line.split('\t');
    if (parts.length < 4) {
      throw new Error(`malformed corpus row: ${line}`);
    }
    const [id, truth, expectedBlock, ...rest] = parts;
    const message = rest.join('\t');
    return {
      id,
      truth,
      expectedBlock: expectedBlock.trim() === 'true',
      message,
    };
  });
}

describe('stop-guard phrase triage corpus (guard-corpus.tsv)', () => {
  const corpus = loadCorpus();

  test('corpus has exactly 16 rows', () => {
    expect(corpus).toHaveLength(16);
  });

  test('matches documented corpus counts: tp=6 fp=4 fn=2 tn=4', () => {
    // Counts are measured against `truth` (INCOMPLETE = a true premature exit),
    // NOT against `expected_block` (which is the corpus's own annotation).
    // tp = matched AND truth is INCOMPLETE (a true premature exit caught)
    // fp = matched AND truth is NOT INCOMPLETE (a legitimate completion blocked)
    // fn = not matched AND truth is INCOMPLETE (a premature exit missed)
    // tn = not matched AND truth is NOT INCOMPLETE (a legitimate completion allowed)
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const row of corpus) {
      const verdict = scanPrematureExit(row.message);
      const matched = verdict.tier === 'phrase';
      const isIncomplete = row.truth === 'INCOMPLETE';
      if (matched && isIncomplete) tp++;
      else if (matched && !isIncomplete) fp++;
      else if (!matched && isIncomplete) fn++;
      else tn++;
    }
    expect({total: corpus.length, tp, fp, fn, tn}).toEqual({
      total: 16,
      tp: 6,
      fp: 4,
      fn: 2,
      tn: 4,
    });
  });

  test('advisory verdict never carries a block field', () => {
    for (const row of corpus) {
      const verdict = scanPrematureExit(row.message);
      // The verdict is {tier, reason}. There is no `block` property — the
      // triage cannot block; the verifier is authoritative.
      expect(verdict).not.toHaveProperty('block');
      expect(verdict.tier === 'phrase' || verdict.tier === 'none').toBe(true);
    }
  });

  test('phrase tier always returns the fixed PHRASE_REASON', () => {
    for (const row of corpus) {
      const verdict = scanPrematureExit(row.message);
      if (verdict.tier === 'phrase') {
        expect(verdict.reason).toBe(
          'Language triage found an explicit unfinished-work or deferral signal. ' +
            'Check the live completion contract now. Continue if required state or ' +
            'verification is missing; otherwise report COMPLETE, BLOCKED, ' +
            'NEEDS_INPUT, or authorized CANCELLED with evidence.',
        );
      } else {
        expect(verdict.reason).toBe('');
      }
    }
  });

  // Documented false negatives — retained as the product boundary.
  test("false negatives: terse 'Done.' and 'migration is pending' escape", () => {
    const done = corpus.find(r => r.id === 'unfinished-terse');
    const pending = corpus.find(r => r.id === 'unfinished-pending');
    expect(done).toBeDefined();
    expect(pending).toBeDefined();
    expect(scanPrematureExit(done!.message).tier).toBe('none');
    expect(scanPrematureExit(pending!.message).tier).toBe('none');
  });

  // Documented false positives — retained as the product boundary. They do
  // NOT block completion because the triage is advisory.
  test('false positives: negation, quoted, blocked, needs-input match', () => {
    const negation = corpus.find(r => r.id === 'complete-negation');
    const quoted = corpus.find(r => r.id === 'complete-quoted');
    const blocked = corpus.find(r => r.id === 'blocked-with-signal');
    const needsInput = corpus.find(r => r.id === 'needs-input-with-signal');
    expect(scanPrematureExit(negation!.message).tier).toBe('phrase');
    expect(scanPrematureExit(quoted!.message).tier).toBe('phrase');
    expect(scanPrematureExit(blocked!.message).tier).toBe('phrase');
    expect(scanPrematureExit(needsInput!.message).tier).toBe('phrase');
  });

  // The word-boundary anchors prevent the bare-pattern false positives the
  // the prior implementation produced. A verified completion containing
  // "for now" or "eventuallyConsistent" must NOT trip.
  test('word-boundary anchors prevent substring false positives', () => {
    // "for now" was a bare pattern in an earlier revision; there is no equivalent here. A
    // verified completion mentioning "for now" must not trip.
    expect(
      scanPrematureExit('All tests pass for now and forever. Verified.').tier,
    ).toBe('none');
    // "eventuallyConsistent" must not trip the defunct /eventually/i.
    expect(
      scanPrematureExit(
        'The eventuallyConsistent field is implemented and verified.',
      ).tier,
    ).toBe('none');
    // "followXup" must not trip follow-up.
    expect(scanPrematureExit('The followXup fixture passes.').tier).toBe(
      'none',
    );
  });
});
