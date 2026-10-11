import { describe, expect, test } from "bun:test"
import { typography } from "./utils/typography.js"

describe("font size scaling", () => {
  test("scales fixed text, pixel line boxes and component size tokens without scaling layout", () => {
    const declarations = [
      { prop: "font-size", value: "13px" },
      { prop: "line-height", value: "20px" },
      { prop: "--font-size-small", value: "13px" },
      { prop: "--avatar-font-size", value: "11px" },
      { prop: "width", value: "20px" },
      { prop: "padding", value: "4px" },
    ]
    declarations.forEach((declaration) => typography().Declaration(declaration))
    expect(declarations.map((declaration) => declaration.value)).toEqual([
      "calc(13px * var(--font-size-scale, 1))",
      "calc(20px * var(--font-size-scale, 1))",
      "calc(13px * var(--font-size-scale, 1))",
      "calc(11px * var(--font-size-scale, 1))",
      "20px",
      "4px",
    ])
  })

  test("does not scale relative or already scaled typography twice", () => {
    const declarations = [
      { prop: "font-size", value: "var(--font-size-base)" },
      { prop: "line-height", value: "1.5" },
      { prop: "font-size", value: "0.9em" },
      { prop: "line-height", value: "150%" },
      { prop: "font-size", value: "calc(13px * var(--font-size-scale, 1))" },
      { prop: "font-size", value: "0px" },
    ]
    const before = structuredClone(declarations)
    declarations.forEach((declaration) => typography().Declaration(declaration))
    expect(declarations).toEqual(before)
  })

  test("preserves the mobile input minimum", () => {
    const declaration = { prop: "font-size", value: "16px", important: true }
    typography().Declaration(declaration)
    expect(declaration.value).toBe("max(16px, calc(16px * var(--font-size-scale, 1)))")
  })
})
