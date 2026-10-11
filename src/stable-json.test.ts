import { stableStringify } from './stable-json';

describe('stableStringify', () => {
  it('preserves special JSON keys so distinct request payloads cannot share a canonical value', () => {
    const payload = JSON.parse('{"name":"one","__proto__":{"changed":true},"constructor":"value"}');
    expect(stableStringify(payload)).toBe('{"__proto__":{"changed":true},"constructor":"value","name":"one"}');
    expect(stableStringify(payload)).not.toBe(stableStringify({ name: 'one', constructor: 'value' }));
    expect(Object.getPrototypeOf(JSON.parse(stableStringify(payload)))).toBe(Object.prototype);
  });

  it('sorts plain and null-prototype dictionaries consistently, including nested values', () => {
    const dictionary = Object.assign(Object.create(null), { z: 1, a: { second: 2, first: 1 } });
    expect(stableStringify(dictionary)).toBe(stableStringify({ a: { first: 1, second: 2 }, z: 1 }));
  });
});
