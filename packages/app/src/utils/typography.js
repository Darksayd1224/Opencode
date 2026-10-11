/** Scale fixed typography in both the web and desktop Vite builds. */
export function typography() {
  return {
    postcssPlugin: "opencode-typography",
    Declaration(declaration) {
      // Include size tokens so component-local variables follow the same preference.
      if (
        declaration.prop !== "font-size" &&
        declaration.prop !== "line-height" &&
        !/^--(?:.*-)?font-size(?:-|$)/.test(declaration.prop)
      ) {
        return
      }

      // Relative sizes already inherit scaling; leave calc(), percentages and unitless heights intact.
      if (!/^(?:\d+\.?\d*|\.\d+)px$/.test(declaration.value) || parseFloat(declaration.value) === 0) {
        return
      }

      const scaled = `calc(${declaration.value} * var(--font-size-scale, 1))`
      // Keep the mobile input floor that prevents iOS from zooming focused fields.
      declaration.value =
        declaration.prop === "font-size" && declaration.important && declaration.value === "16px"
          ? `max(16px, ${scaled})`
          : scaled
    },
  }
}
