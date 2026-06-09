require('dotenv/config')

const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

app.setName('Codex')
if (process.platform === 'linux') {
  app.setDesktopName('codex-realtime-linux.desktop')
  app.commandLine.appendSwitch('enable-transparent-visuals')
  app.commandLine.appendSwitch('disable-gpu')
  app.disableHardwareAcceleration()
}
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

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
const configuredAbsoluteDir = (value, fallback) => {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return path.isAbsolute(candidate) ? path.resolve(candidate) : fallback
}
const configuredAbsolutePath = (value, fallback) => {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return path.isAbsolute(candidate) ? path.resolve(candidate) : fallback
}
const apiPort = configuredPort(process.env.PORT)
const apiUrl = configuredLocalHttpOrigin(process.env.CODEX_DESKTOP_API_URL, `http://127.0.0.1:${apiPort}`)
const devServerUrl = configuredLocalHttpOrigin(process.env.VITE_DEV_SERVER_URL, '')
const trustedRendererOrigins = new Set([
  new URL(apiUrl).origin,
  ...(devServerUrl ? [new URL(devServerUrl).origin] : []),
])
const desktopAllowedPermissions = new Set(['media', 'display-capture'])
const apiNodeBin = configuredAbsolutePath(process.env.CODEX_REALTIME_NODE_BIN, process.execPath)
const apiNodeUsesElectronRuntime = apiNodeBin === process.execPath
const desktopServerToken = randomUUID()
const repoRoot = path.join(__dirname, '..')
const stateHome = configuredAbsoluteDir(process.env.XDG_STATE_HOME, path.join(os.homedir(), '.local', 'state'))
const stateDir = path.join(stateHome, 'codex-realtime-linux')
const apiLogPath = path.join(stateDir, 'api-server.log')
const maxLogBytes = 1024 * 1024
const maxElectronErrorDetailLength = 500
const maxApiLogErrorTailLength = 2000
const maxApiProbeBytes = 64 * 1024
const staleDesktopServerShutdownGraceMs = 2000
let apiProcess = null
let apiLogFd = null

const openExternalIfAllowed = (url) => {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return
    if (trustedRendererOrigins.has(parsed.origin)) return
    void shell.openExternal(url).catch(() => {})
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

const recentApiLogTail = () => {
  try {
    const text = readFileSync(apiLogPath, 'utf8')
    return text.slice(-maxApiLogErrorTailLength).trim()
  } catch {
    return ''
  }
}

const startupErrorDetail = (error) => {
  const detail = boundedErrorDetail(error)
  const logTail = recentApiLogTail()
  return logTail ? `${detail}\n\nRecent API server log:\n${logTail}` : detail
}

const refusingToLoadError = (message) => {
  const error = new Error(message)
  error.code = 'refusing_to_load'
  return error
}

const staleDesktopServerError = (message, pid) => {
  const error = refusingToLoadError(message)
  error.code = 'stale_desktop_server'
  error.pid = pid
  return error
}

const isRefusingToLoadError = (error) =>
  error instanceof Error && (error.code === 'refusing_to_load' || error.code === 'stale_desktop_server')

const isStaleDesktopServerError = (error) =>
  error instanceof Error && error.code === 'stale_desktop_server' && Number.isInteger(error.pid) && error.pid > 0

const processIsRunning = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForProcessExit = async (pid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true
    await sleep(100)
  }
  return !processIsRunning(pid)
}

const terminateStaleDesktopServer = async (error) => {
  if (!isStaleDesktopServerError(error) || error.pid === process.pid) return false
  if (!processIsRunning(error.pid)) return true
  try {
    process.kill(error.pid, 'SIGTERM')
  } catch {
    return !processIsRunning(error.pid)
  }
  if (await waitForProcessExit(error.pid, staleDesktopServerShutdownGraceMs)) return true
  try {
    process.kill(error.pid, 'SIGKILL')
  } catch {
    return !processIsRunning(error.pid)
  }
  return waitForProcessExit(error.pid, 500)
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
        if (response.statusCode !== 200) {
          reject(refusingToLoadError(`Refusing to load non-Codex local server at ${url}: HTTP ${response.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch {
          reject(refusingToLoadError(`Refusing to load non-Codex local server at ${url}: response was not JSON`))
        }
      })
    })
    request.on('error', reject)
    request.setTimeout(1000, () => {
      request.destroy(new Error(`Timed out requesting ${url}`))
    })
  })

const waitForAppServer = (baseUrl, timeoutMs = 15000, expectedDesktopServerToken = '') =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs

    const attempt = async () => {
      try {
        const status = await readJson(`${baseUrl}/api/status`)
        if (path.resolve(status?.appRoot || '') !== path.resolve(repoRoot)) {
          reject(refusingToLoadError(`Refusing to load unrelated local server at ${baseUrl}`))
          return
        }
        if (expectedDesktopServerToken) {
          const serverToken = status?.desktopServer?.token
          if (serverToken !== expectedDesktopServerToken) {
            const serverPid = status?.desktopServer?.pid
            const staleMessage = `Refusing to load stale local server at ${baseUrl}. Stop the existing Codex desktop server and relaunch.`
            reject(
              serverToken && Number.isInteger(serverPid) && serverPid > 0
                ? staleDesktopServerError(staleMessage, serverPid)
                : refusingToLoadError(staleMessage),
            )
            return
          }
        }
        resolve(status)
        return
      } catch (error) {
        if (isRefusingToLoadError(error)) {
          reject(error)
          return
        }
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
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    chmodSync(stateDir, 0o700)
    rotateLogFile(apiLogPath)
    const fd = openSync(apiLogPath, 'a', 0o600)
    chmodSync(apiLogPath, 0o600)
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
    chmodSync(`${logPath}.1`, 0o600)
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

const isTrustedRendererEvent = (event) => {
  try {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || frame.top !== frame || frame.parent !== null) return false
    const frameUrl = frame.url
    if (typeof frameUrl !== 'string' || !frameUrl) return false
    return trustedRendererOrigins.has(new URL(frameUrl).origin)
  } catch {
    return false
  }
}

const trustedOriginFrom = (value) => {
  if (typeof value !== 'string' || !value) return ''
  try {
    const origin = new URL(value).origin
    return trustedRendererOrigins.has(origin) ? origin : ''
  } catch {
    return ''
  }
}

const isTrustedMainFramePermission = (webContents, origin, details) => {
  try {
    if (!webContents || !details?.isMainFrame || !trustedOriginFrom(origin)) return false
    const requestUrl = details.requestingUrl
    if (requestUrl && !trustedOriginFrom(requestUrl)) return false
    const securityOrigin = details.securityOrigin
    if (securityOrigin && !trustedOriginFrom(securityOrigin)) return false
    return Boolean(trustedOriginFrom(webContents.mainFrame?.url))
  } catch {
    return false
  }
}

const permissionRequestOrigin = (details) => details?.securityOrigin || details?.requestingUrl || ''

const installPermissionHandlers = () => {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!desktopAllowedPermissions.has(permission)) return false
    return isTrustedMainFramePermission(webContents, requestingOrigin, details)
  })

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!desktopAllowedPermissions.has(permission)) {
      callback(false)
      return
    }
    callback(isTrustedMainFramePermission(webContents, permissionRequestOrigin(details), details))
  })
}

const isAppShellNavigation = (url, appOrigin) => {
  try {
    const parsed = new URL(url)
    return parsed.origin === appOrigin && ['/', '/index.html'].includes(parsed.pathname) && !parsed.search
  } catch {
    return false
  }
}

const ensureApiServer = async () => {
  if (devServerUrl) return devServerUrl

  try {
    await waitForAppServer(apiUrl, 750, desktopServerToken)
    return apiUrl
  } catch (error) {
    if (isStaleDesktopServerError(error)) {
      writeApiLog(`Stopping stale Electron-managed API server ${error.pid}`)
      if (!(await terminateStaleDesktopServer(error))) throw error
    } else if (isRefusingToLoadError(error)) {
      throw error
    }
    apiLogFd = createApiLogFd()
    const apiEnv = {
      ...process.env,
      PORT: String(apiPort),
      NODE_ENV: process.env.NODE_ENV || 'production',
      CODEX_DESKTOP_SERVER_TOKEN: desktopServerToken,
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
    await waitForAppServer(apiUrl, 15000, desktopServerToken)
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
      let sameAppOrigin = false
      try {
        sameAppOrigin = new URL(url).origin === appOrigin
        if (isAppShellNavigation(url, appOrigin)) return
      } catch {
        // Invalid navigations are blocked below.
      }
      event.preventDefault()
      if (!sameAppOrigin) openExternalIfAllowed(url)
    })
    await win.loadURL(appUrl)
  } catch (error) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Codex failed to start',
      message: 'Codex could not start the local desktop server.',
      detail: startupErrorDetail(error),
    })
    app.quit()
  }
}

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

if (gotSingleInstanceLock) app.whenReady().then(() => {
  installPermissionHandlers()

  ipcMain.on('window-control', (event, action) => {
    if (!isTrustedRendererEvent(event)) return
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
    if (!isTrustedRendererEvent(event)) return null
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
