import { test, expect } from "bun:test"
import { add } from "../src/math.js"

test("add returns sum of two positive numbers", () => {
  expect(add(2, 3)).toBe(5)
})

test("add handles negative numbers", () => {
  expect(add(-1, -1)).toBe(-2)
})
