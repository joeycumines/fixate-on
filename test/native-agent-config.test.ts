import {expect, test} from 'bun:test';
import {
  applyNativeGoalConfig,
  type OpenCodeConfig,
} from '../src/native-agent-config.ts';

test('registers native goal and read-only verifier agents', () => {
  const config: OpenCodeConfig = {};
  expect(applyNativeGoalConfig(config)).toBe(config);
  expect(config.agent!.goal!.mode).toBe('primary');
  expect(config.agent!.goal!.prompt).toMatch(/verification evidence/);
  expect(config.agent!['goal-verify']!.mode).toBe('subagent');
  expect(config.agent!['goal-verify']!.hidden).toBe(true);
  expect(config.agent!['goal-verify']!.permission!['*']).toBe('deny');
  expect(config.agent!['goal-verify']!.permission!.read).toBe('allow');
  expect(config.agent!['goal-verify']!.permission!.glob).toBe('allow');
  expect(config.agent!['goal-verify']!.permission!.grep).toBe('allow');
  expect(config.agent!['goal-verify']!.permission!.edit).toBe('deny');
  expect(config.agent!['goal-verify']!.permission!.bash).toBe('deny');
  expect(config.agent!['goal-verify']!.tools!.bash).toBe(false);
  expect(config.agent!['goal-verify']!.tools!.edit).toBe(false);
  expect(config.agent!['goal-verify']!.tools!.update_goal).toBe(false);
});

test('auto-registers the /goal slash command (zero-config)', () => {
  const config: OpenCodeConfig = {};
  applyNativeGoalConfig(config);
  expect(config.command).toBeDefined();
  expect(config.command!.goal).toBeDefined();
  expect(config.command!.goal!.template).toContain(
    'Call the goal-command tool exactly once',
  );
  expect(config.command!.goal!.template).toContain('$ARGUMENTS');
  // Command is registered without `agent` — hook handles all
  // routing; no agent turn consumed for subcommands.
  expect(config.command!.goal!.agent).toBeUndefined();
  expect(config.command!.goal!.description).toMatch(/session-scoped goal/);
});

test('auto-registered command respects custom commandName and agent name', () => {
  const config: OpenCodeConfig = {};
  applyNativeGoalConfig(config, {
    commandName: '/objective',
    goalAgentName: 'objective',
  });
  expect(config.command!.objective).toBeDefined();
  expect(config.command!.objective!.agent).toBeUndefined();
  expect(config.command!.goal).toBeUndefined();
});

test('auto-registered command is skipped when registerCommand is false', () => {
  const config: OpenCodeConfig = {};
  applyNativeGoalConfig(config, {registerCommand: false});
  expect(config.command).toBeUndefined();
});

test('auto-registration preserves a user-defined command, minus its agent field', () => {
  // The name of this test used to claim the definition was preserved as-is, and
  // the assertion it made — object IDENTITY — could not tell, because the code
  // mutates the user's object in place to delete the `agent` key. Identity
  // survived, the test passed, and the plugin silently dropped a field the
  // documentation said it keeps. It asserts the resulting SHAPE now, which
  // is the thing that actually changed.
  const custom = {template: 'do my thing', agent: 'build', description: 'mine'};
  const config = {command: {goal: custom}};
  applyNativeGoalConfig(config);
  const registered = config.command!.goal as Record<string, unknown>;
  expect(registered).toEqual({template: 'do my thing', description: 'mine'});
  // Explicit, because "the field is gone" is the load-bearing part and an
  // object-shaped assertion can pass for the wrong reason.
  expect('agent' in registered).toBe(false);
  expect(Object.keys(config.command!).length).toBe(1);
});

test('a user-defined command with no agent field is left exactly as written', () => {
  // The other half of the guarantee: nothing is rewritten when there is nothing
  // to strip, so a user who does not set `agent` gets their command untouched.
  const custom = {template: 'do my thing', description: 'mine'};
  const config = {command: {goal: custom}};
  applyNativeGoalConfig(config);
  expect(config.command!.goal).toEqual({
    template: 'do my thing',
    description: 'mine',
  });
  expect(config.command!.goal).toBe(custom);
});

test('preserves user-defined agents and is idempotent', () => {
  const custom = {description: 'mine', mode: 'primary'};
  const config = {agent: {goal: custom}};
  applyNativeGoalConfig(config);
  applyNativeGoalConfig(config);
  expect(config.agent!.goal).toBe(custom);
  expect(Object.keys(config.agent!).length).toBe(2);
});

test('supports custom names and registration opt-out', () => {
  const custom: OpenCodeConfig = {};
  applyNativeGoalConfig(custom, {
    goalAgentName: 'objective',
    verifierAgentName: 'objective-check',
  });
  expect(custom.agent!.objective).toBeDefined();
  expect(custom.agent!['objective-check']).toBeDefined();

  const disabled: OpenCodeConfig = {};
  applyNativeGoalConfig(disabled, {registerAgents: false});
  expect(disabled.agent).toBeUndefined();
  expect(disabled.command?.goal).toBeUndefined();
});

test('registers a command without agent registration only for an existing target agent', () => {
  const config: OpenCodeConfig = {agent: {goal: {mode: 'primary'}}};
  applyNativeGoalConfig(config, {registerAgents: false});
  expect(config.command?.goal?.agent).toBeUndefined();
});

test('validates config and agent names at the boundary', () => {
  expect(() => applyNativeGoalConfig(null as never)).toThrow(
    /mutable config object/,
  );
  expect(() => applyNativeGoalConfig({}, {goalAgentName: ''})).toThrow(
    /non-empty string/,
  );
  expect(() =>
    applyNativeGoalConfig({}, {verifierAgentName: 42 as never}),
  ).toThrow(/non-empty string/);
  expect(() =>
    applyNativeGoalConfig(
      {},
      {
        goalAgentName: 'same',
        verifierAgentName: 'same',
      },
    ),
  ).toThrow(/must be different/);
  expect(() =>
    applyNativeGoalConfig({}, {verifierAgentName: ' verifier '}),
  ).toThrow(/surrounding whitespace/);
  expect(() =>
    applyNativeGoalConfig(
      {agent: {verifier: {}}},
      {
        verifierAgentName: 'verifier',
        requireVerifierOwnership: true,
      },
    ),
  ).toThrow(/cannot safely use existing agent/);
});

test('goal agent has NO tool restrictions', () => {
  const config: OpenCodeConfig = {};
  applyNativeGoalConfig(config);
  expect(config.agent!.goal!.tools).toBeUndefined();
  expect(config.agent!.goal!.permission).toBeUndefined();
  expect(config.agent!['goal-verify']!.tools).toBeDefined();
  expect(config.agent!['goal-verify']!.tools!.update_goal).toBe(false);
  expect(config.agent!['goal-verify']!.tools!.create_goal).toBe(false);
  expect(config.command!.goal!.agent).toBeUndefined();
});

// Native agent config edge case stress tests

test('rejects array config', () => {
  expect(() => applyNativeGoalConfig([] as never)).toThrow(
    /mutable config object/,
  );
});

test('rejects undefined config', () => {
  expect(() => applyNativeGoalConfig(undefined as never)).toThrow(
    /mutable config object/,
  );
});

test('rejects string config', () => {
  expect(() => applyNativeGoalConfig('not-an-object' as never)).toThrow(
    /mutable config object/,
  );
});

test('rejects number config', () => {
  expect(() => applyNativeGoalConfig(42 as never)).toThrow(
    /mutable config object/,
  );
});

test('commandName with multiple leading slashes strips all', () => {
  const config: OpenCodeConfig = {};
  applyNativeGoalConfig(config, {commandName: '///objective'});
  expect(config.command!.objective).toBeDefined();
  expect(config.command!.goal).toBeUndefined();
});

test('commandName with only whitespace defaults to goal', () => {
  const config: OpenCodeConfig = {};
  applyNativeGoalConfig(config, {commandName: '   '});
  expect(config.command!.goal).toBeDefined();
});

test('commandName with only slashes defaults to goal', () => {
  const config: OpenCodeConfig = {};
  applyNativeGoalConfig(config, {commandName: '///'});
  expect(config.command!.goal).toBeDefined();
});

test('both registerAgents and registerCommand false returns empty config', () => {
  const config: OpenCodeConfig = {};
  applyNativeGoalConfig(config, {
    registerAgents: false,
    registerCommand: false,
  });
  expect(config.agent).toBeUndefined();
  expect(config.command).toBeUndefined();
});

test('no unusable command is registered when agents are disabled', () => {
  const config: OpenCodeConfig = {};
  applyNativeGoalConfig(config, {registerAgents: false});
  expect(config.agent).toBeUndefined();
  expect(config.command).toBeUndefined();
});

test('existing agents preserved when registerCommand is false', () => {
  const config: OpenCodeConfig = {};
  applyNativeGoalConfig(config, {registerCommand: false});
  expect(config.agent).toBeDefined();
  expect(config.command).toBeUndefined();
});

test('goalAgentName with whitespace throws', () => {
  expect(() => applyNativeGoalConfig({}, {goalAgentName: ' goal '})).toThrow(
    /surrounding whitespace/,
  );
});

test('commandName with slash and whitespace is handled', () => {
  const config: OpenCodeConfig = {};
  applyNativeGoalConfig(config, {commandName: '  /my-command  '});
  expect(config.command!['my-command']).toBeDefined();
});

// Verifier ownership: a pre-existing agent the judge will address

const SAFE_VERIFIER = {
  permission: {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    edit: 'deny',
    bash: 'deny',
  },
  tools: {
    bash: false,
    write: false,
    edit: false,
    patch: false,
    create_goal: false,
    update_goal: false,
  },
};

test('a pre-existing write-enabled verifier agent throws when the judge will address it', () => {
  // The hole this closes: registerAgents=false leaves the user's agent in
  // place, and the judge still addresses it by name — a write-enabled
  // 'goal-verify' would be silently trusted as the attestation source.
  const config: OpenCodeConfig = {
    agent: {
      'goal-verify': {
        mode: 'subagent',
        permission: {'*': 'allow'},
        tools: {bash: true},
      },
    },
  };
  expect(() =>
    applyNativeGoalConfig(config, {
      registerAgents: false,
      verifierAgentAddressed: true,
    }),
  ).toThrow(/addressed as the verifier but is not read-only/);
});

test('a pre-existing read-only verifier agent matching the safe shape is accepted when addressed', () => {
  const config: OpenCodeConfig = {
    agent: {'goal-verify': {mode: 'subagent', ...SAFE_VERIFIER}},
  };
  applyNativeGoalConfig(config, {
    registerAgents: false,
    verifierAgentAddressed: true,
  });
  // untouched — the shape already is the plugin's own
  expect(config.agent!['goal-verify']!.permission!['*']).toBe('deny');
});

test('a pre-existing agent missing the tools block throws when addressed', () => {
  // permission alone is not enough: a host may honor permission but not
  // tools (or vice versa); both must match.
  const config: OpenCodeConfig = {
    agent: {'goal-verify': {permission: {...SAFE_VERIFIER.permission}}},
  };
  expect(() =>
    applyNativeGoalConfig(config, {
      registerAgents: false,
      verifierAgentAddressed: true,
    }),
  ).toThrow(/not read-only/);
});

test('requireVerifierOwnership still refuses any pre-existing agent, safe-shaped or not', () => {
  const config: OpenCodeConfig = {agent: {'goal-verify': {...SAFE_VERIFIER}}};
  expect(() =>
    applyNativeGoalConfig(config, {requireVerifierOwnership: true}),
  ).toThrow(/cannot safely use existing agent/);
});

test('an unaddressed pre-existing verifier agent is preserved untouched', () => {
  // No judge will run as this agent, so the plugin does not police its shape.
  const custom = {description: 'mine', mode: 'subagent', tools: {bash: true}};
  const config: OpenCodeConfig = {agent: {'goal-verify': custom}};
  applyNativeGoalConfig(config, {registerAgents: false});
  expect(config.agent!['goal-verify']).toBe(custom);
});

test('a write-enabled verifier agent throws even with agents registration on', () => {
  const config: OpenCodeConfig = {
    agent: {'goal-verify': {permission: {'*': 'allow'}, tools: {bash: true}}},
  };
  expect(() =>
    applyNativeGoalConfig(config, {verifierAgentAddressed: true}),
  ).toThrow(/not read-only/);
});
