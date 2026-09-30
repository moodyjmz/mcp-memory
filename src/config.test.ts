import { describe, it, expect } from 'vitest';
import { evictionConfigFromEnv } from './config.js';

describe('MEMORY_MAX_COUNT', () => {
  it.each([undefined, '', '  '])('defaults to 2000 when unset (%j)', raw => {
    expect(evictionConfigFromEnv({ MEMORY_MAX_COUNT: raw })).toEqual({ maxMemories: 2000 });
  });

  it.each(['500', ' 500 ', '0500', '+500'])('accepts %j as 500', raw => {
    expect(evictionConfigFromEnv({ MEMORY_MAX_COUNT: raw })).toEqual({ maxMemories: 500 });
  });

  it.each(['0', '000', '-1', 'abc', '1e3', '3.7', '5 00', '99999999999999999999'])('refuses %j', raw => {
    expect(() => evictionConfigFromEnv({ MEMORY_MAX_COUNT: raw })).toThrow(`MEMORY_MAX_COUNT must be a positive whole number, got "${raw}"`);
  });
});
