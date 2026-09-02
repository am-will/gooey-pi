// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu

export function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

export function sanitizedDetail(value: string): string {
  return [...value].filter((character) => !hasControlCharacter(character)).join('').trim().slice(0, 200)
}

export function lastNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1)
}

export function redactedStderrTail(stderr: string): string {
  const line = lastNonEmptyLine(stderr.replace(ANSI_ESCAPE, ''))
  if (!line) return ''
  const redacted = line
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|xox[a-z]|AKIA|Bearer\s+)[A-Za-z0-9_\-.]{8,}/gu, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/gu, '[redacted]')
  return sanitizedDetail(redacted)
}
