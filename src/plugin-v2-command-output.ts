/** Passive command receipts. OpenCode synthetic messages are executable input. */

export interface GoalCommandOutput {
  id: string;
  sessionID: string;
  text: string;
  kind: 'command' | 'notice';
  timestamp: number;
}

const outputSchema = {
  type: 'object',
  properties: {
    id: {type: 'string'},
    sessionID: {type: 'string'},
    text: {type: 'string'},
    kind: {enum: ['command', 'notice']},
    timestamp: {type: 'number'},
  },
  required: ['id', 'sessionID', 'text', 'kind', 'timestamp'],
  additionalProperties: false,
} as const;

/** Shared with the TUI companion and available to other v2 clients. */
export const GOAL_OUTPUT_RPC = {
  id: 'fixate-on-output',
  methods: {
    latest: {
      input: {
        type: 'object',
        properties: {sessionID: {type: 'string', minLength: 1}},
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: {anyOf: [outputSchema, {type: 'null'}]},
    },
  },
  events: {output: {schema: outputSchema}},
} as const;

export interface GoalOutputRpcRegistration {
  events: {emit(name: 'output', output: GoalCommandOutput): Promise<void>};
  dispose(): Promise<void> | void;
}

export interface GoalOutputRpcDomain {
  register(
    definition: typeof GOAL_OUTPUT_RPC,
    handlers: {
      latest(input: unknown): Promise<GoalCommandOutput | null>;
    },
  ): Promise<GoalOutputRpcRegistration>;
}

const MAX_OUTPUT_SESSIONS = 256;

export function createGoalOutputPublisher(
  fallback?: (sessionID: string, text: string) => Promise<void>,
) {
  const latest = new Map<string, GoalCommandOutput>();
  let registration: GoalOutputRpcRegistration | undefined;
  let disposed = false;

  return {
    async register(rpc: GoalOutputRpcDomain | undefined): Promise<void> {
      if (!rpc || disposed || registration) return;
      try {
        const reg = await rpc.register(GOAL_OUTPUT_RPC, {
          latest: async input => {
            const sessionID =
              input && typeof input === 'object' && 'sessionID' in input
                ? input.sessionID
                : undefined;
            return typeof sessionID === 'string'
              ? (latest.get(sessionID) ?? null)
              : null;
          },
        });
        if (disposed) {
          await reg.dispose();
          return;
        }
        registration = reg;
      } catch {
        // A host with a broken RPC domain is a host without a passive output
        // channel; treat it like one so the messenger/explicit-error fallback
        // applies instead of failing plugin setup.
      }
    },

    async publish(
      sessionID: string,
      text: string,
      kind: GoalCommandOutput['kind'] = 'notice',
    ): Promise<void> {
      if (disposed)
        throw new Error('Goal output is unavailable after disposal.');
      if (!sessionID || !text) return;
      const output: GoalCommandOutput = {
        id: crypto.randomUUID(),
        sessionID,
        text,
        kind,
        timestamp: Date.now(),
      };
      latest.delete(sessionID);
      latest.set(sessionID, output);
      while (latest.size > MAX_OUTPUT_SESSIONS) {
        latest.delete(latest.keys().next().value!);
      }
      // The receipt is cached above before any delivery attempt. A transport
      // fault must not turn an already-successful command into a reported
      // failure: the TUI recovers the receipt through `latest` on reconnect.
      // Keep the text visible to headless clients through a best-effort
      // messenger when one is configured.
      if (registration) {
        try {
          await registration.events.emit('output', output);
        } catch {
          if (fallback) await fallback(sessionID, text).catch(() => {});
        }
      } else if (fallback) {
        await fallback(sessionID, text);
      } else {
        // Never replace a missing display channel with model input. Include the
        // result in the host's visible command error so it is not silently lost.
        throw new Error(
          `The goal command completed, but this host has no passive output channel.\n${text}`,
        );
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      latest.clear();
      await registration?.dispose();
    },
  };
}

export function parseGoalCommandOutput(
  value: unknown,
): GoalCommandOutput | null {
  if (!value || typeof value !== 'object') return null;
  const output = value as Partial<GoalCommandOutput>;
  return typeof output.id === 'string' &&
    output.id.length > 0 &&
    typeof output.sessionID === 'string' &&
    output.sessionID.length > 0 &&
    typeof output.text === 'string' &&
    output.text.length > 0 &&
    (output.kind === 'command' || output.kind === 'notice') &&
    typeof output.timestamp === 'number' &&
    Number.isFinite(output.timestamp)
    ? (output as GoalCommandOutput)
    : null;
}
