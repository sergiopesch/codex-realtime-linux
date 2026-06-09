require('dotenv/config')

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

app.setName('Codex')
if (process.platform === 'linux') {
  app.setDesktopName('codex-realtime-linux.desktop')
  app.commandLine.appendSwitch('enable-transparent-visuals')
  app.disableHardwareAcceleration()
}

const defaultApiPort = 3311
const configuredPort = (value, fallback = defaultApiPort) => {
  const port = Number(value ?? fallback)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback
}
const localAppHostnames = new Set(['localhost', '127.0.0.1', '[::1]'])
const configuredLocalHttpOrigin = (value, fallback) => {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    const parsed = new URL(value)
    const rootPath = parsed.pathname === '/' && !parsed.search && !parsed.hash
    const localHttp = parsed.protocol === 'http:' && localAppHostnames.has(parsed.hostname)
    if (!localHttp || !rootPath || parsed.username || parsed.password) return fallback
    return parsed.origin
  } catch {
    return fallback
  }
}
const apiPort = configuredPort(process.env.PORT)
const apiUrl = configuredLocalHttpOrigin(process.env.CODEX_DESKTOP_API_URL, `http://127.0.0.1:${apiPort}`)
const devServerUrl = configuredLocalHttpOrigin(process.env.VITE_DEV_SERVER_URL, '')
const apiNodeBin = process.env.CODEX_REALTIME_NODE_BIN || process.execPath
const apiNodeUsesElectronRuntime = !process.env.CODEX_REALTIME_NODE_BIN
const repoRoot = path.join(__dirname, '..')
const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'codex-realtime-linux')
const apiLogPath = path.join(stateDir, 'api-server.log')
const maxLogBytes = 1024 * 1024
const maxElectronErrorDetailLength = 500
const maxApiProbeBytes = 64 * 1024
let apiProcess = null
let apiLogFd = null

const openExternalIfAllowed = (url) => {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return
    shell.openExternal(url)
  } catch {
    // Ignore invalid external URLs from renderer content.
  }
}

const boundedErrorDetail = (error, fallback = 'Unexpected desktop startup error.') => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
  return message.length > maxElectronErrorDetailLength
    ? `${message.slice(0, maxElectronErrorDetailLength - 3)}...`
    : message
}

const readJson = (url) =>
  new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (Buffer.byteLength(body, 'utf8') > maxApiProbeBytes) {
          request.destroy(new Error(`Server response was too large for ${url}`))
        }
      })
      response.on('end', () => {
        if (!response.statusCode || response.statusCode >= 500) {
          reject(new Error(`Server returned ${response.statusCode || 'no status'} for ${url}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch {
          reject(new Error(`Server response was not JSON for ${url}`))
        }
      })
    })
    request.on('error', reject)
    request.setTimeout(1000, () => {
      request.destroy(new Error(`Timed out requesting ${url}`))
    })
  })

const waitForAppServer = (baseUrl, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs

    const attempt = async () => {
      try {
        const status = await readJson(`${baseUrl}/api/status`)
        if (path.resolve(status?.appRoot || '') === path.resolve(repoRoot)) {
          resolve(status)
          return
        }
        reject(new Error(`Refusing to load unrelated local server at ${baseUrl}`))
        return
      } catch {
        retry()
      }
    }

    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${baseUrl}`))
        return
      }
      setTimeout(attempt, 250)
    }

    attempt()
  })

const createApiLogFd = () => {
  try {
    mkdirSync(stateDir, { recursive: true })
    rotateLogFile(apiLogPath)
    const fd = openSync(apiLogPath, 'a')
    writeSync(fd, `\n[${new Date().toISOString()}] Starting API server from Electron with ${apiNodeBin}\n`)
    return fd
  } catch {
    return 'ignore'
  }
}

const rotateLogFile = (logPath) => {
  try {
    if (statSync(logPath).size <= maxLogBytes) return
    renameSync(logPath, `${logPath}.1`)
  } catch {
    // Missing or unrotatable logs must not block app startup.
  }
}

const writeApiLog = (message) => {
  if (apiLogFd == null || apiLogFd === 'ignore') return
  try {
    writeSync(apiLogFd, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // Logging must not interfere with desktop shutdown.
  }
}

const closeApiLog = () => {
  if (apiLogFd == null || apiLogFd === 'ignore') return
  try {
    closeSync(apiLogFd)
  } catch {
    // Ignore log close failures during app shutdown.
  } finally {
    apiLogFd = null
  }
}

const ensureApiServer = async () => {
  if (devServerUrl) return devServerUrl

  try {
    await waitForAppServer(apiUrl, 750)
    return apiUrl
  } catch {
    apiLogFd = createApiLogFd()
    const apiEnv = {
      ...process.env,
      PORT: String(apiPort),
      NODE_ENV: process.env.NODE_ENV || 'production',
      ...(apiNodeUsesElectronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    }
    apiProcess = spawn(apiNodeBin, ['server/index.mjs'], {
      cwd: repoRoot,
      env: apiEnv,
      stdio: ['ignore', apiLogFd, apiLogFd],
    })
    apiProcess.once('error', (error) => {
      writeApiLog(`API server failed to start: ${boundedErrorDetail(error)}`)
      closeApiLog()
    })
    apiProcess.once('exit', (code, signal) => {
      writeApiLog(`API server exited with ${signal ? `signal ${signal}` : `code ${code}`}`)
      closeApiLog()
    })
    apiProcess.unref()
    await waitForAppServer(apiUrl)
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
    openExternalIfAllowed(url)
    return { action: 'deny' }
  })

  try {
    const appUrl = await ensureApiServer()
    const appOrigin = new URL(appUrl).origin
    win.webContents.on('will-navigate', (event, url) => {
      try {
        if (new URL(url).origin === appOrigin) return
      } catch {
        // Invalid navigations are blocked below.
      }
      event.preventDefault()
      openExternalIfAllowed(url)
    })
    await win.loadURL(appUrl)
  } catch (error) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Codex failed to start',
      message: 'Codex could not start the local desktop server.',
      detail: boundedErrorDetail(error),
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
