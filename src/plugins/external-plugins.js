export const name = 'mini-external-plugins'

export async function apply(ctx, { entries = [] } = {}) {
  for (const entry of entries) {
    if (entry.enabled === false) continue
    try {
      const mod = await import(entry.package)
      await ctx.plugin(mod, entry.config ?? {})
      console.log(`[plugin] loaded ${entry.package}`)
    } catch (error) {
      console.error(`[plugin] failed ${entry.package}: ${error.message}`)
      if (entry.required) throw error
    }
  }
}
