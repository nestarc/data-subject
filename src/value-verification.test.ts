import { Decimal } from '@prisma/client/runtime/library';
import { matchesReplacement } from './value-verification';

describe('static replacement verification', () => {
  it.each([
    [null, null],
    ['removed', 'removed'],
    [0, 0],
    [new Date('2000-02-29T00:00:00.123Z'), '2000-02-29T00:00:00.123Z'],
    [new Date('2000-02-29T00:00:00.123Z'), '2000-02-29T09:00:00.123+09:00'],
    [new Date('2000-02-29T00:00:00.123Z'), '2000-02-29T00:00:00.123000Z'],
    [0n, 0],
    [9007199254740993n, '9007199254740993'],
    [-9007199254740993n, '-9007199254740993'],
    [new Decimal('0'), 0],
    [new Decimal('1.2300'), '1.23'],
    [new Decimal('9007199254740993.123456789'), '9007199254740993.123456789'],
    [new Decimal('0.000001'), '1e-6'],
  ])('accepts the exact stored scalar %#', (actual, expected) => {
    expect(matchesReplacement(actual, expected)).toBe(true);
  });

  it.each([
    [0, '0'],
    ['0', 0],
    [null, 0],
    [undefined, null],
    [new Date('2000-02-29T00:00:00.124Z'), '2000-02-29T00:00:00.123Z'],
    [new Date('2000-02-29T00:00:00.123Z'), '2000-02-29T00:00:00.1234Z'],
    [new Date('2001-03-01T00:00:00.000Z'), '2001-02-29T00:00:00.000Z'],
    [new Date('2000-02-29T00:00:00.000Z'), '2000-02-29'],
    [new Date('invalid'), '2000-02-29T00:00:00.000Z'],
    [1n, '01'],
    [1n, '1.0'],
    [1n, ' 1'],
    [1n, '1e0'],
    [9007199254740992n, 9007199254740992],
    [9007199254740992n, '9007199254740993'],
    [new Decimal('9007199254740993.123456788'), '9007199254740993.123456789'],
    [new Decimal('9007199254740993'), 9007199254740992],
    [new Decimal('1'), '0x1'],
    [new Decimal('1'), ' 1'],
    [new Decimal('Infinity'), 'Infinity'],
    [new Decimal('Infinity'), Number.POSITIVE_INFINITY],
    [new Decimal('NaN'), 'NaN'],
    [new Decimal('0'), '1e-9000000000000001'],
    [{ toJSON: () => '0' }, '0'],
    [{ constructor: { isDecimal: () => true }, toJSON: () => '0', equals: () => true }, '0'],
  ])('rejects a different value or unsafe coercion %#', (actual, expected) => {
    expect(matchesReplacement(actual, expected)).toBe(false);
  });
});
