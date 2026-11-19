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
}

/** Explicit adapter capabilities that cannot be inferred from wrapper methods. */
export interface SessionClientCapabilities {
  deleteSession?: boolean;
  promptAbortSignal?: boolean;
  selectAgent?: (sessionID: string, agent: string) => Promise<void>;
}

export interface OpenCodeSessionApi {
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
        operation === 'prompt' && capabilities?.promptAbortSignal
          ? await method.call(sessionClient.session, firstInput, {
              signal: options.signal,
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
        operation === 'prompt' && capabilities?.promptAbortSignal
          ? await method.call(sessionClient.session, fallbackInput, {
              signal: options.signal,
            })
          : await method.call(sessionClient.session, fallbackInput);
      const unwrapped = unwrapData(response, operation) as T;
      shapes.set(operation, fallbackShape);
      return unwrapped;
    }
  }

  return Object.freeze({
    messages(
      sessionID: string,
      options: {limit?: number} = {},
    ): Promise<unknown[]> {
      return invoke<unknown[]>(
        'messages',
        {sessionID, ...options},
        {path: {id: sessionID}, query: options},
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
