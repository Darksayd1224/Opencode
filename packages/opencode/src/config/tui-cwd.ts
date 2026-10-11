import { Context } from "effect"

export const CurrentWorkingDirectory = Context.Reference<string>("CurrentWorkingDirectory", {
  defaultValue: () => process.env.OPENCODE_WRAPPER_CWD ?? process.cwd(),
})
