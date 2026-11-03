/**
 * Handback deliverables engine for fixate-on.
 *
 * Handles reviewable diff generation, known-risk sites enumeration (e.g. database
 * migrations, auth changes), external-review payload generation compatible with
 * OSM code review workflows, and full handback deliverable assembly.
 */

import type {ClaimRecord, GoalState, RunBaseline} from './state-machine.ts';
import {claimQualityLabel, describeVerifier} from './claim-vocabulary.ts';

export interface RiskSite {
  readonly file: string;
  readonly category:
    | 'db-migration'
    | 'auth-security'
    | 'env-secrets'
    | 'persistence-schema'
    | 'custom';
  readonly description: string;
}

export interface RiskClassRule {
  readonly category: RiskSite['category'];
  readonly pattern: RegExp;
  readonly description: string;
}

export interface ReviewableDiff {
  readonly files: ReadonlyArray<string>;
  readonly insertions: number;
  readonly deletions: number;
  readonly stat: string;
  readonly patch: string;
  readonly riskSites: ReadonlyArray<RiskSite>;
}

export interface ExternalReviewPayload {
  readonly goalId: string;
  readonly objective: string;
  readonly status: string;
  readonly diffStats: string;
  readonly riskSites: ReadonlyArray<RiskSite>;
  readonly rawPayload: string;
}

export interface HandbackDeliverable {
  readonly goalId: string;
  readonly sessionID: string;
  readonly condition: string;
  readonly status: string;
  readonly createdAt: number;
  readonly finishedAt: number | null;
  readonly totalTokens: number;
  readonly turnCount: number;
  readonly claims: ReadonlyArray<ClaimRecord>;
  readonly diff: ReviewableDiff;
  readonly externalReviewPayload: string;
}

export const DEFAULT_RISK_RULES: ReadonlyArray<RiskClassRule> = [
  {
    category: 'db-migration',
    pattern:
      /(^|\/)(migrations?|alembic|flyway|db\/migrate)\/|migration.*\.sql$|schema\.prisma$/i,
    description:
      'Database migration or schema definition change requiring operational review',
  },
  {
    category: 'auth-security',
    pattern: /(^|\/)(auth|jwt|crypto|permissions?|security)(\/|$|\.)/i,
    description:
      'Authentication, cryptographic, or security authorization boundary change',
  },
  {
    category: 'env-secrets',
    pattern:
      /(^|\/)\.env(\..+)?$|(^|\/)credentials(\..+)?$|(^|\/)(\w*\/)?secrets?(\..+)?$/i,
    description: 'Environment configuration or secret manifest',
  },
  {
    category: 'persistence-schema',
    pattern: /(^|\/)(state-machine\.ts|persistence\.ts|\.schema\.json)$/i,
    description:
      'Core state machine, persistence serialization, or schema contract modification',
  },
];

/**
 * Identify known-risk sites in a set of modified file paths based on defined patterns.
 */
export function scanRiskSites(
  files: ReadonlyArray<string>,
  customRules: ReadonlyArray<RiskClassRule> = [],
): RiskSite[] {
  const allRules = [...DEFAULT_RISK_RULES, ...customRules];
  const results: RiskSite[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const normalized = file.trim().replace(/\\/g, '/');
    if (!normalized) continue;

    for (const rule of allRules) {
      const key = `${normalized}:${rule.category}`;
      if (rule.pattern.test(normalized) && !seen.has(key)) {
        seen.add(key);
        results.push({
          file: normalized,
          category: rule.category,
          description: rule.description,
        });
      }
    }
  }

  return results;
}

interface GitRunResult {
  ok: boolean;
  stdout: string;
}

/**
 * Maximum execution time (in ms) allowed for an individual git command before aborting.
 *
 * Keeps all repository git operations bounded consistently to prevent hanging indefinitely
 * on blocked or locked git operations. Compound flows run multiple invocations bounded by
 * file-listing byte limits.
 */
const GIT_TIMEOUT_MS = 5_000;

/**
 * Executes a git command bounded by timeout and maximum output size to prevent
 * process hangs on blocked repositories.
 */
async function runGit(
  args: string[],
  cwd?: string,
  maxBytes = 2_097_152,
): Promise<GitRunResult> {
  const {runBounded} = await import('./bounded-spawn.ts');
  const result = await runBounded(
    'git',
    args,
    cwd || process.cwd(),
    GIT_TIMEOUT_MS,
    maxBytes,
  );
  return {ok: result.ok, stdout: result.stdout};
}

/** Count added lines in a unified diff body (excludes hunk and file headers). */
function countAddedLines(patch: string): number {
  return patch
    .split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
}

/** Count removed lines in a unified diff body (excludes hunk and file headers). */
function countRemovedLines(patch: string): number {
  return patch
    .split('\n')
    .filter(l => l.startsWith('-') && !l.startsWith('---')).length;
}

/**
 * Parses `git diff --stat` output into modified filenames, insertion count, and deletion count.
 */
export function parseDiffStat(statText: string): {
  files: string[];
  insertions: number;
  deletions: number;
} {
  const lines = statText
    .trim()
    .split('\n')
    .filter(l => l.trim().length > 0);
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of lines) {
    // Matches summary line, e.g.: "3 files changed, 45 insertions(+), 12 deletions(-)"
    const summaryMatch = line.match(
      /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
    );
    if (summaryMatch) {
      if (summaryMatch[2]) insertions = parseInt(summaryMatch[2], 10);
      if (summaryMatch[3]) deletions = parseInt(summaryMatch[3], 10);
      continue;
    }

    // Matches individual file entries, e.g.: " src/index.ts | 10 +++++-----"
    const fileMatch = line.match(/^\s*(.+?)\s*\|\s*\d+/);
    if (fileMatch && fileMatch[1]) {
      files.push(fileMatch[1].trim());
    }
  }

  return {files, insertions, deletions};
}

/**
 * Capture the state of the workspace at the moment a goal starts.
 *
 * Uses `git stash create` to record pre-existing uncommitted changes without modifying
 * the working directory, index, or HEAD. If the tree is clean, `stash create` prints
 * nothing and HEAD serves as the base.
 *
 * Pre-existing untracked files are hashed directly (using `git hash-object` without writing
 * to the object database) so they are not incorrectly attributed as new work created by the goal.
 */
export async function captureRunBaseline(
  cwd?: string,
): Promise<RunBaseline | null> {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!inside.ok || inside.stdout.trim() !== 'true') return null;

  const stash = await runGit(['stash', 'create'], cwd);
  const ref = stash.ok ? stash.stdout.trim() : '';

  const untracked: Array<{path: string; hash: string}> = [];
  const listing = await runGit(
    ['ls-files', '--others', '--exclude-standard'],
    cwd,
  );
  if (listing.ok && listing.stdout.trim()) {
    for (const path of listing.stdout
      .trim()
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)) {
      const hashed = await runGit(['hash-object', '--', path], cwd);
      if (hashed.ok) untracked.push({path, hash: hashed.stdout.trim()});
    }
  }

  return {ref, untracked, capturedAt: Date.now()};
}

/**
 * Reduce the full worktree change set to only changes introduced during this goal's execution.
 *
 * Compares against the run baseline:
 * - Pre-existing dirty files that remained identical are excluded.
 * - Pre-existing untracked files with matching hashes are excluded.
 * - Newly created files or modified files are included.
 *
 * Falls back to whole-worktree diff when no baseline exists.
 */
async function scopeToRun(
  cwd: string | undefined,
  baseline: RunBaseline | null | undefined,
  allFiles: string[],
): Promise<{files: string[]; stat: string; patch: string} | null> {
  if (!baseline) return null;
  const base = baseline.ref || 'HEAD';

  const statRes = await runGit(['diff', '--stat', base], cwd);
  const patchRes = await runGit(['diff', base], cwd);
  if (!statRes.ok && !patchRes.ok) return null;

  const parsed = parseDiffStat(statRes.stdout);
  const files = [...parsed.files];

  // Filter untracked files: exclude pre-existing files whose content matches the baseline hash.
  const baselineHashes = new Map(
    baseline.untracked.map((u: {path: string; hash: string}) => [
      u.path,
      u.hash,
    ]),
  );
  for (const path of allFiles) {
    if (baselineHashes.has(path)) {
      const hashed = await runGit(['hash-object', '--', path], cwd);
      if (hashed.ok && hashed.stdout.trim() === baselineHashes.get(path))
        continue;
    }
    if (!files.includes(path)) files.push(path);
  }

  const scopedFiles = files;

  const kept: string[] = [];
  const keptPatch: string[] = [];
  const patchSections = patchRes.stdout.split(/^diff --git /m);
  for (const section of patchSections) {
    if (!section.trim()) continue;
    const match = /^a\/(.+?) b\//.exec(section);
    const path = match ? match[1] : '';
    if (path && scopedFiles.includes(path)) {
      kept.push(path);
      keptPatch.push(`diff --git ${section}`);
    }
  }

  const statLines = statRes.stdout.split('\n').filter(line => {
    if (!line.trim() || /files? changed/.test(line)) return false;
    return scopedFiles.some(f => line.includes(f));
  });

  // Newly created files do not exist in the index and cannot be diffed against <base>.
  // Use `git diff --no-index -- /dev/null <path>` to generate unified diff hunks without
  // modifying repository state (avoiding `git add -N`). Note that diff --no-index exits with 1
  // when differences exist, so stdout is used regardless of ok status.
  const missing = scopedFiles.filter(
    f => !keptPatch.some(h => h.includes(`b/${f}`)),
  );
  for (const path of missing) {
    const rendered = await runGit(
      ['diff', '--no-index', '--', '/dev/null', path],
      cwd,
    );
    const body = rendered.stdout.trim();
    if (body) keptPatch.push(body);
  }

  return {
    files: scopedFiles,
    stat:
      statLines.length > 0
        ? `${statLines.join('\n')}\n`
        : 'No goal-scoped changes detected.',
    patch: keptPatch.join('\n').trim(),
  };
}

/**
 * Collect the reviewable diff for the current workspace / goal execution.
 * Captures both tracked diffs and untracked new files.
 */
export async function generateReviewableDiff(
  cwd?: string,
  customRules: ReadonlyArray<RiskClassRule> = [],
  baseline?: RunBaseline | null,
): Promise<ReviewableDiff> {
  const untrackedRes = await runGit(
    ['ls-files', '--others', '--exclude-standard'],
    cwd,
  );
  const untrackedAll =
    untrackedRes.ok && untrackedRes.stdout
      ? untrackedRes.stdout
          .trim()
          .split('\n')
          .map(f => f.trim())
          .filter(f => f.length > 0)
      : [];

  // Attempt baseline-scoped diffing first; fall back to entire worktree diff if no baseline exists.
  const scoped = await scopeToRun(cwd, baseline, untrackedAll);
  if (scoped) {
    const riskSites = scanRiskSites(scoped.files, customRules);
    return {
      files: scoped.files,
      insertions: countAddedLines(scoped.patch),
      deletions: countRemovedLines(scoped.patch),
      stat: scoped.stat,
      patch: scoped.patch,
      riskSites,
    };
  }

  const statRes = await runGit(['diff', '--stat', 'HEAD'], cwd);
  const patchRes = await runGit(['diff', 'HEAD'], cwd);

  if (!statRes.ok && !patchRes.ok && !untrackedRes.ok) {
    return {
      files: [],
      insertions: 0,
      deletions: 0,
      stat: 'No git changes detected or not in a git repository.',
      patch: '',
      riskSites: [],
    };
  }

  const parsed = parseDiffStat(statRes.stdout);
  const allFiles = [...parsed.files];
  let totalInsertions = parsed.insertions;
  const totalDeletions = parsed.deletions;
  let combinedStat = statRes.stdout.trim();
  let combinedPatch = patchRes.stdout.trim();

  if (untrackedRes.ok && untrackedRes.stdout) {
    const untrackedFiles = untrackedRes.stdout
      .trim()
      .split('\n')
      .map(f => f.trim())
      .filter(f => f.length > 0);
    for (const uFile of untrackedFiles) {
      if (!allFiles.includes(uFile)) {
        allFiles.push(uFile);
        const uDiff = await runGit(
          ['diff', '--no-index', '--', '/dev/null', uFile],
          cwd,
        );
        if (uDiff.stdout) {
          const uLines = uDiff.stdout
            .split('\n')
            .filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
          totalInsertions += uLines;
          combinedPatch = combinedPatch
            ? `${combinedPatch}\n\n${uDiff.stdout.trim()}`
            : uDiff.stdout.trim();
          combinedStat = combinedStat
            ? `${combinedStat}\n ${uFile} | ${uLines} +`
            : ` ${uFile} | ${uLines} +`;
        }
      }
    }
  }

  const riskSites = scanRiskSites(allFiles, customRules);

  return {
    files: allFiles,
    insertions: totalInsertions,
    deletions: totalDeletions,
    stat: combinedStat || 'No git changes detected.',
    patch: combinedPatch,
    riskSites,
  };
}

/**
 * Builds a paste-ready, one-shot code review payload compatible with osm review.
 * Byte-for-byte reproducible on repeat invocations given unchanged input.
 */
export function buildExternalReviewPayload(opts: {
  goalId: string;
  objective: string;
  status: string;
  diff: ReviewableDiff;
  lastClaim?: ClaimRecord | null;
  totalTokens?: number;
  turnCount?: number;
}): ExternalReviewPayload {
  const {
    goalId,
    objective,
    status,
    diff,
    lastClaim,
    totalTokens = 0,
    turnCount = 0,
  } = opts;

  // Present user-facing status using claim vocabulary rather than internal ledger tokens.
  const outcomeLabel = lastClaim
    ? `[${claimQualityLabel(lastClaim.outcome.status)}: ${describeVerifier(lastClaim.check)}${lastClaim.outcome.detail ? ` - ${lastClaim.outcome.detail}` : ''}]`
    : `[status: ${status}]`;

  const riskLines =
    diff.riskSites.length > 0
      ? diff.riskSites
          .map(r => `- **\`${r.file}\`** [${r.category}]: ${r.description}`)
          .join('\n')
      : '- *No critical risk sites flagged by standard rules (no DB migrations, secrets, or auth boundary edits).*';

  const patchBlock = diff.patch
    ? `\`\`\`diff\n${diff.patch}\n\`\`\``
    : '*No diff content available (clean worktree or non-git).*';

  const statBlock = diff.stat
    ? `\`\`\`\n${diff.stat}\n\`\`\``
    : '*0 files changed*';

  const rawPayload = [
    '# External Code Review Request',
    '',
    '## Goal Contract',
    `- **Goal ID:** \`${goalId}\``,
    `- **Objective:** ${objective}`,
    `- **Status & Verdict:** ${outcomeLabel}`,
    `- **Execution Budget:** ${totalTokens} tokens consumed across ${turnCount} turns`,
    '',
    '## Known-Risk Sites (Human Audit Required)',
    riskLines,
    '',
    '## Change Set Summary',
    `- Files changed: ${diff.files.length}`,
    `- Insertions: +${diff.insertions}`,
    `- Deletions: -${diff.deletions}`,
    '',
    statBlock,
    '',
    '## Reviewable Patch',
    patchBlock,
    '',
    '## Verification Checklist',
    '1. [ ] Architectural invariants preserved (no circular deps, clean seam boundaries).',
    '2. [ ] Risk sites thoroughly reviewed for security, migration safety, and reversibility.',
    '3. [ ] All test suites green with positive and negative coverage.',
    '4. [ ] No orphaned debug code, dead branches, or untested assumptions.',
  ].join('\n');

  return {
    goalId,
    objective,
    status,
    diffStats: diff.stat,
    riskSites: diff.riskSites,
    rawPayload,
  };
}

/**
 * Assembles the full Handback Deliverable structure for a goal at terminal state
 * or on on-demand command execution.
 */
export async function buildHandbackDeliverable(
  goal: Readonly<GoalState>,
  cwd?: string,
  customRules: ReadonlyArray<RiskClassRule> = [],
): Promise<HandbackDeliverable> {
  const diff = await generateReviewableDiff(cwd, customRules, goal.baseline);
  const reviewPayload = buildExternalReviewPayload({
    goalId: goal.goalId,
    objective: goal.condition,
    status: goal.status,
    diff,
    lastClaim: goal.lastClaim,
    totalTokens: goal.totalTokens,
    turnCount: goal.turnCount,
  });

  return {
    goalId: goal.goalId,
    sessionID: goal.sessionID,
    condition: goal.condition,
    status: goal.status,
    createdAt: goal.createdAt,
    finishedAt: goal.finishedAt,
    totalTokens: goal.totalTokens,
    turnCount: goal.turnCount,
    claims: goal.claims ? [...goal.claims] : [],
    diff,
    externalReviewPayload: reviewPayload.rawPayload,
  };
}
