import { expect, test } from "bun:test"
import { wait, withPrompt, type PromptRig } from "../fixture/prompt-app"

const UNDO = "\x1b[45;5u"
const ESCAPE = "\x1b"

// Where the frame shows `label`, as the cell to click inside it.
function find(rig: PromptRig, label: string) {
  const lines = rig.frame().split("\n")
  const y = lines.findIndex((line) => line.includes(label))
  if (y === -1) throw new Error(`"${label}" is not on screen:\n${rig.frame()}`)
  return { x: lines[y].indexOf(label) + 2, y }
}

async function pasteBlock(rig: PromptRig) {
  for (const char of "see ") await rig.press(char)
  await rig.press("\x1b[200~one\ntwo\nthree\x1b[201~")
  expect(rig.text()).toBe("see [Pasted ~3 lines] ")
}

// A lone escape byte is held briefly in case more of a sequence follows.
async function close(rig: PromptRig) {
  await rig.press(ESCAPE)
  await wait(() => !rig.frame().includes("Pasted text"))
}

async function openPlaceholder(rig: PromptRig) {
  const at = find(rig, "[Pasted ~3 lines]")
  await rig.click(at.x, at.y)
  find(rig, "Pasted text")
}

// What the prompt sends, which is the pasted text the placeholder stands for.
async function submitted(rig: PromptRig) {
  await rig.press("\r")
  await wait(() => rig.sent.length > 0)
  return JSON.parse(rig.sent[0]).parts.find((part: { type: string }) => part.type === "text").text
}

test("clicking a placeholder opens its text to edit, and escape keeps the edit", async () => {
  await withPrompt(async (rig) => {
    await pasteBlock(rig)
    await openPlaceholder(rig)
    for (const char of "zero") await rig.press(char)
    await rig.press("\r") // a new line in the editor, not a submit
    await close(rig)
    expect(rig.text()).toBe("see [Pasted ~4 lines] ")
    expect(rig.sent).toEqual([])
    expect(await submitted(rig)).toBe("see zero\none\ntwo\nthree ")
  })
})

test("an edit that keeps the line count keeps the label and changes the text", async () => {
  await withPrompt(async (rig) => {
    await pasteBlock(rig)
    await openPlaceholder(rig)
    await rig.press("X")
    await close(rig)
    expect(rig.text()).toBe("see [Pasted ~3 lines] ")
    expect(await submitted(rig)).toBe("see Xone\ntwo\nthree ")
  })
})

test("Inline replaces the placeholder with its text, and undo puts the placeholder back", async () => {
  await withPrompt(async (rig) => {
    await pasteBlock(rig)
    await openPlaceholder(rig)
    const button = find(rig, "Inline")
    await rig.click(button.x, button.y)
    expect(rig.frame()).not.toContain("Pasted text")
    expect(rig.text()).toBe("see one\ntwo\nthree ")
    expect(rig.parts()).toBe(0)
    await rig.press(UNDO)
    expect(rig.text()).toBe("see [Pasted ~3 lines] ")
    expect(rig.parts()).toBe(1)
    expect(await submitted(rig)).toBe("see one\ntwo\nthree ")
  })
})

test("undo takes back an edit made in the dialog", async () => {
  await withPrompt(async (rig) => {
    await pasteBlock(rig)
    await openPlaceholder(rig)
    await rig.press("X")
    await close(rig)
    await rig.press(UNDO)
    expect(rig.text()).toBe("see [Pasted ~3 lines] ")
    expect(await submitted(rig)).toBe("see one\ntwo\nthree ")
  })
})
