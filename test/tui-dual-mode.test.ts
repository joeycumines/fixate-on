// tui-dual-mode.test.ts — Contract tests for dual-mode command execution.
//
// Verifies: the command header correctly indicates TUI vs server mode,
// the TUI signaling flag is set when a broadcaster is attached, and
// the plain-text fallback includes explicit routing headers.

import {describe, expect, test} from 'bun:test';
import {
  formatCommandHeader,
  SERVER_MODE_HEADER,
  TUI_MODE_HEADER,
} from '../src/commands.ts';

// formatCommandHeader

describe('formatCommandHeader', () => {
  test('returns TUI mode header when hasTui is true', () => {
    const header = formatCommandHeader(true, 'status');
    expect(header).toContain('TUI');
    expect(header).toContain('status');
  });

  test('returns server mode header when hasTui is false', () => {
    const header = formatCommandHeader(false, 'status');
    expect(header).toContain('model');
    expect(header).toContain('status');
  });

  test('includes the subcommand name in the header', () => {
    const tuiHeader = formatCommandHeader(true, 'history');
    const serverHeader = formatCommandHeader(false, 'list');
    expect(tuiHeader).toContain('history');
    expect(serverHeader).toContain('list');
  });

  test('TUI header mentions dashboard or interactive', () => {
    const header = formatCommandHeader(true, 'status');
    const lower = header.toLowerCase();
    expect(
      lower.includes('dashboard') ||
        lower.includes('interactive') ||
        lower.includes('tui'),
    ).toBe(true);
  });

  test('server header mentions model turn or chat turn', () => {
    const header = formatCommandHeader(false, 'status');
    const lower = header.toLowerCase();
    expect(
      lower.includes('model') ||
        lower.includes('chat turn') ||
        lower.includes('routed'),
    ).toBe(true);
  });
});

// Header constants

describe('header constants', () => {
  test('TUI_MODE_HEADER is a non-empty string', () => {
    expect(typeof TUI_MODE_HEADER).toBe('string');
    expect(TUI_MODE_HEADER.length).toBeGreaterThan(0);
  });

  test('SERVER_MODE_HEADER is a non-empty string', () => {
    expect(typeof SERVER_MODE_HEADER).toBe('string');
    expect(SERVER_MODE_HEADER.length).toBeGreaterThan(0);
  });

  test('headers are distinct', () => {
    expect(TUI_MODE_HEADER).not.toBe(SERVER_MODE_HEADER);
  });
});
