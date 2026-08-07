import { describe, expect, it } from 'vitest';
import { api, post, put } from './api';

describe('web api helpers smoke', () => {
  it('exports api helper functions', () => {
    expect(typeof api).toBe('function');
    expect(typeof post).toBe('function');
    expect(typeof put).toBe('function');
  });
});
