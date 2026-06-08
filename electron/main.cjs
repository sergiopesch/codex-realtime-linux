const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')

app.setName('Codex')
if (process.platform === 'linux') {
  app.setDesktopName('codex-realtime-linux.desktop')
  app.commandLine.appendSwitch('enable-transparent-visuals')
  app.disableHardwareAcceleration()
}

const apiPort = Number(process.env.PORT || 3311)
const apiUrl = process.env.CODEX_DESKTOP_API_URL || `http://127.0.0.1:${apiPort}`
let apiProcess = null

const waitForHttp = (url, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs

    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume()
        if (response.statusCode && response.statusCode < 500) {
          resolve()
          return
        }
        retry()
      })

      request.on('error', retry)
      request.setTimeout(1000, () => {
        request.destroy()
        retry()
      })
    }

    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${url}`))
        return
      }
      setTimeout(attempt, 250)
    }

    attempt()
  })

const ensureApiServer = async () => {
  if (process.env.VITE_DEV_SERVER_URL) return process.env.VITE_DEV_SERVER_URL

  try {
    await waitForHttp(`${apiUrl}/api/status`, 750)
    return apiUrl
  } catch {
    apiProcess = spawn('node', ['server/index.mjs'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(apiPort), NODE_ENV: process.env.NODE_ENV || 'production' },
      stdio: 'ignore',
    })
    apiProcess.unref()
    await waitForHttp(`${apiUrl}/api/status`)
    return apiUrl
  }
}

const createWindow = async () => {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#00000000',
    title: 'Codex',
    icon: path.join(__dirname, '..', 'public', 'codex-app-icon.png'),
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
    transparent: true,
    hasShadow: false,
    resizable: true,
    movable: true,
    maximizable: true,
    minimizable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
    },
  })
  win.setBackgroundColor('#00000000')

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  try {
    const appUrl = await ensureApiServer()
    await win.loadURL(appUrl)
  } catch (error) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Codex failed to start',
      message: 'Codex could not start the local desktop server.',
      detail: error instanceof Error ? error.message : String(error),
    })
    app.quit()
  }
}

app.whenReady().then(() => {
  ipcMain.on('window-control', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (action === 'minimize') win.minimize()
    if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    }
    if (action === 'close') win.close()
  })

  ipcMain.handle('select-workspace-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? undefined, {
      properties: ['openDirectory'],
      title: 'Add workspace',
    })
    if (result.canceled || !result.filePaths[0]) return null
    const folderPath = result.filePaths[0]
    return {
      name: path.basename(folderPath),
      path: folderPath,
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (apiProcess && !apiProcess.killed) apiProcess.kill()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
