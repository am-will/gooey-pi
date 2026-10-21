/**
 * Pi and Prime print a bare semver for --version (`1.3.0`, `0.7.0-gooeypi.1`)
 * while OMP prefixes its command name (`omp/18.12.3`). The version is the last
 * whitespace-separated token with an optional `<name>/` and `v` prefix
 * removed, and only a token that then starts with a digit counts.
 */
const VERSION_TOKEN = /^(?:[A-Za-z][\w-]*\/)?v?([0-9][0-9A-Za-z.+-]{0,63})$/

/** The bare version in a harness CLI's --version output, or null when it printed none. */
export function harnessVersion(output: string): string | null {
  const token = output.trim().split(/\s+/).at(-1) ?? ''
  return VERSION_TOKEN.exec(token)?.[1] ?? null
}
