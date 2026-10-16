import { describe, expect, it } from 'vitest';
import { fuzzyBest, fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('matches everything for an empty query', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('requires characters in order', () => {
    expect(fuzzyScore('ord', 'orders-api')).not.toBeNull();
    expect(fuzzyScore('oapi', 'orders-api')).not.toBeNull();
    expect(fuzzyScore('ipa', 'orders-api')).toBeNull();
  });

  it('ranks substrings and word starts higher', () => {
    const prefix = fuzzyScore('api', 'api-gateway')!;
    const word = fuzzyScore('api', 'orders-api')!;
    const scattered = fuzzyScore('api', 'a pretty icon')!;
    expect(prefix).toBeGreaterThan(scattered);
    expect(word).toBeGreaterThan(scattered);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('ORDERS', 'orders')).not.toBeNull();
  });
});

describe('fuzzyBest', () => {
  it('prefers matches in the first field', () => {
    const byName = fuzzyBest('orders', ['Orders', 'C:\\Projects\\x'])!;
    const byPath = fuzzyBest('orders', ['Other', 'C:\\Projects\\orders'])!;
    expect(byName).toBeGreaterThan(byPath);
    expect(fuzzyBest('zzz', ['a', 'b'])).toBeNull();
  });
});
