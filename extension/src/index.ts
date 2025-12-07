import type { ExtensionContext } from 'vscode'
import { commands, workspace } from 'vscode'
import { getConfig } from './config'
import { fetchAndUpdate } from './fetch'
import { generateTheme } from './themeGenerator'

export async function activate(ctx: ExtensionContext) {
  commands.registerCommand('antfu.file-nesting.manualUpdate', () => fetchAndUpdate(ctx, false))
  commands.registerCommand('antfu.file-nesting.regenerateTheme', () => generateTheme(ctx))

  const lastUpdate = ctx.globalState.get('lastUpdate', 0)
  const initialized = ctx.globalState.get('init', false)
  const autoUpdateInterval = getConfig<number>('fileNestingUpdater.autoUpdateInterval')!

  if (!initialized) {
    ctx.globalState.update('init', true)
    fetchAndUpdate(ctx, false)
  }

  if (getConfig('fileNestingUpdater.autoUpdate')) {
    if (Date.now() - lastUpdate >= autoUpdateInterval * 60_000)
      fetchAndUpdate(ctx, getConfig('fileNestingUpdater.promptOnAutoUpdate'))
  }

  workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('explorer.fileNesting.hideExplorerArrows')) {
      if (getConfig('explorer.fileNesting.hideExplorerArrows'))
        generateTheme(ctx)
    }
  })
}

export function deactivate() {}
