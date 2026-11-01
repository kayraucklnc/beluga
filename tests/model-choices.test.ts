import { describe, expect, it } from 'vitest';
import { toModelChoices } from '../src/agent/runtime/claude/runner.js';

describe("the model picker's rows from Claude Code's list", () => {
  it('says "Default", not "Default (recommended)", and keeps every other name as it is', () => {
    const rows = toModelChoices([
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus for planning, Sonnet otherwise', supportedEffortLevels: ['low', 'high'] },
      { value: 'opus', displayName: 'Opus', description: 'For the hardest work' },
    ]);
    expect(rows).toEqual([
      { value: '', label: 'Default', description: 'Opus for planning, Sonnet otherwise', efforts: ['low', 'high'] },
      { value: 'opus', label: 'Opus', description: 'For the hardest work' },
    ]);
  });
});
