/**
 * Adapter for OpenCode session SDK argument shapes.
 *
 * OpenCode session SDK methods historically accept two argument shapes:
 * - "flat": `sessionID` passed as a top-level property.
 * - "legacy": parameters nested under `path`, `body`, and `query` objects.
 *
 * The adapter detects which shape is accepted per operation and caches the result.
 */

const SHAPE_ERROR_PATTERNS = [
  /(?:missing|required).*(?:sessionID|path|body|query)/i,
  /(?:unknown|unrecognized|unexpected|invalid).*(?:sessionID|path|body|query|argument|field|key)/i,
  /(?:expected|must be).*(?:object|path|body|query|sessionID)/i,
  /(?:validation|schema|invalid input|invalid argument)/i,
];

/**
 * Only read-only operations may safely retry with an alternate argument shape.
 * Mutating SDK calls (create, prompt, update, delete, abort) may have already
 * reached the host before a TypeError is raised, so replaying them could duplicate side effects.
 */
const REPLAY_SAFE_OPERATIONS = new Set(['messages', 'get']);

export type SdkShape = 'flat' | 'legacy';

export interface SessionApiOptions {
  preferredShape?: SdkShape;
  /** Opt-in adapters can stop a pending prompt before its next host call. */
  signal?: AbortSignal;
  /** Verifiers must read post-turn messages, never a pre-turn context cache. */
  requireFreshMessages?: boolean;
  /** Revalidates child policy at the host's post-activation admission boundary. */
  beforePromptAdmission?: () => Promise<void>;
}

/** Explicit adapter capabilities that cannot be inferred from wrapper methods. */
export interface SessionClientCapabilities {
  deleteSession?: boolean;
  promptAbortSignal?: boolean;
  /** The adapter can run a callback after activation and before admitting input. */
  promptAdmissionHook?: boolean;
  /** Reads the host's durable session totals before a continuation decision. */
  readCumulativeUsage?: (sessionID: string) => Promise<unknown>;
  selectAgent?: (sessionID: string, agent: string) => Promise<void>;
  readFreshMessages?: (
    sessionID: string,
    options: {limit?: number},
  ) => Promise<unknown[]>;
  /** Resolved agent rules, including the host's global and project config. */
  readAgentPermissions?: (agent: string) => Promise<unknown[]>;
}

export interface OpenCodeSessionApi {
  agentPermissions?: (agent: string) => Promise<unknown[]>;
  usage?: (sessionID: string) => Promise<unknown>;
  messages: (
    sessionID: string,
    options?: {limit?: number},
  ) => Promise<unknown[]>;
  promptAsync: (
    sessionID: string,
    input: {parts?: unknown[]} & Record<string, unknown>,
  ) => Promise<unknown>;
  createChild: (
    parentID: string,
    input?: Record<string, unknown>,
  ) => Promise<unknown>;
  prompt: (
    sessionID: string,
    input?: Record<string, unknown>,
  ) => Promise<unknown>;
  update: (
    sessionID: string,
    input?: Record<string, unknown>,
  ) => Promise<unknown>;
  get: (sessionID: string) => Promise<unknown>;
  delete: (sessionID: string) => Promise<unknown>;
  abort: (sessionID: string) => Promise<unknown>;
}

interface SessionClient {
  session: Record<
    string,
    ((...args: unknown[]) => Promise<unknown>) | undefined
  >;
}

function isArgumentShapeError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const message = String(error.message || '');
  return SHAPE_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

/** Preserve the SDK's structured failure for callers that inspect its cause. */
export class SessionApiError extends Error {
  readonly status: number | undefined;

  constructor(operation: string, error: unknown, response: unknown) {
    const detail = error as {
      message?: unknown;
      data?: {message?: unknown};
      _tag?: unknown;
    } | null;
    const nonEmpty = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    const message =
      nonEmpty(detail?.message) ??
      nonEmpty(detail?.data?.message) ??
      nonEmpty(detail?._tag) ??
      String(error);
    super(`OpenCode session.${operation} failed: ${message}`, {cause: error});
    this.name = 'SessionApiError';
    const status = (response as {status?: unknown} | null)?.status;
    this.status = typeof status === 'number' ? status : undefined;
  }
}

function unwrapData(response: unknown, operation: string): unknown {
  // The HTTP SDK returns an error envelope unless throwOnError was enabled by
  // its caller. A fulfilled transport promise does not establish that the
  // operation succeeded (particularly deletion during verifier cleanup).
  if (
    response &&
    typeof response === 'object' &&
    'error' in response &&
    response.error !== undefined &&
    response.error !== null
  ) {
    const envelope = response as {error?: unknown; response?: unknown};
    if (envelope.error instanceof Error) throw envelope.error;
    throw new SessionApiError(
      operation,
      envelope.error,
      envelope.response ?? response,
    );
  }
  if (
    response &&
    typeof response === 'object' &&
    'data' in (response as Record<string, unknown>)
  ) {
    return (response as Record<string, unknown>).data;
  }
  return response;
}

export function createOpenCodeSessionApi(
  client: unknown,
  options: SessionApiOptions = {},
): OpenCodeSessionApi {
  const sessionObj = (
    client as {session?: SessionClient['session']} | undefined
  )?.session;
  if (!sessionObj || typeof sessionObj !== 'object') {
    throw new TypeError('OpenCode client.session is required');
  }
  const sessionClient: SessionClient = {session: sessionObj};
  const capabilities = (
    client as {sessionCapabilities?: SessionClientCapabilities}
  ).sessionCapabilities;
  const app = (client as {app?: {agents?: () => Promise<unknown>}}).app;
  const readAgentPermissions = capabilities?.readAgentPermissions
    ? capabilities.readAgentPermissions
    : typeof app?.agents === 'function'
      ? async (agent: string): Promise<unknown[]> => {
          const agents = unwrapData(await app.agents!(), 'agents');
          if (!Array.isArray(agents))
            throw new Error('Resolved agent permission policy is unavailable.');
          const info = agents.find(
            value => value && typeof value === 'object' && value.name === agent,
          );
          if (!info || !Array.isArray(info.permission))
            throw new Error(
              `Resolved permission policy for agent ${agent} is unavailable.`,
            );
          return info.permission;
        }
      : undefined;

  const preferredShape: SdkShape = options.preferredShape ?? 'flat';
  if (preferredShape !== 'flat' && preferredShape !== 'legacy') {
    throw new TypeError('preferredShape must be "flat" or "legacy"');
  }
  const shapes = new Map<string, SdkShape>();

  async function invoke<T>(
    operation: string,
    flatInput: Record<string, unknown>,
    legacyInput: Record<string, unknown>,
  ): Promise<T> {
    const method = sessionClient.session[operation];
    if (typeof method !== 'function') {
      throw new TypeError(
        `OpenCode client.session.${operation} is not available`,
      );
    }

    const knownShape = shapes.get(operation);
    const firstShape: SdkShape = knownShape ?? preferredShape;
    const firstInput = firstShape === 'flat' ? flatInput : legacyInput;
    try {
      // Only adapters advertising this convention receive the request option.
      // Deletion/abort stay usable after cancellation so cleanup can finish.
      const response =
        operation === 'prompt' &&
        (capabilities?.promptAbortSignal || capabilities?.promptAdmissionHook)
          ? await method.call(sessionClient.session, firstInput, {
              ...(capabilities.promptAbortSignal
                ? {signal: options.signal}
                : {}),
              ...(capabilities.promptAdmissionHook
                ? {beforeAdmission: options.beforePromptAdmission}
                : {}),
            })
          : await method.call(sessionClient.session, firstInput);
      const unwrapped = unwrapData(response, operation) as T;
      shapes.set(operation, firstShape);
      return unwrapped;
    } catch (error) {
      if (
        knownShape ||
        !REPLAY_SAFE_OPERATIONS.has(operation) ||
        !isArgumentShapeError(error)
      ) {
        throw error;
      }
      const fallbackShape: SdkShape = firstShape === 'flat' ? 'legacy' : 'flat';
      const fallbackInput = fallbackShape === 'flat' ? flatInput : legacyInput;
      const response =
        operation === 'prompt' &&
        (capabilities?.promptAbortSignal || capabilities?.promptAdmissionHook)
          ? await method.call(sessionClient.session, fallbackInput, {
              ...(capabilities.promptAbortSignal
                ? {signal: options.signal}
                : {}),
              ...(capabilities.promptAdmissionHook
                ? {beforeAdmission: options.beforePromptAdmission}
                : {}),
            })
          : await method.call(sessionClient.session, fallbackInput);
      const unwrapped = unwrapData(response, operation) as T;
      shapes.set(operation, fallbackShape);
      return unwrapped;
    }
  }

  return Object.freeze({
    ...(readAgentPermissions ? {agentPermissions: readAgentPermissions} : {}),
    ...(capabilities?.readCumulativeUsage
      ? {
          usage: async (sessionID: string): Promise<unknown> =>
            unwrapData(
              await capabilities.readCumulativeUsage!(sessionID),
              'get',
            ),
        }
      : {}),
    messages(
      sessionID: string,
      messageOptions: {limit?: number} = {},
    ): Promise<unknown[]> {
      if (options.requireFreshMessages && capabilities?.readFreshMessages) {
        // Route through the same envelope/error unwrapping as every other
        // operation; a capability may still return the SDK's {data: ...}
        // shape or a structured error envelope.
        return Promise.resolve(
          capabilities.readFreshMessages(sessionID, messageOptions),
        ).then(fresh => unwrapData(fresh, 'messages') as unknown[]);
      }
      return invoke<unknown[]>(
        'messages',
        {sessionID, ...messageOptions},
        {path: {id: sessionID}, query: messageOptions},
      );
    },
    promptAsync(
      sessionID: string,
      input: {parts?: unknown[]} & Record<string, unknown> = {},
    ): Promise<unknown> {
      return invoke(
        'promptAsync',
        {sessionID, ...input},
        {path: {id: sessionID}, body: input},
      );
    },
    createChild(
      parentID: string,
      input: Record<string, unknown> = {},
    ): Promise<unknown> {
      const body = {...input, parentID};
      return invoke('create', body, {body});
    },
    prompt(
      sessionID: string,
      input: Record<string, unknown> = {},
    ): Promise<unknown> {
      return invoke(
        'prompt',
        {sessionID, ...input},
        {path: {id: sessionID}, body: input},
      );
    },
    update(
      sessionID: string,
      input: Record<string, unknown> = {},
    ): Promise<unknown> {
      return invoke(
        'update',
        {sessionID, ...input},
        {path: {id: sessionID}, body: input},
      );
    },
    get(sessionID: string): Promise<unknown> {
      return invoke('get', {sessionID}, {path: {id: sessionID}});
    },
    delete(sessionID: string): Promise<unknown> {
      return invoke('delete', {sessionID}, {path: {id: sessionID}});
    },
    abort(sessionID: string): Promise<unknown> {
      return invoke('abort', {sessionID}, {path: {id: sessionID}});
    },
  });
}
