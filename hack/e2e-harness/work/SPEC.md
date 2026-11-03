# Specification: math utilities (probe build task)

## Objective
Make `bun test` pass in this directory by fixing and extending `src/math.js` exactly as specified below. Do the work yourself with real file edits — do not only describe it.

## Requirements
1. **Fix `add(a, b)`** in `src/math.js`: it currently returns the difference; it must return the sum of its arguments.
2. **Fix `multiply(a, b)`** in `src/math.js`: it currently returns the sum; it must return the product of its arguments.
3. **Add `subtract(a, b)`** to `src/math.js`: returns the difference (first argument minus second argument).
4. **Add `divide(a, b)`** to `src/math.js`: returns the quotient (first argument divided by second argument). Must throw an Error with message "division by zero" when b is 0.
5. **Add `modulo(a, b)`** to `src/math.js`: returns the remainder of a divided by b. Must throw an Error with message "division by zero" when b is 0.
6. **Add `power(base, exp)`** to `src/math.js`: returns base raised to the power exp. Must handle negative exponents (return 1/power(base, -exp)).
7. **Add `clamp(value, min, max)`** to `src/math.js`: returns value clamped to the range [min, max]. If min > max, throw an Error with message "min exceeds max".
8. **Add tests** to `test/math.test.js` covering ALL seven functions for at least: positive numbers, negative numbers, zero, and the edge cases listed above (division by zero, negative exponents, clamp boundaries). Each function needs at least 3 test cases.
9. **Verification gate:** running `bun test` in this directory must exit 0 with every test passing.
10. **Scope wall:** do not modify any file other than `src/math.js` and `test/math.test.js`.
