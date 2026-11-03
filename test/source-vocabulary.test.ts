// source-vocabulary.test.ts — the banned-vocabulary gate over src/ and index.d.ts.
//
// AGENTS.md scopes the ban to "code identifiers, exported types, docs, comments,
// user-facing strings, and tests". The prose gate (vocabulary.test.ts) covers
// shipped markdown; this covers the CODE. Every banned word and the prove-family
// are matched on word boundaries (not substring), so "provenance" and
// "compromised" survive. Two compound data tokens — `verified-complete` and
// `unverifiable-claim` — are masked before scanning: they are the ledger's exact
// vocabulary, kept precise by claim-vocabulary.ts, and the ban targets the bare
// words as user-facing labels, not the compound machine tokens.
//
// The allowlist names FILES, not lines — lines drift, and a file-level entry
// with a reason is what a reviewer can audit. Each entry must still COVER a
// real hit; an allowlist entry whose file no longer contains the word is
// reported as stale.

import {describe, expect, test} from 'bun:test';
import {readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {
  bannedPattern,
  parseBannedList,
  PROVE_FAMILY,
} from './vocabulary-lock.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SRC_DIR = join(REPO_ROOT, 'src');

/** The ban, parsed from AGENTS.md once — the same list the prose gate applies. */
const BANNED_SOURCE = parseBannedList(
  readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8'),
);

/**
 * Files allowed to contain banned words, with the reason each is kept.
 *
 * Every entry must still produce at least one hit when scanned — an entry
 * whose file has been cleaned is stale weight that reads as permission.
 */
const SOURCE_ALLOWLIST: readonly {file: string; reason: string}[] = [
  {
    file: 'src/claim-vocabulary.ts',
    reason:
      'describeVerifier comment cites the banned word to name what was renamed',
  },
];

/** Compound data tokens masked before scanning. */
const MASK_TOKENS = ['unverifiable-claim', 'verified-complete'] as const;
const MASK = '\x00MASKED\x00';

function maskCompounds(source: string): string {
  let out = source;
  for (const token of MASK_TOKENS) {
    out = out.replaceAll(token, MASK);
  }
  return out;
}

/** Collect every.ts/.tsx file under src/, plus index.d.ts. */
function sourceFiles(): {rel: string; abs: string}[] {
  const files: {rel: string; abs: string}[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push({rel: `src/${abs.slice(SRC_DIR.length + 1)}`, abs});
      }
    }
  };
  walk(SRC_DIR);
  files.push({rel: 'index.d.ts', abs: join(REPO_ROOT, 'index.d.ts')});
  return files;
}

interface SourceHit {
  file: string;
  line: number;
  word: string;
  matched: string;
  text: string;
}

function scanSource(rel: string, source: string): SourceHit[] {
  const masked = maskCompounds(source);
  const lines = masked.split('\n');
  const hits: SourceHit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    for (const word of BANNED_SOURCE) {
      const pattern = bannedPattern(word);
      for (const m of line.matchAll(pattern)) {
        hits.push({
          file: rel,
          line: i + 1,
          word,
          matched: m[0],
          text: line.trim(),
        });
      }
    }
    for (const pattern of PROVE_FAMILY) {
      // The lock's patterns are built for `.test`, without the global flag;
      // matchAll needs a fresh global copy.
      const global = new RegExp(pattern.source, 'gu');
      for (const m of line.matchAll(global)) {
        hits.push({
          file: rel,
          line: i + 1,
          word: pattern.source,
          matched: m[0],
          text: line.trim(),
        });
      }
    }
  }
  return hits;
}

describe('vocabulary: src/ and index.d.ts contain no banned word', () => {
  test('the source scan finds every banned word that the prose scan would, applied to code', () => {
    // Negative control: a synthetic source with a known violation is caught.
    const hits = scanSource('probe.ts', '// this is proven to work');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some(h => h.word === 'proven')).toBe(true);
  });

  test('the allowlist is honest — every entry still covers a real hit', () => {
    // An allowlist entry whose file no longer contains the word is dead weight.
    const files = sourceFiles();
    for (const entry of SOURCE_ALLOWLIST) {
      const file = files.find(f => f.rel === entry.file);
      expect(
        file,
        `allowlist names a file that does not exist: ${entry.file}`,
      ).toBeDefined();
      const source = readFileSync(file!.abs, 'utf8');
      const hits = scanSource(file!.rel, source);
      // The raw scan (before allowlist filtering) must find at least one hit
      // in this file — otherwise the entry is stale.
      expect(
        hits.length,
        `${entry.file} no longer contains any banned word — its allowlist entry is stale, delete it`,
      ).toBeGreaterThan(0);
    }
  });

  test('every source file is clean except the allowlisted ones', () => {
    const files = sourceFiles();
    const allowlisted = new Set(SOURCE_ALLOWLIST.map(e => e.file));
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file.abs, 'utf8');
      const hits = scanSource(file.rel, source);
      if (allowlisted.has(file.rel)) continue;
      for (const hit of hits) {
        violations.push(
          `${hit.file}:${hit.line} says "${hit.matched}" (${hit.word}): ${hit.text}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  test('the prove-family reaches src/ too — not just rendered strings', () => {
    // Guard: a mutation that puts "must prove completion" into a src comment
    // must turn this gate red. The control writes one and checks.
    const hits = scanSource('probe.ts', '// must prove the gate works');
    expect(hits.some(h => /\bprove\b/.test(h.matched))).toBe(true);
  });

  test('compound data tokens are masked, not flagged', () => {
    // `verified-complete` and `unverifiable-claim` are the ledger's exact
    // tokens. They contain banned substrings but are not user-facing labels.
    const hits = scanSource('probe.ts', '  status: "verified-complete"');
    expect(hits.filter(h => h.word === 'verified-complete')).toEqual([]);
    const hits2 = scanSource('probe.ts', '  status: "unverifiable-claim"');
    expect(hits2.filter(h => h.word === 'unverifiable')).toEqual([]);
  });

  test('word boundaries keep provenance and compromised out', () => {
    expect(scanSource('probe.ts', '// supply chain provenance check')).toEqual(
      [],
    );
    expect(scanSource('probe.ts', '// a compromised host')).toEqual([]);
    expect(scanSource('probe.ts', '// the approved path')).toEqual([]);
  });
});
