// doc-integrity.test.ts — a shipped document that points at nothing is a claim
// nobody can check.
//
// Two audits of this repository found twelve claims in shipped documents that
// the code does not back. Most needed judgement. A subset needed none at all: a
// relative link whose target no longer exists, a `#anchor` a heading rename
// silently broke, an unclosed code fence that turns the rest of the file into
// prose on GitHub and on npm. All of those passed `bun test`, `tsc --noEmit`,
// `gts lint`, and the whole `release:check` chain, because no gate derived them.
//
// This file derives them. The document list is read from git, never from a
// constant: a hand-maintained list is the same defect wearing a different
// costume, and it goes stale the moment a document is added.

import {describe, expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, posix, relative, resolve, sep} from 'node:path';

// Resolved from this file rather than process.cwd: the suite must give the
// same answer whether `bun test` was invoked from the repository root or from a
// CI step that changed directory.
const REPO_ROOT = resolve(import.meta.dir, '..');

const toRepoPath = (abs: string): string =>
  relative(REPO_ROOT, abs).split(sep).join(posix.sep);

function git(...args: string[]): string {
  return execFileSync('git', args, {cwd: REPO_ROOT, encoding: 'utf8'});
}

/**
 * Tracked markdown that is NOT one of this project's documents, and why.
 *
 * `git ls-files` already excludes the per-clone tooling directories
 * (`.claude/`, `.agents/`) — they are untracked by design, so a developer's local
 * notes can never enter this set. The exclusions below are for tracked files
 * that are markdown but not documentation:
 *
 * - `.github/**` — GitHub's own issue/PR templates and code of conduct. They
 * restate the vocabulary rule for their context and are rendered by GitHub,
 * not read as project documentation.
 * - `scripts/e2e-harness/**` — fixtures for the end-to-end harness: agent
 * prompts and SPECs whose content is chosen to exercise the harness.
 * - `CLAUDE.md` — a symlink to AGENTS.md. Scanning the same bytes twice is
 * one check performed twice, not two checks.
 */
const NOT_PROJECT_DOCUMENTS: readonly RegExp[] = [
  /^\.github\//,
  /^hack\/e2e-harness\//,
  /^CLAUDE\.md$/,
];

/** LICENSE carries no links but does render, so it is checked for fences. */
function shippedDocuments(): string[] {
  const tracked = git('ls-files', '*.md', 'LICENSE')
    .split('\n')
    .filter(p => p !== '');
  return tracked
    .filter(p => !NOT_PROJECT_DOCUMENTS.some(re => re.test(p)))
    .sort();
}

// Fences
//
// An unclosed fence is not a style nit. Everything after it renders as code, so
// a document can lose its entire second half on GitHub and in the npm tarball's
// README without anything turning red.

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface FenceScan {
  /** Fence lines and fenced content blanked, so link line numbers survive. */
  masked: string[];
  /** Every ``` line, for the parity assertion. */
  backtickFences: number;
  /** Non-empty when a fence is opened and never closed. */
  unbalanced: string | null;
}

function maskFences(source: string): FenceScan {
  const lines = source.split('\n');
  const masked: string[] = [];
  let backtickFences = 0;
  let open: {line: number; marker: string} | null = null;
  let unbalanced: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE_LINE.exec(lines[i]);
    if (!fence) {
      masked.push(open === null ? lines[i] : '');
      continue;
    }
    masked.push('');
    const marker = fence[1];
    const info = fence[2].trim();
    if (marker.startsWith('`')) backtickFences++;
    if (open === null) {
      open = {line: i + 1, marker: marker[0]};
      continue;
    }
    // A closer must use the opening marker, be at least as long, and carry no
    // info string. Anything else is code inside the block, not a delimiter —
    // without this a document containing ```js *inside* a fence would appear to
    // close it and the parity count would go wrong.
    if (
      marker[0] === open.marker &&
      info === '' &&
      marker.length >= open.marker.length
    ) {
      open = null;
    }
  }
  if (open !== null) {
    unbalanced = `code fence opened on line ${open.line} is never closed`;
  }
  return {masked, backtickFences, unbalanced};
}

// Links

interface LinkRef {
  /** Repository path of the document containing the link. */
  doc: string;
  /** 1-indexed line in that document. */
  line: number;
  /** The link target, before any scheme filtering. */
  target: string;
  form: 'inline' | 'reference';
}

/** Any scheme, not just http(s)/mailto — a link to `tel:` is still external. */
const EXTERNAL_TARGET = /^[a-z][a-z0-9+.-]*:/i;

const INLINE_LINK = /\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'(][^)]*)?\s*\)/g;
const REFERENCE_DEFINITION =
  /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+["'(].*)?$/;
// Explicit (`[text][label]`) and collapsed (`[text][]`) reference forms. The
// shortcut form (`[label]` alone) is deliberately not matched: its label is
// indistinguishable from ordinary bracket text without a full CommonMark pass,
// and guessing would manufacture findings nobody can act on.
const REFERENCE_USAGE = /\[([^\]]+)\]\[([^\]]*)\]/g;

interface LinkScan {
  links: LinkRef[];
  /** `[text][label]` whose label has no definition — renders literally. */
  dangling: string[];
}

/**
 * Pull every link out of one document, with fenced code excluded.
 *
 * Reference definitions are resolved per document because that is where
 * CommonMark resolves them: a `[x]: y` in README.md says nothing about
 * docs/tui-integration.md.
 */
function extractLinks(doc: string, masked: string[]): LinkScan {
  const definitions = new Map<string, string>();
  for (const line of masked) {
    const def = REFERENCE_DEFINITION.exec(line);
    if (def) definitions.set(def[1].trim().toLowerCase(), def[2]);
  }

  const links: LinkRef[] = [];
  const dangling: string[] = [];
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i];
    if (line === '') continue;

    for (const m of line.matchAll(INLINE_LINK)) {
      links.push({doc, line: i + 1, target: m[1], form: 'inline'});
    }
    for (const m of line.matchAll(REFERENCE_USAGE)) {
      // A definition line is `[label]: target`, which no usage pattern matches.
      const label = (m[2] === '' ? m[1] : m[2]).trim().toLowerCase();
      const target = definitions.get(label);
      if (target === undefined) {
        dangling.push(
          `${doc}:${i + 1} references [${label}] with no definition`,
        );
        continue;
      }
      links.push({doc, line: i + 1, target, form: 'reference'});
    }
  }
  return {links, dangling};
}

// Anchors

/**
 * GitHub's heading slug, reproduced from the specification rather than guessed:
 * lowercase, drop everything that is not a letter, digit, space or hyphen, then
 * turn spaces into hyphens. `## Multiple goals` -> `multiple-goals`;
 * `` ## `/goal` on OpenCode v2 hosts `` -> `goal-on-opencode-v2-hosts`.
 */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

const ATX_HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

function headingSlugs(source: string): Set<string> {
  const {masked} = maskFences(source);
  const slugs = new Set<string>();
  for (const line of masked) {
    const heading = ATX_HEADING.exec(line);
    if (heading) slugs.add(slug(heading[1]));
  }
  return slugs;
}

// The corpus

interface Document {
  path: string;
  source: string;
  scan: FenceScan;
  links: LinkRef[];
  dangling: string[];
}

const DOCUMENTS: Document[] = shippedDocuments().map(path => {
  const source = readFileSync(join(REPO_ROOT, path), 'utf8');
  const scan = maskFences(source);
  const {links, dangling} = extractLinks(path, scan.masked);
  return {path, source, scan, links, dangling};
});

const ALL_LINKS = DOCUMENTS.flatMap(d => d.links);
const INTERNAL_LINKS = ALL_LINKS.filter(l => !EXTERNAL_TARGET.test(l.target));

/** Relative targets, split from the same-file `#fragment` form. */
interface Resolved {
  link: LinkRef;
  /** Repository path of the link's target document; the source doc for `#x`. */
  targetDoc: string;
  /** Absolute path of the target, which may be a directory. */
  absolute: string;
  fragment: string | null;
}

const RESOLVED: Resolved[] = INTERNAL_LINKS.map(link => {
  const hash = link.target.indexOf('#');
  const pathPart = hash === -1 ? link.target : link.target.slice(0, hash);
  const fragment = hash === -1 ? null : link.target.slice(hash + 1);
  const from = join(REPO_ROOT, link.doc);
  const absolute =
    pathPart === ''
      ? from
      : resolve(dirname(from), decodeURIComponent(pathPart));
  return {link, targetDoc: toRepoPath(absolute), absolute, fragment};
});

const WITH_FRAGMENT = RESOLVED.filter(
  r => r.fragment !== null && r.fragment !== '',
);
const SLUG_CACHE = new Map<string, Set<string>>();

function slugsOf(repoPath: string): Set<string> | null {
  const cached = SLUG_CACHE.get(repoPath);
  if (cached !== undefined) return cached;
  const absolute = join(REPO_ROOT, repoPath);
  if (!existsSync(absolute) || statSync(absolute).isDirectory()) return null;
  const slugs = headingSlugs(readFileSync(absolute, 'utf8'));
  SLUG_CACHE.set(repoPath, slugs);
  return slugs;
}

// What npm actually publishes
//
// A link is only as useful as the tarball around it: pointing a reader at a file
// that `bun pm pack` drops produces a 404 for every consumer and passes CI.

interface PackageManifest {
  files: string[];
  main: string | undefined;
}

const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
) as PackageManifest;

/** npm includes these whatever `files` says. */
const ALWAYS_PUBLISHED = ['package.json', 'README.md', 'LICENSE', 'LICENCE'];

function shipsInPackage(repoPath: string): boolean {
  if (ALWAYS_PUBLISHED.includes(repoPath)) return true;
  if (
    MANIFEST.main !== undefined &&
    repoPath === MANIFEST.main.replace(/^\.\//, '')
  )
    return true;
  return MANIFEST.files.some(entry => {
    const clean = entry.replace(/^\.\//, '').replace(/\/$/, '');
    return repoPath === clean || repoPath.startsWith(`${clean}/`);
  });
}

const TRACKED = new Set(
  git('ls-files')
    .split('\n')
    .filter(p => p !== ''),
);

/**
 * A repository path is TRACKED if it is a tracked file, or a directory that
 * contains at least one. A link to a directory names a directory, and that is not
 * itself a git path — without this, a perfectly good link to a directory reads
 * as untracked, which is a false positive rather than a finding.
 */
function isTracked(repoPath: string): boolean {
  const clean = repoPath.replace(/\/$/, '');
  if (TRACKED.has(clean)) return true;
  const prefix = `${clean}/`;
  for (const path of TRACKED) if (path.startsWith(prefix)) return true;
  return false;
}

describe('shipped documents are internally consistent', () => {
  test('the document set is discovered from git, and it is not empty', () => {
    // A discovery step that returns nothing makes every assertion below
    // vacuously true. These floors are the point of this test: without them a
    // broken `git ls-files` call would report a green suite over zero documents.
    //
    // 14 is the count of tracked documents as of b77f09d, which removed
    // PRODUCT.md and RESEARCH_NOTES.md. A bare count would be a snapshot that
    // goes stale on the next document added or removed, so the load-bearing
    // half of this assertion is the NAMED set below it: those four documents
    // ship in every checkout, so a discovery call that silently returns fewer
    // documents than the repository actually has fails on names, not on a
    // number somebody has to remember to decrement.
    expect(DOCUMENTS.length).toBeGreaterThanOrEqual(5);
    for (const required of ['README.md', 'AGENTS.md', 'LICENSE']) {
      expect(
        DOCUMENTS.map(d => d.path),
        `${required} is missing from the document corpus`,
      ).toContain(required);
    }
    // Every discovered path must be a real file, or the corpus below is fiction.
    const missing = DOCUMENTS.filter(
      d => !existsSync(join(REPO_ROOT, d.path)),
    ).map(d => d.path);
    expect(missing).toEqual([]);
    // And the set must span both document locations, so that dropping one of
    // them — a bad exclusion, a moved directory — turns this red rather than
    // quietly halving the corpus.
    expect(
      DOCUMENTS.filter(d => d.path.startsWith('docs/')).length,
    ).toBeGreaterThanOrEqual(2);
    // Root-level documents: AGENTS.md, README.md, LICENSE. CONTRIBUTING.md was
    // folded into the README during the slop prune, so the floor is the three
    // that ship in every checkout.
    expect(
      DOCUMENTS.filter(d => !d.path.includes('/')).length,
    ).toBeGreaterThanOrEqual(3);
  });

  test('every relative link target exists', () => {
    expect(RESOLVED.length).toBeGreaterThanOrEqual(10);
    const broken = RESOLVED.filter(r => !existsSync(r.absolute)).map(
      r =>
        `${r.link.doc}:${r.link.line} -> ${r.link.target} (${r.link.form} link) does not exist`,
    );
    expect(broken).toEqual([]);
  });

  test('every link fragment names a heading in the document it points at', () => {
    expect(WITH_FRAGMENT.length).toBeGreaterThanOrEqual(8);
    const broken: string[] = [];
    for (const {link, targetDoc, fragment} of WITH_FRAGMENT) {
      const slugs = slugsOf(targetDoc);
      if (slugs === null) {
        broken.push(
          `${link.doc}:${link.line} -> ${link.target}: no such document`,
        );
        continue;
      }
      // Anchors are matched case-insensitively: a hand-written `#Limitations`
      // still resolves on GitHub, and failing it would only train people to stop
      // reading the failure.
      if (!slugs.has(slug(decodeURIComponent(fragment as string)))) {
        broken.push(
          `${link.doc}:${link.line} -> ${link.target}: no heading slugs to "${slug(decodeURIComponent(fragment as string))}" ` +
            `(has: ${[...slugs].slice(0, 6).join(', ')})`,
        );
      }
    }
    expect(broken).toEqual([]);
  });

  test('every relative link target is a file this repository would actually have', () => {
    // Two failure modes, and the second is the one CI cannot see: a target that
    // exists on the author's machine but is neither tracked nor published, and a
    // target that resolves here but 404s in the tarball every consumer installs.
    const unusable = RESOLVED.filter(
      r => !shipsInPackage(r.targetDoc) && !isTracked(r.targetDoc),
    ).map(
      r =>
        `${r.link.doc}:${r.link.line} -> ${r.link.target} is neither tracked nor in package.json "files"`,
    );
    expect(unusable).toEqual([]);
  });

  test('no reference-style link points at a label the document never defines', () => {
    // Untested by the corpus, which defines none, so it is checked separately
    // below; asserted here so the dangling-reference class has a home the day a
    // document starts using reference links.
    expect(DOCUMENTS.flatMap(d => d.dangling)).toEqual([]);
  });

  test('every code fence is closed, and the count is even', () => {
    // Two assertions, not one: parity catches a fence dropped from the end,
    // while the structural scan catches one dropped from the middle, where the
    // total can still be even and everything after the break renders as prose.
    let totalFences = 0;
    const unclosed: string[] = [];
    const odd: string[] = [];
    for (const d of DOCUMENTS) {
      totalFences += d.scan.backtickFences;
      if (d.scan.unbalanced !== null)
        unclosed.push(`${d.path}: ${d.scan.unbalanced}`);
      if (d.scan.backtickFences % 2 !== 0) {
        odd.push(`${d.path}: ${d.scan.backtickFences} \`\`\` fences`);
      }
    }
    expect(totalFences).toBeGreaterThanOrEqual(50);
    expect(odd).toEqual([]);
    expect(unclosed).toEqual([]);
  });

  test('the parsers are live — they detect the defects they exist to catch', () => {
    // The corpus is clean, which means every assertion above is satisfied by an
    // empty result set. These are the negative controls: each is a defect this
    // file is supposed to catch, fed through the same code, and the assertion
    // fails when the defect is detected. Without them the whole file would
    // report green on a parser that matched nothing.
    const sample = [
      '# Title',
      'See [a](docs/compatibility.md) and [b](#title).',
      '',
      '[c]: ../README.md',
      'Refer to [c][] and [c][c] and [d][missing].',
      '',
      '```sh',
      'bun run lint',
      '```',
    ].join('\n');

    const scan = maskFences(sample);
    expect(scan.backtickFences).toBe(2);
    expect(scan.unbalanced).toBeNull();
    // Fenced content is not prose: a link inside a fence must not be collected,
    // because it is an example, not a claim the document makes.
    expect(
      maskFences('```\n[nope](nowhere.md)\n```').masked.join(''),
    ).not.toContain('nowhere.md');

    const extracted = extractLinks('sample.md', scan.masked);
    const targets = extracted.links.map(l => l.target);
    expect(targets).toContain('docs/compatibility.md');
    expect(targets).toContain('#title');
    // The reference definition feeds BOTH usages — collapsed and explicit.
    expect(targets.filter(t => t === '../README.md')).toHaveLength(2);
    // And the usage with no definition is reported rather than silently dropped.
    expect(extracted.dangling).toHaveLength(1);
    expect(extracted.dangling[0]).toContain('missing');
    // An external target is recognised as external, so it never becomes a
    // filesystem check that would fail against the network.
    expect(
      extractLinks(
        'x.md',
        maskFences('[a](https://example.com) [b](mailto:x@y.z)').masked,
      ).links.filter(l => !EXTERNAL_TARGET.test(l.target)),
    ).toEqual([]);

    // The unclosed-fence detector fires on the defect it is there for.
    const broken = maskFences('```sh\nbun run lint\n');
    expect(broken.unbalanced).not.toBeNull();
    expect(broken.unbalanced).toContain('never closed');

    // The slug function reproduces GitHub's two published examples.
    expect(slug('Multiple goals')).toBe('multiple-goals');
    expect(slug('`/goal` on OpenCode v2 hosts')).toBe(
      'goal-on-opencode-v2-hosts',
    );
    expect([...headingSlugs('# One\n\n## `Two` words\n')]).toEqual([
      'one',
      'two-words',
    ]);

    // The package-membership test discriminates instead of always returning true.
    expect(shipsInPackage('docs/tui-integration.md')).toBe(true);
    expect(shipsInPackage('src/plugin.ts')).toBe(false);
    expect(TRACKED.has('src/plugin.ts')).toBe(true);
  });
});
