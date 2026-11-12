// V1's first POST /session triggers project bootstrap. Shared Windows runners
// have twice reached the generic 60s ceiling with the server still alive;
// give only this startup wait more tail room, without relaxing other polls.
export function v1SessionEndpointTimeoutMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? 120_000 : 60_000
}

export async function poll(
  description: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
): Promise<true> {
  const start = Date.now()
  let attempts = 0
  for (;;) {
    attempts += 1
    if (await condition()) return true
    const elapsedMs = Date.now() - start
    if (elapsedMs > timeoutMs) {
      throw new Error(
        `timed out waiting for: ${description} (platform=${process.platform}, elapsed_ms=${elapsedMs}, attempts=${attempts})`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
