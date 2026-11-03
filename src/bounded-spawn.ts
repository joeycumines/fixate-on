/**
 * Process execution utilities with bounded runtime and output limits.
 * All runs are capped on time and stdout/stderr buffer sizes and terminated
 * as a process group.
 */

import {execFile, spawn} from 'node:child_process';

export type VerifierProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  aborted: boolean;
};

export type VerifierProcessOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  terminateGraceMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
const DEFAULT_TERMINATE_GRACE_MS = 1_000;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * Run a verifier command with bounded capture. POSIX children get their own
 * process group; timeout, cancellation, and output overflow send TERM then
 * KILL to the whole group. Windows uses direct-child termination only.
 *
 * @param command The verifier binary (e.g. "gmake" or "make").
 * @param args Literal argv (never shell-evaluated).
 * @param cwd Working directory for the verifier.
 */
export function runVerifierProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  options: VerifierProcessOptions = {},
): Promise<VerifierProcessResult> {
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'timeoutMs',
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    'maxOutputBytes',
  );
  const terminateGraceMs = positiveInteger(
    options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    'terminateGraceMs',
  );

  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      aborted: true,
    });
  }

  return new Promise(resolve => {
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args as string[], {
      cwd,
      detached: useProcessGroup,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exitCode: number | null = null;
    let timedOut = false;
    let truncated = false;
    let aborted = false;
    let closed = false;
    let terminating = false;
    let killSent = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settlementTimer: NodeJS.Timeout | undefined;

    const result = (): VerifierProcessResult => ({
      exitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      truncated,
      aborted,
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
      options.signal?.removeEventListener('abort', abortHandler);
      resolve(result());
    };
    const signalVerifier = (signal: NodeJS.Signals) => {
      if (useProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may have already terminated; fall back to the direct child.
        }
      }
      child.kill(signal);
    };
    const beginTermination = (reason: 'timeout' | 'truncated' | 'aborted') => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'truncated') truncated = true;
      if (reason === 'aborted') aborted = true;
      if (terminating) return;
      terminating = true;
      signalVerifier('SIGTERM');
      killTimer = setTimeout(() => {
        killSent = true;
        signalVerifier('SIGKILL');
        if (closed) {
          finish();
          return;
        }
        settlementTimer = setTimeout(finish, terminateGraceMs);
      }, terminateGraceMs);
    };
    const abortHandler = () => beginTermination('aborted');
    const timeoutTimer = setTimeout(
      () => beginTermination('timeout'),
      timeoutMs,
    );

    options.signal?.addEventListener('abort', abortHandler, {once: true});
    if (options.signal?.aborted) beginTermination('aborted');

    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = maxOutputBytes - stdoutBytes;
      if (remaining <= 0) {
        beginTermination('truncated');
        return;
      }
      if (chunk.length > remaining) {
        stdout.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        beginTermination('truncated');
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = maxOutputBytes - stderrBytes;
      if (remaining <= 0) {
        beginTermination('truncated');
        return;
      }
      if (chunk.length > remaining) {
        stderr.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        beginTermination('truncated');
        return;
      }
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.once('error', finish);
    child.once('close', code => {
      closed = true;
      exitCode = code;
      if (!terminating || !useProcessGroup || killSent) finish();
    });
  });
}

/**
 * Lightweight bounded execFile execution. Resolves to `{ ok, stdout, truncated }`,
 * where `ok` is false on non-zero exit, timeout, or spawn error. Never throws.
 */
export async function runBounded(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ok: boolean; stdout: string; truncated: boolean}> {
  return new Promise(resolve => {
    const child = execFile(
      command,
      args as string[],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: maxBytes,
        shell: false,
      } as object,
      (err, stdout) => {
        resolve({
          ok: err === null,
          stdout: stdout ?? '',
          truncated: Boolean(
            err &&
            (err as {code?: string}).code ===
              'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          ),
        });
      },
    );
    child.on('error', () => resolve({ok: false, stdout: '', truncated: false}));
  });
}
