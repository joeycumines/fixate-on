/**
 * v2 tool-registration and agent-transform helpers for the OpenCode v2 plugin
 * adapter. Split out of plugin-v2-helpers.ts to keep each module within the
 * ~900-line single-concern budget. Leaf module: depends only on leaf helpers
 * and types — no import back into plugin-v2-helpers.ts.
 */

import {
  buildToolInputSchema,
  logToolRegistrationFailure,
  type V2AgentDraft,
  type V2Context,
  type V2PermissionRule,
  type ZodModule,
} from './plugin-v2-helpers.ts';

export async function registerV2GoalTools(args: {
  toolTransform: NonNullable<V2Context['tool']>['transform'];
  tools: Record<string, unknown>;
  z: ZodModule | null;
  drainTuiEvents: (sessionID: string) => unknown[];
  encodeMetadata: (events: unknown[]) => Record<string, unknown> | undefined;
  shapeResult: (
    result: unknown,
    goalMetadata: Record<string, unknown> | undefined,
  ) => unknown;
  disposers: Array<() => Promise<void> | void>;
}): Promise<void> {
  const registeredNames = new Set<string>();
  const registerOnce = async (): Promise<void> => {
    const attemptNames = new Set<string>();
    const reg = await args.toolTransform(draft => {
      for (const [name, def] of Object.entries(args.tools)) {
        if (!def || typeof def !== 'object') continue;
        if (registeredNames.has(name)) continue;
        const tool = def as {
          description?: string;
          args?: Record<string, unknown>;
          execute?: (
            toolArgs: Record<string, unknown>,
            ctx: {sessionID: string},
          ) => Promise<unknown> | unknown;
        };
        if (typeof tool.execute !== 'function') continue;
        try {
          draft.add({
            name,
            description:
              typeof tool.description === 'string'
                ? tool.description
                : `${name} (fixate-on)`,
            input: buildToolInputSchema(args.z, tool.args),
            options: {codemode: false},
            execute: async (input: unknown, execCtx: unknown) => {
              const sid =
                (execCtx as {sessionID?: string} | null)?.sessionID ?? '';
              const result = await tool.execute!(
                (input ?? {}) as Record<string, unknown>,
                {sessionID: sid},
              );
              const events = sid ? args.drainTuiEvents(sid) : [];
              const goalMeta = args.encodeMetadata(events);
              return args.shapeResult(result, goalMeta);
            },
          });
          attemptNames.add(name);
        } catch (error) {
          console.error(
            `[fixate-on] failed to register tool "${name}":`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    });
    args.disposers.push(() => reg.dispose());
    for (const name of attemptNames) registeredNames.add(name);
  };

  try {
    await registerOnce();
  } catch (error) {
    console.error(
      '[fixate-on] tool registration failed (attempt 1):',
      error instanceof Error ? error.message : error,
    );
    await logToolRegistrationFailure('attempt-1', error);
    try {
      await registerOnce();
      console.error('[fixate-on] tool registration succeeded on retry');
    } catch (retryError) {
      console.error(
        '[fixate-on] tool registration FAILED after retry — goal tools are UNAVAILABLE:',
        retryError instanceof Error ? retryError.message : retryError,
      );
      await logToolRegistrationFailure('retry-exhausted', retryError);
    }
  }
}

export interface NativeAgentSpec {
  readonly description?: string;
  readonly mode?: string;
  readonly prompt?: string;
  readonly hidden?: boolean;
}

/**
 * Restrictive session-level permission policy attached to verifier/judge child
 * sessions. On OpenCode v2 a parent-bound child inherits the parent session's
 * permission rules, and the host combines agent rules FIRST and session rules
 * AFTER with last-match-wins — so a permissive parent (e.g. allow-all) would
 * otherwise override the verifier agent's deny rules. Sending this explicit
 * deny-all policy on the child session makes the session ruleset restrictive
 * regardless of what the parent carried. Read-only allows mirror the
 * verifier agent's own rules so the verifier can still read/glob/grep.
 */
export const VERIFIER_SESSION_PERMISSIONS: ReadonlyArray<V2PermissionRule> = [
  {action: '*', resource: '*', effect: 'deny'},
  {action: 'read', resource: '*', effect: 'allow'},
  {action: 'glob', resource: '*', effect: 'allow'},
  {action: 'grep', resource: '*', effect: 'allow'},
  {action: 'read', resource: '*.env', effect: 'deny'},
  {action: 'read', resource: '*.env.*', effect: 'deny'},
  {action: 'read', resource: '*.env.example', effect: 'allow'},
  {action: 'edit', resource: '*', effect: 'deny'},
  {action: 'write', resource: '*', effect: 'deny'},
  {action: 'patch', resource: '*', effect: 'deny'},
  {action: 'bash', resource: '*', effect: 'deny'},
  {action: 'shell', resource: '*', effect: 'deny'},
];

/**
 * Mirrors native `goal` and read-only `goal-verify` agent registration into
 * OpenCode v2's `ctx.agent.transform` draft while failing closed on pre-existing
 * verifier collisions.
 */
export function applyV2AgentTransforms(
  draft: V2AgentDraft,
  agentsConfig: Record<string, NativeAgentSpec> | undefined,
  opts: {
    goalAgentName: string;
    verifierAgentName: string;
    registerAgents: boolean;
    requireVerifierOwnership: boolean;
  },
): void {
  if (opts.goalAgentName === opts.verifierAgentName) {
    throw new TypeError(
      'goalAgentName and verifierAgentName must be different',
    );
  }
  const existingVerifier = draft.get?.(opts.verifierAgentName);
  if (existingVerifier && opts.requireVerifierOwnership) {
    throw new Error(
      `childSessionJudge cannot safely use existing agent ${JSON.stringify(opts.verifierAgentName)}; choose an unused verifierAgentName`,
    );
  }
  if (!opts.registerAgents || !agentsConfig) return;

  const goalSpec = agentsConfig[opts.goalAgentName];
  if (goalSpec && !draft.get?.(opts.goalAgentName)) {
    draft.update(opts.goalAgentName, entry => {
      entry.name = opts.goalAgentName;
      if (goalSpec.description) entry.description = goalSpec.description;
      entry.mode = 'primary';
      entry.hidden = false;
      if (goalSpec.prompt) entry.system = goalSpec.prompt;
    });
  }

  const verifierSpec = agentsConfig[opts.verifierAgentName];
  if (verifierSpec && !existingVerifier) {
    draft.update(opts.verifierAgentName, entry => {
      entry.name = opts.verifierAgentName;
      if (verifierSpec.description) {
        entry.description = verifierSpec.description;
      }
      entry.mode = 'subagent';
      entry.hidden = true;
      if (verifierSpec.prompt) entry.system = verifierSpec.prompt;
      const perms = Array.isArray(entry.permissions)
        ? entry.permissions
        : (entry.permissions = []);
      perms.length = 0;
      perms.push(
        {action: '*', resource: '*', effect: 'deny'},
        {action: 'read', resource: '*', effect: 'allow'},
        {action: 'glob', resource: '*', effect: 'allow'},
        {action: 'grep', resource: '*', effect: 'allow'},
        {action: 'read', resource: '*.env', effect: 'deny'},
        {action: 'read', resource: '*.env.*', effect: 'deny'},
        {action: 'read', resource: '*.env.example', effect: 'allow'},
        {action: 'edit', resource: '*', effect: 'deny'},
        {action: 'write', resource: '*', effect: 'deny'},
        {action: 'patch', resource: '*', effect: 'deny'},
        {action: 'bash', resource: '*', effect: 'deny'},
        {action: 'shell', resource: '*', effect: 'deny'},
        {action: 'create_goal', resource: '*', effect: 'deny'},
        {action: 'update_goal', resource: '*', effect: 'deny'},
        {action: 'propose_goal_change', resource: '*', effect: 'deny'},
        {action: 'goal-command', resource: '*', effect: 'deny'},
      );
    });
  }
}
