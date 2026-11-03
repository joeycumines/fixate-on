/**
 * Agent display-name resolution for continuation prompts.
 *
 * The continuation must pass the registered display name of an agent to
 * `session.promptAsync` / `synthetic`, not a lower-cased config key. The host's
 * agent registry is case-sensitive and display-name based.
 */

/**
 * Agent display names the plugin registers itself. Keys are lower-cased config
 * keys; values are the registered display names the host expects. Any other agent
 * name is passed through unchanged.
 */
const DISPLAY_NAME_MAP: Record<string, string> = {
  'goal-verify': 'goal-verify',
};

/**
 * Strip the OpenCode agent-list sort prefix.
 * The TUI prefixes agents with e.g. `"\u200B 1. "` or `" 2. "` for display sorting;
 * continuation dispatches must use the bare display name.
 */
export function stripAgentListSortPrefix(name: string): string {
  return name.replace(/^[\u200B\uFEFF\s]*\d+[.)]\s*/, '').trim();
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolve a config key or ambiguous name to the registered display name.
 * Returns the display name if the lower-cased key is known, otherwise undefined
 * so the caller can fall back to the raw value.
 */
export function resolveRegisteredAgentName(
  name: string | undefined,
): string | undefined {
  if (!name || typeof name !== 'string') return undefined;
  const key = normalizeKey(stripAgentListSortPrefix(name));
  return DISPLAY_NAME_MAP[key];
}

/**
 * Normalize an agent string for use as a prompt key.
 * Lower-cases and maps known display names back to their configuration keys.
 */
export function normalizeAgentForPromptKey(
  name: string | undefined,
): string | undefined {
  if (!name || typeof name !== 'string') return undefined;
  const stripped = stripAgentListSortPrefix(name).trim();
  if (!stripped) return undefined;
  for (const [key, display] of Object.entries(DISPLAY_NAME_MAP)) {
    if (display.toLowerCase() === stripped.toLowerCase()) return key;
  }
  return normalizeKey(stripped);
}

export const GOAL_AGENT_NAME = 'goal';
export const VERIFIER_AGENT_NAME = 'goal-verify';

/**
 * Names the host appends to turns that the plugin must never inherit.
 * After auto-compaction, the host files its summary as a user-role message with
 * agent "compaction"; title and summary turns belong to the same category.
 */
export const INTERNAL_AGENT_NAMES: ReadonlySet<string> = new Set([
  'compaction',
  'title',
  'summary',
]);

export function isInternalAgent(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  return INTERNAL_AGENT_NAMES.has(
    stripAgentListSortPrefix(name).trim().toLowerCase(),
  );
}

export function isKnownGoalAgent(name: unknown): boolean {
  return name === GOAL_AGENT_NAME || name === VERIFIER_AGENT_NAME;
}

export function normalizeVerifierName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const stripped = stripAgentListSortPrefix(name).trim();
  return stripped ? stripped : undefined;
}

interface MessageLike {
  info?: {agent?: unknown; role?: unknown};
  agent?: unknown;
  role?: unknown;
}

function messageAgent(message: unknown): string | undefined {
  const msg = message as MessageLike | null;
  if (!msg || typeof msg !== 'object') return undefined;
  const infoAgent = msg.info?.agent;
  if (typeof infoAgent === 'string' && infoAgent.trim()) return infoAgent;
  if (typeof msg.agent === 'string' && msg.agent.trim()) return msg.agent;
  return undefined;
}

function messageRole(message: unknown): string | undefined {
  const msg = message as MessageLike | null;
  if (!msg || typeof msg !== 'object') return undefined;
  const infoRole = msg.info?.role;
  if (typeof infoRole === 'string') return infoRole;
  if (typeof msg.role === 'string') return msg.role;
  return undefined;
}

/**
 * Find the newest user-role agent that is safe to inherit.
 * Skips internal host agents so that a message window ending in compaction
 * turns resolves to the last genuine agent instead. Returns undefined when none qualifies.
 */
export function pickInheritableAgent(messages: unknown[]): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messageRole(messages[i]) !== 'user') continue;
    const agent = messageAgent(messages[i]);
    if (!agent) continue;
    if (isInternalAgent(agent)) continue;
    return agent;
  }
  return undefined;
}

/**
 * Resolve an inherited agent value for prompt dispatch.
 * - If the value already looks like a display name (contains " - "), keeps it.
 * - Otherwise, tries the registered map first, then falls back to key normalization.
 * - Strips sort prefixes and trims whitespace.
 * - Internal host agents (compaction/title/summary) resolve to undefined.
 */
export function normalizeInheritedAgentForPrompt(
  agent: string | undefined,
): string | undefined {
  if (!agent || typeof agent !== 'string') return undefined;
  const stripped = stripAgentListSortPrefix(agent).trim();
  if (!stripped) return undefined;
  if (isInternalAgent(stripped)) return undefined;
  if (stripped.includes(' - ')) return stripped;
  const resolved = resolveRegisteredAgentName(stripped);
  if (resolved) return resolved;
  const key = normalizeAgentForPromptKey(stripped);
  // Known aliases resolve to registered display names. Unknown values must remain
  // byte-for-byte case-preserved because custom host agent registries are case-sensitive.
  if (key) {
    const display = DISPLAY_NAME_MAP[key];
    if (display) return display;
    if (key === stripped) return stripped;
    if (stripped.toLowerCase() === key) return stripped;
  }
  return stripped;
}

/**
 * Resolve the agent to pass to `promptAsync` or `synthetic`.
 * Prefers the inherited agent's display name if present; otherwise returns undefined
 * so the host uses the session's active agent. Internal host agents fall through
 * to the fallback agent, while candidates duplicating the fallback are omitted.
 */
export function resolveAgentForContinuation(
  inheritedAgent: string | undefined,
  fallbackAgent?: string,
): string | undefined {
  const fromInheritedRaw = normalizeInheritedAgentForPrompt(inheritedAgent);
  if (fromInheritedRaw) {
    // If the candidate merely repeats the session's fallback agent, omit it so
    // the host defaults to its active agent. Compare via prompt keys to treat
    // case variations (e.g. "Build" and "build") as equal.
    if (
      typeof fallbackAgent === 'string' &&
      fallbackAgent.trim() &&
      normalizeAgentForPromptKey(fromInheritedRaw) ===
        normalizeAgentForPromptKey(fallbackAgent)
    ) {
      return undefined;
    }
    return fromInheritedRaw;
  }
  const fromFallback = normalizeInheritedAgentForPrompt(fallbackAgent);
  if (fromFallback) return fromFallback;
  return undefined;
}
