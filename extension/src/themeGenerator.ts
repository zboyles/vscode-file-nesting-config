import fs from 'node:fs'
import path from 'node:path'
import { extensions, window, workspace } from 'vscode'
import type { ExtensionContext } from 'vscode'

function stripJsonComments(json: string) {
  return json.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m)
}

export async function generateTheme(ctx: ExtensionContext, silent = false) {
  const output = window.createOutputChannel('File Nesting Icons')
  output.show(true)
  output.appendLine('Generating icon theme...')

  const config = workspace.getConfiguration()
  const currentThemeId = config.get<string>('workbench.iconTheme')
  
  let targetSourceId = currentThemeId

  // If we are already active, try to recover the original theme ID
  if (currentThemeId === 'antfu-file-nesting-icons') {
    const savedId = ctx.globalState.get<string>('lastSourceThemeId')
    if (savedId) {
      targetSourceId = savedId
      output.appendLine(`Currently using adapter. Re-using saved source theme ID: ${savedId}`)
    } else {
      output.appendLine('Currently using adapter but no saved source theme found.')
      if (!silent)
        window.showWarningMessage('Please switch to your desired Icon Theme first, then run this command again.')
      return
    }
  } else {
    // Save the current theme as the source for future regenerations
    if (currentThemeId) {
      ctx.globalState.update('lastSourceThemeId', currentThemeId)
      output.appendLine(`Saved source theme ID: ${currentThemeId}`)
    }
  }

  let sourceThemePath: string | undefined
  let sourceExtensionRoot: string | undefined

  for (const ext of extensions.all) {
    const iconThemes = ext.packageJSON?.contributes?.iconThemes
    if (!iconThemes)
      continue
    
    const theme = iconThemes.find((t: any) => t.id === targetSourceId)
    if (theme) {
      sourceExtensionRoot = ext.extensionPath
      sourceThemePath = path.join(ext.extensionPath, theme.path)
      output.appendLine(`Found source theme at: ${sourceThemePath}`)
      break
    }
  }

  let themeContent: any = {
    hidesExplorerArrows: true,
    iconDefinitions: {
      _file: { iconPath: "" },
      _folder: { iconPath: "" },
      _folder_open: { iconPath: "" }
    },
    file: "_file",
    folder: "_folder",
    folderExpanded: "_folder_open"
  }

  // Ensure dist directory exists
  const distDir = path.join(ctx.extensionPath, 'dist')
  if (!fs.existsSync(distDir))
    fs.mkdirSync(distDir, { recursive: true })

  const symlinkName = 'source-theme-linked'
  const symlinkPath = path.join(distDir, symlinkName)

  if (sourceThemePath && sourceExtensionRoot && fs.existsSync(sourceThemePath)) {
    try {
      // 1. Create Symlink to the source extension root
      // This allows us to use relative paths from our theme file to the source's files
      // without copying them or using absolute paths (which VS Code restricts).
      
      // Cleanup existing symlink
      if (fs.existsSync(symlinkPath)) {
        try {
          fs.unlinkSync(symlinkPath)
        } catch (e) {
          // ignore
        }
      }

      try {
        // 'junction' is safer on Windows (no admin rights), 'dir' or 'file' on others
        const type = process.platform === 'win32' ? 'junction' : 'dir'
        await fs.promises.symlink(sourceExtensionRoot, symlinkPath, type)
        output.appendLine(`Created symlink: ${symlinkPath} -> ${sourceExtensionRoot}`)
      } catch (e) {
        output.appendLine(`Failed to create symlink: ${e}`)
        throw new Error('Symlink creation failed. VS Code may restrict file access.')
      }

      // 2. Parse and Patch
      const content = await fs.promises.readFile(sourceThemePath, 'utf-8')
      const cleanContent = stripJsonComments(content)
      themeContent = JSON.parse(cleanContent)
      
      output.appendLine('Successfully parsed source theme.')

      // We need to calculate the path from the source extension root to the icon
      // sourceThemePath is /ext/src/themes/theme.json
      // iconPath might be ./icons/foo.svg -> /ext/src/themes/icons/foo.svg
      // We want to transform it to: ./source-theme-linked/src/themes/icons/foo.svg
      
      const patchPath = (p: string) => {
        if (!p) return p
        if (p.startsWith('data:') || p.startsWith('http')) return p
        
        // Resolve absolute path of the icon first
        let absIconPath = p
        if (!path.isAbsolute(p)) {
          absIconPath = path.resolve(path.dirname(sourceThemePath!), p)
        }

        // Relativize against the source extension root
        const relativeToRoot = path.relative(sourceExtensionRoot!, absIconPath)
        
        // Construct new path relative to dist/icon-theme.json
        // dist/icon-theme.json -> dist/source-theme-linked/{relativeToRoot}
        // So just ./source-theme-linked/{relativeToRoot}
        const newPath = `./${symlinkName}/${relativeToRoot.split(path.sep).join('/')}`
        
        return newPath
      }

      if (themeContent.iconDefinitions) {
        let patchedCount = 0
        for (const key of Object.keys(themeContent.iconDefinitions)) {
          const def = themeContent.iconDefinitions[key]
          if (def.iconPath) {
            const original = def.iconPath
            def.iconPath = patchPath(def.iconPath)
            if (patchedCount === 0) {
              output.appendLine(`Sample patch (icon): ${original} -> ${def.iconPath}`)
            }
            patchedCount++
          }
        }
        output.appendLine(`Patched ${patchedCount} icon paths using symlink strategy.`)
      }

      if (themeContent.fonts) {
        let patchedFonts = 0
        for (const font of themeContent.fonts) {
          if (font.src) {
            for (const src of font.src) {
              if (src.path) {
                const original = src.path
                src.path = patchPath(src.path)
                patchedFonts++
                if (patchedFonts === 1) {
                  output.appendLine(`Sample patch (font): ${original} -> ${src.path}`)
                }
              }
            }
          }
        }
        output.appendLine(`Patched ${patchedFonts} font paths.`)
      }
      
      themeContent.hidesExplorerArrows = true

    } catch (e) {
      output.appendLine(`Error parsing/patching source theme: ${e}`)
      console.error('Failed to parse source theme', e)
      if (!silent)
         window.showErrorMessage('Failed to adapt current icon theme. Falling back to default.')
    }
  } else {
    output.appendLine(`Source theme path not found for ID: ${targetSourceId}`)
    if (!silent)
      window.showErrorMessage(`Could not find the source theme "${targetSourceId}".`)
  }

  const destPath = path.join(distDir, 'icon-theme.json')
  await fs.promises.writeFile(destPath, JSON.stringify(themeContent, null, 2), 'utf-8')
  output.appendLine(`Wrote generated theme to: ${destPath}`)

  if (!silent) {
    if (currentThemeId !== 'antfu-file-nesting-icons') {
      const btn = 'Switch to File Nesting Theme'
      const result = await window.showInformationMessage(
        'Icon theme generated with hidden explorer arrows.',
        btn
      )
      if (result === btn) {
        config.update('workbench.iconTheme', 'antfu-file-nesting-icons', true)
      }
    } else {
       window.showInformationMessage('Icon theme regenerated successfully.')
    }
  }
}
