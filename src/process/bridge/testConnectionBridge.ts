import { ipcMain } from 'electron'
import log from 'electron-log'

export function registerTestConnectionBridge(): void {
  ipcMain.handle('settings:testSmtp', async (_event, config) => {
    try {
      if (!config?.host || !config?.port) {
        return { success: false, message: 'Host and port are required' }
      }

      // Dynamic import to avoid loading nodemailer at startup
      // Will be implemented in Phase 6 when nodemailer is added
      // For now, validate the config structure
      const requiredFields = ['host', 'port', 'fromAddress']
      for (const field of requiredFields) {
        if (!config[field]) {
          return { success: false, message: `Missing required field: ${field}` }
        }
      }

      log.info('SMTP test connection requested', { host: config.host, port: config.port })
      return {
        success: true,
        message: `SMTP config validated (${config.host}:${config.port}). Live test available after Phase 6.`
      }
    } catch (err) {
      log.error('SMTP test failed:', err)
      return { success: false, message: String(err) }
    }
  })

  ipcMain.handle('settings:testTelegram', async (_event, config) => {
    try {
      if (!config?.botToken) {
        return { success: false, message: 'Bot token is required' }
      }

      // Validate token format: number:alphanumeric
      const tokenRegex = /^\d+:[A-Za-z0-9_-]+$/
      if (!tokenRegex.test(config.botToken)) {
        return { success: false, message: 'Invalid bot token format. Expected: 123456789:ABCdef...' }
      }

      log.info('Telegram test connection requested')

      // Quick API validation via getMe
      const response = await fetch(
        `https://api.telegram.org/bot${config.botToken}/getMe`
      )
      const data = await response.json()

      if (data.ok) {
        return {
          success: true,
          message: `Connected to bot: @${data.result.username}`
        }
      } else {
        return { success: false, message: `Telegram API error: ${data.description}` }
      }
    } catch (err) {
      log.error('Telegram test failed:', err)
      return { success: false, message: String(err) }
    }
  })

  ipcMain.handle('settings:testMeshtastic', async (_event, config) => {
    try {
      if (!config) {
        return { success: false, message: 'Configuration is required' }
      }

      const { connectionType, address, port, serialPath, mqttBroker } = config

      if (connectionType === 'tcp' && !address) {
        return { success: false, message: 'Node IP address is required for TCP connection' }
      }
      if (connectionType === 'serial' && !serialPath) {
        return { success: false, message: 'Serial port path is required for USB connection' }
      }
      if (connectionType === 'mqtt' && !mqttBroker) {
        return { success: false, message: 'MQTT broker URL is required' }
      }

      log.info('Meshtastic test connection requested', { connectionType })

      if (connectionType === 'tcp') {
        const net = await import('net')
        return new Promise((resolve) => {
          const socket = new net.Socket()
          socket.setTimeout(5000)
          socket.on('connect', () => {
            socket.destroy()
            resolve({ success: true, message: `TCP connection to ${address}:${port} successful` })
          })
          socket.on('timeout', () => { socket.destroy(); resolve({ success: false, message: `Connection to ${address}:${port} timed out` }) })
          socket.on('error', (err) => resolve({ success: false, message: `Connection failed: ${err.message}` }))
          socket.connect(port || 4403, address)
        })
      }

      if (connectionType === 'serial') {
        try {
          const { SerialPort } = await import('serialport')
          return new Promise((resolve) => {
            const sp = new SerialPort({ path: serialPath, baudRate: 115200, autoOpen: false })
            sp.open((err) => {
              if (err) {
                resolve({ success: false, message: `Serial open failed: ${err.message}` })
              } else {
                // Read initial data to confirm Meshtastic device
                let dataReceived = false
                sp.on('data', () => { dataReceived = true })
                setTimeout(() => {
                  sp.close()
                  resolve({
                    success: true,
                    message: `Serial port ${serialPath} opened successfully${dataReceived ? ' — device responding' : ' — connected (no data yet, device may need reset)'}`
                  })
                }, 2000)
              }
            })
          })
        } catch (err) {
          return { success: false, message: `Serial port error: ${err}` }
        }
      }

      if (connectionType === 'mqtt') {
        return { success: true, message: `MQTT config validated for ${mqttBroker}` }
      }

      return { success: false, message: 'Unknown connection type' }
    } catch (err) {
      log.error('Meshtastic test failed:', err)
      return { success: false, message: String(err) }
    }
  })

  // LLM connection test — generic OpenAI-compatible
  ipcMain.handle('settings:testLlm', async (_event, config) => {
    try {
      if (!config?.baseUrl) return { success: false, message: 'Base URL is required' }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`

      // Try /models endpoint first
      const response = await fetch(`${config.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(10000)
      })

      if (response.ok) {
        return { success: true, message: 'Connected successfully' }
      }

      // Some endpoints don't have /models — try a minimal chat completion
      const chatResponse = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model || config.customModel || 'test',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1
        }),
        signal: AbortSignal.timeout(10000)
      })

      if (chatResponse.ok || chatResponse.status === 400) {
        // 400 = model not found but endpoint works
        return { success: true, message: 'Connected (chat endpoint available)' }
      }

      return { success: false, message: `HTTP ${chatResponse.status}: ${chatResponse.statusText}` }
    } catch (err) {
      return { success: false, message: String(err) }
    }
  })

  // List available models from the LLM endpoint
  ipcMain.handle('settings:listLlmModels', async (_event, config) => {
    try {
      if (!config?.baseUrl) return []

      const headers: Record<string, string> = {}
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`

      const response = await fetch(`${config.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(10000)
      })

      if (!response.ok) return []

      const data = await response.json() as { data?: Array<{ id: string }> }
      if (!data.data || !Array.isArray(data.data)) return []

      return data.data
        .map((m) => m.id)
        .filter((id) => id && typeof id === 'string')
        .sort()
    } catch {
      return []
    }
  })

  // List serial ports for Meshtastic USB connection
  ipcMain.handle('settings:listSerialPorts', async () => {
    try {
      const { SerialPort } = await import('serialport')
      const ports = await SerialPort.list()
      return ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer || '',
        serialNumber: p.serialNumber || '',
        vendorId: p.vendorId || '',
        productId: p.productId || '',
        label: `${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ''}`
      }))
    } catch (err) {
      log.warn('Serial port listing failed:', err)
      return []
    }
  })

  log.info('Test connection bridge registered')
}
