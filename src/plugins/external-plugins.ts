import type { Context } from '@deepseek-ai/cordis'
export const name = 'mini-external-plugins'

export async function apply(ctx: Context, { entries = [] }: { entries?: { package: string; enabled?: boolean; required?: boolean; config?: Record<string, unknown> }[] } = {}) {
  for (const entry of entries) {
    if (entry.enabled === false) continue
    try {
      const mod = await import(entry.package)
      await ctx.plugin(mod, entry.config ?? {})
      console.log(`[plugin] loaded ${entry.package}`)
    } catch (error) {
      console.error(`[plugin] failed ${entry.package}: ${error instanceof Error ? error.message : String(error)}`)
      if (entry.required) throw error
    }
  }
}
