// Fixed-point decimal math on BigInt. No dependencies.
// A value is a BigInt that holds the number times 10^SCALE_DIGITS.

const SCALE_DIGITS = 24;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const DECIMAL = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

// Parse a daemon amount (a JSON number or a decimal string).
// Return null for anything that is not a finite, non-negative decimal.
export function parse(value) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = String(value); // Shortest round-trip form, the same digits the daemon sent.
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return null;
  }
  const match = DECIMAL.exec(text);
  if (!match) return null;
  const [, whole, fraction = '', exponentText = '0'] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  const digits = BigInt(whole + fraction);
  const shift = SCALE_DIGITS + exponent - fraction.length;
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}

// Return the value if it is greater than zero, else null.
export function positive(value) {
  const parsed = parse(value);
  return parsed !== null && parsed > 0n ? parsed : null;
}

export const ONE = SCALE;

export function mul(a, b) {
  return (a * b) / SCALE;
}

export function div(a, b) {
  return (a * SCALE) / b;
}

// Format with at most `significant` significant digits, rounded half up.
// Plain decimal notation, no exponent, no trailing zeros.
export function format(value, significant = 12) {
  let v = value;
  const length = v.toString().length;
  if (length > significant) {
    const unit = 10n ** BigInt(length - significant);
    v = ((v + unit / 2n) / unit) * unit;
  }
  const whole = v / SCALE;
  const fraction = (v % SCALE).toString().padStart(SCALE_DIGITS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
