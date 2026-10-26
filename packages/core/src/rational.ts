export type Rational = { numerator: bigint; denominator: bigint };

export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) throw new RangeError("zero denominator");
  if (denominator < 0n) return rational(-numerator, -denominator);
  let a = numerator < 0n ? -numerator : numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}

export function parseRational(value: string, seconds = false): Rational {
  const match = (seconds ? /^(0|[1-9]\d*)(?:\/([1-9]\d*))?s$/ : /^(0|[1-9]\d*)(?:\/([1-9]\d*))?$/).exec(value);
  if (!match) throw new Error(`Invalid rational: ${value}`);
  const result = rational(BigInt(match[1]!), BigInt(match[2] ?? "1"));
  if (printRational(result, seconds) !== value) throw new Error(`Noncanonical rational: ${value}`);
  return result;
}

export function printRational(value: Rational, seconds = false): string {
  const reduced = rational(value.numerator, value.denominator);
  return `${reduced.numerator}${reduced.denominator === 1n ? "" : `/${reduced.denominator}`}${seconds ? "s" : ""}`;
}

export const add = (a: Rational, b: Rational) =>
  rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
export const sub = (a: Rational, b: Rational) =>
  rational(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
export const mul = (a: Rational, b: Rational) => rational(a.numerator * b.numerator, a.denominator * b.denominator);
export const div = (a: Rational, b: Rational) => rational(a.numerator * b.denominator, a.denominator * b.numerator);
export const compare = (a: Rational, b: Rational) => {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};
export const floor = (a: Rational) =>
  a.numerator >= 0n ? a.numerator / a.denominator : -((-a.numerator + a.denominator - 1n) / a.denominator);
export const ceil = (a: Rational) => -floor(rational(-a.numerator, a.denominator));
