import {describe, expect, test} from 'bun:test';
import {createOpencodeClient as legacyClient} from '@opencode-ai/sdk';
import {createOpencodeClient as flatClient} from '@opencode-ai/sdk/v2';
import {
  buildVerifierChildPermissions,
  VERIFIER_SESSION_PERMISSIONS,
} from '../src/plugin-v2-tools-agents.ts';
import type {V2PermissionRule} from '../src/plugin-v2-helpers.ts';
import {createChildSessionVerifier} from '../src/child-session-verifier.ts';
import {createGoalState} from '../src/state-machine.ts';
import {createOpenCodeSessionApi, SessionApiError} from '../src/session-api.ts';

// Evaluate permission decisions using the released host's documented wildcard
// grammar. The live-host companion also exercises these inputs through the
// actual v2.2.7 permission endpoint; this helper keeps unit tests self-contained.
function match(value: string, pattern: string): boolean {
  let expression = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (expression.endsWith(' .*'))
    expression = expression.slice(0, -3) + '( .*)?';
  return new RegExp(
    `^${expression}$`,
    process.platform === 'win32' ? 'si' : 's',
  ).test(value.replaceAll('\\', '/'));
}

function decision(rules: V2PermissionRule[], action: string, resource: string) {
  return (
    rules.findLast(
      rule => match(action, rule.action) && match(resource, rule.resource),
    )?.effect ?? 'ask'
  );
}

const parent = (rules: V2PermissionRule[]) => ({
  id: 'parent',
  location: {directory: '/repo'},
  permissions: rules,
});
const rulesFor = (rules: V2PermissionRule[]) =>
  buildVerifierChildPermissions(parent(rules), 'parent')
    .permissions as V2PermissionRule[];

describe('verifier capability ceiling and parent restrictions', () => {
  test('resolved agent config denials survive when the parent has no session rules', () => {
    const agentRules: V2PermissionRule[] = [
      ...VERIFIER_SESSION_PERMISSIONS,
      {action: 'read', resource: '*restricted-fixture.txt', effect: 'deny'},
      {action: 'glob', resource: '*private*', effect: 'ask'},
    ];
    const before = structuredClone(agentRules);
    const rules = buildVerifierChildPermissions(
      parent([]),
      'parent',
      agentRules,
    ).permissions as V2PermissionRule[];
    expect(decision(rules, 'read', '/repo/restricted-fixture.txt')).toBe(
      'deny',
    );
    expect(decision(rules, 'glob', '/repo/private/**')).toBe('ask');
    expect(decision(rules, 'read', '/repo/source.ts')).toBe('allow');
    expect(decision(rules, 'bash', '*')).toBe('deny');
    expect(agentRules).toEqual(before);
  });

  test('resolved stock verifier policy still permits .env.example', () => {
    const rules = buildVerifierChildPermissions(
      parent([]),
      'parent',
      VERIFIER_SESSION_PERMISSIONS,
    ).permissions as V2PermissionRule[];
    expect(decision(rules, 'read', '/repo/.env.example')).toBe('allow');
    expect(decision(rules, 'read', '/repo/.env')).toBe('deny');
    expect(decision(rules, 'read', '/repo/.env.production')).toBe('deny');
    const restricted = buildVerifierChildPermissions(
      parent([{action: 'read', resource: '*.env.example', effect: 'deny'}]),
      'parent',
      VERIFIER_SESSION_PERMISSIONS,
    ).permissions as V2PermissionRule[];
    expect(decision(restricted, 'read', '/repo/.env.example')).toBe('deny');
  });

  test('explicit parent session rules keep the host precedence without allowing mutation', () => {
    const rules = buildVerifierChildPermissions(
      parent([{action: '*', resource: '*', effect: 'allow'}]),
      'parent',
      [{action: 'read', resource: '*restricted-fixture.txt', effect: 'deny'}],
    ).permissions as V2PermissionRule[];
    expect(decision(rules, 'read', '/repo/restricted-fixture.txt')).toBe(
      'allow',
    );
    expect(decision(rules, 'write', '/repo/restricted-fixture.txt')).toBe(
      'deny',
    );
  });

  const cases: Array<{
    name: string;
    rules: V2PermissionRule[];
    action: string;
    resource: string;
    expected: 'allow' | 'deny' | 'ask';
  }> = [
    {
      name: 'read remains available with no parent restriction',
      rules: [],
      action: 'read',
      resource: '/repo/source.ts',
      expected: 'allow',
    },
    {
      name: 'an explicit parent read denial survives',
      rules: [{action: 'read', resource: '*secrets.pem', effect: 'deny'}],
      action: 'read',
      resource: '/repo/secrets.pem',
      expected: 'deny',
    },
    {
      name: 'an ask rule is not promoted to allow',
      rules: [{action: 'read', resource: '*private*', effect: 'ask'}],
      action: 'read',
      resource: '/repo/private.txt',
      expected: 'ask',
    },
    {
      name: 'a later allow can narrow an earlier parent denial',
      rules: [
        {action: 'read', resource: '*', effect: 'deny'},
        {action: 'read', resource: '*README.md', effect: 'allow'},
      ],
      action: 'read',
      resource: '/repo/README.md',
      expected: 'allow',
    },
    {
      name: 'a later parent denial still overrides an allow',
      rules: [
        {action: '*', resource: '*', effect: 'allow'},
        {action: 'read', resource: '*README.md', effect: 'deny'},
      ],
      action: 'read',
      resource: '/repo/README.md',
      expected: 'deny',
    },
    {
      name: 'wildcard action rules are projected with host semantics',
      rules: [{action: 'r??d', resource: '*private*', effect: 'deny'}],
      action: 'read',
      resource: '/repo/private.txt',
      expected: 'deny',
    },
    {
      name: 'host optional trailing argument wildcard is preserved',
      rules: [{action: 'read *', resource: '*', effect: 'deny'}],
      action: 'read',
      resource: '/repo/source.ts',
      expected: 'deny',
    },
    {
      name: 'regex punctuation in an action is literal',
      rules: [{action: 'read|write', resource: '*', effect: 'deny'}],
      action: 'read',
      resource: '/repo/source.ts',
      expected: 'allow',
    },
    {
      name: 'glob restrictions survive wildcard action projection',
      rules: [{action: 'g*', resource: '*private*', effect: 'deny'}],
      action: 'glob',
      resource: '/repo/private/**',
      expected: 'deny',
    },
    {
      name: 'grep restrictions survive wildcard action projection',
      rules: [{action: 'g*', resource: '*private*', effect: 'deny'}],
      action: 'grep',
      resource: '/repo/private/**',
      expected: 'deny',
    },
    {
      name: 'parent allow-all cannot reopen .env reads',
      rules: [{action: '*', resource: '*', effect: 'allow'}],
      action: 'read',
      resource: '/repo/.env',
      expected: 'deny',
    },
    {
      name: 'parent explicit allow cannot reopen .env variants',
      rules: [{action: 'read', resource: '*', effect: 'allow'}],
      action: 'read',
      resource: '/repo/.env.local',
      expected: 'deny',
    },
    {
      name: 'example remains readable for an unrestricted parent',
      rules: [{action: '*', resource: '*', effect: 'allow'}],
      action: 'read',
      resource: '/repo/.env.example',
      expected: 'allow',
    },
    {
      name: 'example exception never overrides parent denial',
      rules: [{action: 'read', resource: '*.env.example', effect: 'deny'}],
      action: 'read',
      resource: '/repo/.env.example',
      expected: 'deny',
    },
    {
      name: 'example exception conservatively preserves parent ask',
      rules: [{action: 'read', resource: '*.env.example', effect: 'ask'}],
      action: 'read',
      resource: '/repo/.env.example',
      expected: 'deny',
    },
    {
      name: 'later global parent allow legitimately clears earlier restrictions',
      rules: [
        {action: 'read', resource: '*', effect: 'deny'},
        {action: 'read', resource: '*', effect: 'allow'},
      ],
      action: 'read',
      resource: '/repo/.env.example',
      expected: 'allow',
    },
  ];
  for (const item of cases) {
    test(item.name, () => {
      const before = structuredClone(item.rules);
      const rules = rulesFor(item.rules);
      expect(decision(rules, item.action, item.resource)).toBe(item.expected);
      expect(item.rules).toEqual(before);
      for (const action of [
        'edit',
        'write',
        'patch',
        'bash',
        'shell',
        'create_goal',
        'update_goal',
        'goal-command',
        'execute',
        'unregistered_new_tool',
      ]) {
        expect(decision(rules, action, '/repo/source.ts')).toBe('deny');
      }
    });
  }

  test('v1 policy uses its supported singular field and rule names', () => {
    const policy = buildVerifierChildPermissions(
      {
        id: 'parent',
        directory: '/repo',
        permission: [
          {permission: '*', pattern: '*', action: 'allow'},
          {permission: 'read', pattern: '*secrets.pem', action: 'deny'},
        ],
      },
      'parent',
    );
    expect(policy.permissions).toBeUndefined();
    const rules = (
      policy.permission as Array<{
        permission: string;
        pattern: string;
        action: V2PermissionRule['effect'];
      }>
    ).map(rule => ({
      action: rule.permission,
      resource: rule.pattern,
      effect: rule.action,
    }));
    expect(decision(rules, 'read', '/repo/secrets.pem')).toBe('deny');
    expect(decision(rules, 'read', '/repo/source.ts')).toBe('allow');
    expect(decision(rules, 'write', '/repo/source.ts')).toBe('deny');
  });

  test('unreadable, ambiguous and malformed parent policies fail explicitly', () => {
    for (const value of [
      null,
      {},
      {id: 'other', location: {directory: '/repo'}},
      {id: 'parent'},
      {...parent([]), permissions: null},
      {...parent([]), permission: []},
      {...parent([]), permissions: ['deny']},
      {
        ...parent([]),
        permissions: [{action: '*', resource: '*', effect: 'unknown'}],
      },
    ]) {
      expect(() => buildVerifierChildPermissions(value, 'parent')).toThrow();
    }
  });
});

const context = {
  cwd: '/repo',
  taskId: 'goal-1',
  candidateIdentity: {candidate: 'c', fingerprint: 'f'},
  goal: createGoalState('parent', 'Check files', {
    goalId: 'goal-1',
    runId: 'run-1',
  }),
  latestText: 'Done',
};

for (const [shape, makeClient] of [
  ['legacy', legacyClient],
  ['flat', flatClient],
] as const) {
  test(`installed SDK ${shape} sends a narrowed v1 permission policy`, async () => {
    let createdBody: Record<string, unknown> | undefined;
    let deletes = 0;
    const fetcher = async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/agent')
        return Response.json([
          {
            name: 'goal-verify',
            permission: [
              {
                permission: 'read',
                pattern: '*configured-private.txt',
                action: 'deny',
              },
            ],
          },
        ]);
      if (request.method === 'DELETE') {
        deletes++;
        return Response.json(true);
      }
      if (request.method === 'POST' && path === '/session') {
        createdBody = (await request.json()) as Record<string, unknown>;
        return Response.json({
          id: 'child',
          parentID: 'parent',
          directory: '/repo',
          permission: createdBody.permission,
        });
      }
      if (path.endsWith('/message'))
        return Response.json({
          parts: [
            {
              type: 'text',
              text: JSON.stringify({
                schema_version: 1,
                task_id: 'goal-1',
                state: 'COMPLETE',
                outstanding: [],
                evidence: ['checked'],
              }),
            },
          ],
        });
      const id = path.split('/').at(-1);
      return Response.json({
        id,
        directory: '/repo',
        permission: [
          {permission: 'read', pattern: '*secrets.pem', action: 'deny'},
        ],
      });
    };
    const client = makeClient({
      baseUrl: 'http://sdk.test',
      fetch: fetcher as unknown as typeof fetch,
    });
    const result = await createChildSessionVerifier(client, {sdkShape: shape})(
      context,
    );
    expect(result.state).toBe('COMPLETE');
    expect(createdBody?.permissions).toBeUndefined();
    expect(createdBody?.permission).toContainEqual({
      permission: 'read',
      pattern: '*secrets.pem',
      action: 'deny',
    });
    expect(createdBody?.permission).toContainEqual({
      permission: 'read',
      pattern: '*configured-private.txt',
      action: 'deny',
    });
    expect(deletes).toBe(1);
  });

  test(`installed SDK ${shape} failure envelopes preserve status and structured cause`, async () => {
    const detail = {
      _tag: 'SessionNotFoundError',
      sessionID: 'child',
      message: 'Session missing',
    };
    const client = makeClient({
      baseUrl: 'http://sdk.test',
      fetch: (async () =>
        Response.json(detail, {status: 404})) as unknown as typeof fetch,
    });
    const api = createOpenCodeSessionApi(client, {preferredShape: shape});
    let fault: unknown;
    try {
      await api.delete('child');
    } catch (error) {
      fault = error;
    }
    expect(fault).toBeInstanceOf(SessionApiError);
    expect((fault as SessionApiError).status).toBe(404);
    expect((fault as Error).cause).toEqual(detail);
  });
}

describe('verifier fail-closed parent policy, legacy fallback, agent check, and SessionApiError', () => {
  test('failing or malformed parent session.get fails closed without creating or prompting child', async () => {
    let created = 0;
    let prompted = 0;
    const throwingClient = {
      session: {
        get: async () => {
          throw new Error('parent lookup failed');
        },
        create: async () => {
          created++;
          return {id: 'child', parentID: 'parent'};
        },
        prompt: async () => {
          prompted++;
          return {};
        },
        delete: async () => ({}),
      },
    };
    await expect(
      createChildSessionVerifier(throwingClient, {sdkShape: 'flat'})(context),
    ).rejects.toThrow('parent lookup failed');
    const approved = await createChildSessionVerifier(throwingClient, {
      sdkShape: 'flat',
      failurePolicy: 'approve',
    })(context);
    expect(approved.state).toBe('WORKING');
    expect(created).toBe(0);
    expect(prompted).toBe(0);

    const malformedClient = {
      session: {
        get: async () => ({
          id: 'parent',
          location: {directory: '/repo'},
          permissions: 'bad',
        }),
        create: async () => {
          created++;
          return {id: 'child', parentID: 'parent'};
        },
        prompt: async () => {
          prompted++;
          return {};
        },
        delete: async () => ({}),
      },
    };
    await expect(
      createChildSessionVerifier(malformedClient, {sdkShape: 'flat'})(context),
    ).rejects.toThrow('malformed');
    expect(created).toBe(0);
    expect(prompted).toBe(0);
  });

  test('legacy host without session.get sends v1 permission ceiling, not v2 permissions', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const client = {
      session: {
        create: async (input: {body?: Record<string, unknown>}) => {
          capturedBody = input.body;
          return {id: 'child', parentID: 'parent'};
        },
        prompt: async () => ({
          parts: [
            {
              type: 'text',
              text: JSON.stringify({
                schema_version: 1,
                task_id: 'goal-1',
                state: 'COMPLETE',
                outstanding: [],
                evidence: ['checked'],
              }),
            },
          ],
        }),
        delete: async () => ({}),
      },
    };
    const verdict = await createChildSessionVerifier(client, {
      sdkShape: 'legacy',
    })(context);
    expect(verdict.state).toBe('COMPLETE');
    expect(capturedBody?.permissions).toBeUndefined();
    expect(Array.isArray(capturedBody?.permission)).toBe(true);
    expect(capturedBody?.permission).toContainEqual({
      permission: '*',
      pattern: '*',
      action: 'deny',
    });
  });

  test('selectAgent host fails closed when child session leaves agent unset', async () => {
    const client = {
      sessionCapabilities: {
        deleteSession: true,
        selectAgent: async () => {},
      },
      session: {
        get: async (input: {sessionID?: string}) =>
          input.sessionID === 'parent'
            ? {id: 'parent', location: {directory: '/repo'}, permissions: []}
            : {id: 'child', parentID: 'parent', location: {directory: '/repo'}},
        create: async () => ({id: 'child', parentID: 'parent'}),
        prompt: async () => ({
          parts: [
            {
              type: 'text',
              text: JSON.stringify({
                schema_version: 1,
                task_id: 'goal-1',
                state: 'COMPLETE',
                outstanding: [],
                evidence: ['checked'],
              }),
            },
          ],
        }),
        delete: async () => ({}),
      },
    };
    await expect(
      createChildSessionVerifier(client, {sdkShape: 'flat'})(context),
    ).rejects.toThrow(/agent/i);
  });

  test('SessionApiError ignores empty detail.message and falls back to _tag', () => {
    const err = new SessionApiError(
      'delete',
      {message: '', _tag: 'SessionNotFoundError', sessionID: 'c1'},
      {status: 404},
    );
    expect(err.message).toContain('SessionNotFoundError');
  });
});
