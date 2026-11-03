export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}

export function subtract(a, b) {
  return a - b;
}

export function divide(a, b) {
  if (b === 0) {
    throw new Error("division by zero");
  }
  return a / b;
}

export function modulo(a, b) {
  if (b === 0) {
    throw new Error("division by zero");
  }
  return a % b;
}

export function power(base, exp) {
  if (exp >= 0) {
    return Math.pow(base, exp);
  } else {
    return 1 / Math.pow(base, -exp);
  }
}

export function clamp(value, min, max) {
  if (min > max) {
    throw new Error("min exceeds max");
  }
  return Math.max(min, Math.min(value, max));
}