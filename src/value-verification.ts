import { fingerprint } from './erasure-plan';

const INTEGER = /^-?(?:0|[1-9]\d*)$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const ISO_DATE_TIME = /^((?:[+-]\d{6}|\d{4})-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** Compare static policy values with the scalar types returned by Prisma. */
export function matchesReplacement(actual: unknown, expected: unknown): boolean {
  try {
    if (fingerprint(actual) === fingerprint(expected)) return true;
    if (actual instanceof Date && typeof expected === 'string') {
      const match = ISO_DATE_TIME.exec(expected);
      if (!match || (match[5] && /[1-9]/.test(match[5].slice(3)))) return false;
      // Date.parse normalizes impossible calendar dates such as February 30.
      const calendarDate = new Date(`${match[1]}T00:00:00.000Z`);
      if (!calendarDate.toISOString().startsWith(`${match[1]}T`)) return false;
      const timestamp = Date.parse(expected);
      return Number.isFinite(timestamp) && actual.getTime() === timestamp;
    }
    if (typeof actual === 'bigint') {
      if (typeof expected === 'number' && Number.isSafeInteger(expected)) {
        return actual === BigInt(expected);
      }
      return typeof expected === 'string' && INTEGER.test(expected) && actual === BigInt(expected);
    }
    if ((typeof expected !== 'number' || !Number.isFinite(expected)) &&
      (typeof expected !== 'string' || !DECIMAL.test(expected))) return false;
    if (typeof actual !== 'object' || actual === null) return false;
    const prototype: object | null = Object.getPrototypeOf(actual) as object | null;
    if (prototype === null || prototype === Object.prototype) return false;
    const decimal = actual as { constructor?: unknown; isFinite?: unknown; equals?: unknown; eq?: unknown };
    const constructor = decimal.constructor;
    if (typeof constructor !== 'function') return false;
    const isDecimal = (constructor as unknown as { isDecimal?: unknown }).isDecimal;
    const equals = decimal.equals ?? decimal.eq;
    if (typeof isDecimal !== 'function' || isDecimal.call(constructor, actual) !== true ||
      typeof decimal.isFinite !== 'function' || decimal.isFinite.call(actual) !== true ||
      typeof equals !== 'function') return false;
    // Decimal.js can underflow an extreme exponent to zero during comparison.
    if (typeof expected === 'string' && /[1-9]/.test(expected.split(/e/i)[0]) &&
      equals.call(actual, 0) === true) return false;
    return equals.call(actual, expected) === true;
  } catch {
    return false;
  }
}
