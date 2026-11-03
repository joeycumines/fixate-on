/**
 * Auto-registration of goal agent, verifier, and command.
 *
 * Configures:
 * - The `goal` agent (mode: primary)
 * - The `goal-verify` subagent (hidden, read-only tools with default-deny policy)
 * - The `/goal` slash command
 */

const GOAL_AGENT_PROMPT = `Execute explicit goals persistently. Use goal tools to track state and checkpoints. Make concrete progress; claim completion only with verification evidence. Report only genuine blockers.

Available tools: create_goal, update_goal, get_goal, list_goals, focus_goal.`;

const VERIFIER_AGENT_PROMPT =
  'Independently verify the claim against the goal, constraints, evidence, and workspace. Use only the read, glob, and grep tools; never edit, execute commands, call other tools, or mutate goal state. Approve only when the claim holds on the evidence you can inspect; otherwise give one actionable reason.';

/**
 * Leading sentence of every `/goal` command template this plugin registers.
 *
 * Used as an echo fingerprint: hosts that echo config templates as chat turns
 * (such as stock v1 1.18.32) present this text as a user message. Recognizing
 * this prefix prevents treating host dispatches as user steering.
 */
export const GOAL_COMMAND_TEMPLATE_PREFIX =
  'Call the goal-command tool exactly once with its subcommand parameter set verbatim to:';

interface AgentConfig {
  description?: string;
  mode?: string;
  prompt?: string;
  hidden?: boolean;
  permission?: Record<string, string>;
  tools?: Record<string, boolean>;
}

interface CommandConfig {
  description?: string;
  template?: string;
  agent?: string;
}

export interface OpenCodeConfig {
  agent?: Record<string, AgentConfig>;
  command?: Record<string, CommandConfig>;

  [key: string]: unknown;
}

export interface NativeGoalConfigOptions {
  registerAgents?: boolean;
  registerCommand?: boolean;
  goalAgentName?: string;
  verifierAgentName?: string;
  requireVerifierOwnership?: boolean;
  commandName?: string;
  /**
   * True when the plugin addresses the verifier agent by name.
   * When enabled, pre-existing agents with that name are validated to match
   * the read-only default-deny policy exactly, or rejected if
   * `requireVerifierOwnership` is active.
   */
  verifierAgentAddressed?: boolean;
}

/**
 * Default-deny permission profile for the verifier agent.
 * Mutating tools are explicitly denied while read-only tools (read, glob, grep) are allowed.
 */
const VERIFIER_SAFE_PERMISSION: Record<string, string> = {
  '*': 'deny',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  edit: 'deny',
  bash: 'deny',
};

const VERIFIER_SAFE_TOOLS: Record<string, boolean> = {
  bash: false,
  write: false,
  edit: false,
  patch: false,
  create_goal: false,
  update_goal: false,
};

function sameRecord(
  actual: Record<string, string> | Record<string, boolean> | undefined,
  expected: Record<string, string> | Record<string, boolean>,
): boolean {
  if (!actual || typeof actual !== 'object') return false;
  const aKeys = Object.keys(actual);
  const eKeys = Object.keys(expected);
  if (aKeys.length !== eKeys.length) return false;
  return eKeys.every(k => actual[k] === expected[k]);
}

export function applyNativeGoalConfig(
  config: OpenCodeConfig,
  options: NativeGoalConfigOptions = {},
): OpenCodeConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError(
      'OpenCode config hook requires a mutable config object',
    );
  }

  const goalAgentName = options.goalAgentName ?? 'goal';
  const verifierAgentName = options.verifierAgentName ?? 'goal-verify';
  if (typeof goalAgentName !== 'string' || !goalAgentName.trim()) {
    throw new TypeError('goalAgentName must be a non-empty string');
  }
  if (typeof verifierAgentName !== 'string' || !verifierAgentName.trim()) {
    throw new TypeError('verifierAgentName must be a non-empty string');
  }
  if (
    goalAgentName !== goalAgentName.trim() ||
    verifierAgentName !== verifierAgentName.trim()
  ) {
    throw new TypeError(
      'goal and verifier agent names cannot have surrounding whitespace',
    );
  }
  if (goalAgentName === verifierAgentName) {
    throw new TypeError(
      'goalAgentName and verifierAgentName must be different',
    );
  }

  // Verify security posture of any existing agent that will be addressed as the verifier.
  const verifierAddressed =
    options.requireVerifierOwnership || options.verifierAgentAddressed;
  if (verifierAddressed) {
    const existing = config.agent?.[verifierAgentName];
    if (existing) {
      if (options.requireVerifierOwnership) {
        throw new Error(
          `childSessionJudge cannot safely use existing agent ${JSON.stringify(verifierAgentName)}; choose an unused verifierAgentName`,
        );
      }
      if (
        !sameRecord(existing.permission, VERIFIER_SAFE_PERMISSION) ||
        !sameRecord(existing.tools, VERIFIER_SAFE_TOOLS)
      ) {
        throw new Error(
          `agent ${JSON.stringify(verifierAgentName)} is addressed as the verifier but is not read-only ` +
            "(permission/tools do not match the plugin's default-deny shape); choose an unused verifierAgentName or make it read-only",
        );
      }
    }
  }

  if (options.registerAgents !== false) {
    config.agent ??= {};
    config.agent[goalAgentName] ??= {
      description:
        'Execute an explicit user goal with persistent progress and evidence-gated completion.',
      mode: 'primary',
      prompt: GOAL_AGENT_PROMPT,
    };
    config.agent[verifierAgentName] ??= {
      description:
        'Independently verify a goal completion claim without modifying the workspace.',
      mode: 'subagent',
      hidden: true,
      prompt: VERIFIER_AGENT_PROMPT,
      permission: {...VERIFIER_SAFE_PERMISSION},
      tools: {...VERIFIER_SAFE_TOOLS},
    };
  }

  if (
    options.registerCommand !== false &&
    (options.registerAgents !== false || config.agent?.[goalAgentName])
  ) {
    const commandName =
      typeof options.commandName === 'string' && options.commandName.trim()
        ? options.commandName.trim().replace(/^\/+/, '').trim() || 'goal'
        : 'goal';
    config.command ??= {};
    const hasCustomMainCmd = Boolean(config.command[commandName]);
    config.command[commandName] ??= {
      description:
        'Set a session-scoped goal and auto-continue until complete. Subcommands: status, history, pause, resume, edit, clear, list, focus, sequence, add.',
      // v2 hosts lack command.execute.before hooks; routing through the goal-command
      // tool ensures deterministic execution across host versions.
      template:
        `${GOAL_COMMAND_TEMPLATE_PREFIX} $ARGUMENTS\n` +
        'Do not summarize, do not ask for confirmation, and do not perform any other work. Reply with only the tool output.',
    };

    // Strip agent field from the main command: the command.execute.before hook
    // handles routing directly. Specifying an agent causes OpenCode to re-route
    // after the hook fires, overriding tool output.
    if (
      config.command[commandName] &&
      typeof config.command[commandName] === 'object'
    ) {
      const cmdObj = config.command[commandName] as Record<string, unknown>;
      if ('agent' in cmdObj) {
        delete cmdObj.agent;
      }
    }

    if (!hasCustomMainCmd) {
      const subcommands: Record<string, string> = {
        status: 'Show active goal status and token usage.',
        history: 'Show goal transition history and checkpoints.',
        pause: 'Pause the active goal.',
        resume: 'Resume a paused goal.',
        clear: 'Clear active goal(s).',
        list: 'List all active and archived goals.',
        focus: 'Focus a specific goal in the session.',
        edit: 'Edit the active goal objective.',
        checkpoint: 'Save a checkpoint for the active goal.',
        add: 'Add a new goal to the session.',
        sequence: 'Start an ordered sequence of goals.',
      };
      for (const [sub, desc] of Object.entries(subcommands)) {
        const subKey = `${commandName} ${sub}`;
        config.command[subKey] ??= {
          description: desc,
          template:
            `${GOAL_COMMAND_TEMPLATE_PREFIX} ` +
            `${sub === 'status' || sub === 'history' || sub === 'pause' || sub === 'resume' || sub === 'clear' || sub === 'list' ? sub : `${sub} $ARGUMENTS`}\n` +
            'Do not summarize, do not ask for confirmation, and do not perform any other work. Reply with only the tool output.',
        };
      }
    }
  }

  return config;
}

export const nativeAgentConfigInternals = Object.freeze({
  GOAL_AGENT_PROMPT,
  VERIFIER_AGENT_PROMPT,
});
