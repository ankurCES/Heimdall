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

      const tokenRegex = /^\d+:[A-Za-z0-9_-]+$/
      if (!tokenRegex.test(config.botToken)) {
        return { success: false, message: 'Invalid bot token format. Expected: 123456789:ABCdef...' }
      }

      log.info('Telegram test connection requested')

      // Step 1: Validate bot token via getMe
      const meResponse = await fetch(`https://api.telegram.org/bot${config.botToken}/getMe`, {
        signal: AbortSignal.timeout(10000)
      })
      const meData = await meResponse.json() as { ok: boolean; result?: { username: string }; description?: string }

      if (!meData.ok) {
        return { success: false, message: `Telegram API error: ${meData.description}` }
      }

      const botName = meData.result?.username || 'unknown'

      // Step 2: Send test message to each configured chat ID
      const chatIds = config.chatIds as string[] || []
      if (chatIds.length === 0) {
        return { success: true, message: `Bot @${botName} connected. Add chat IDs to send test messages.` }
      }

      const results: string[] = []
      for (const chatId of chatIds) {
        try {
          const msgResponse = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: `\u{1F6E1}\u{FE0F} *Heimdall Test Message*\n\nBot @${botName} is connected and working\\.\n_This is a test from Heimdall Intelligence Monitor\\._`,
              parse_mode: 'MarkdownV2'
            }),
            signal: AbortSignal.timeout(10000)
          })
          const msgData = await msgResponse.json() as { ok: boolean; description?: string }
          if (msgData.ok) {
            results.push(`\u2705 ${chatId}`)
          } else {
            results.push(`\u274C ${chatId}: ${msgData.description}`)
          }
        } catch (err) {
          results.push(`\u274C ${chatId}: ${err}`)
        }
      }

      const allOk = results.every((r) => r.startsWith('\u2705'))
      return {
        success: allOk,
        message: allOk
          ? `@${botName} \u2014 test message sent to ${chatIds.length} chat(s)`
          : `@${botName} \u2014 ${results.join(', ')}`
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
        // Step 1: Test TCP connection
        let addr = address
        if (!addr.startsWith('http')) addr = `http://${addr}`

        // Step 2: Try Meshtastic HTTP API — get node info
        try {
          const infoResp = await fetch(`${addr}/api/v1/fromradio?all=false`, {
            signal: AbortSignal.timeout(5000)
          })

          if (infoResp.ok) {
            // Step 3: Send test message via HTTP API
            const sendTestMessage = config.sendTestMessage !== false
            if (sendTestMessage) {
              try {
                const msgResp = await fetch(`${addr}/api/v1/sendtext`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    text: 'Heimdall test - mesh node connected',
                    channelIndex: config.channelIndex || 0
                  }),
                  signal: AbortSignal.timeout(5000)
                })
                if (msgResp.ok) {
                  return { success: true, message: `Connected to ${address} \u2014 test message sent on CH${config.channelIndex || 0}` }
                }
              } catch {}
              // sendtext might not be available on all firmware versions
              return { success: true, message: `Connected to ${address} (HTTP API responding)` }
            }
            return { success: true, message: `Connected to Meshtastic node at ${address}` }
          }
        } catch {}

        // Fallback: raw TCP socket test
        const net = await import('net')
        return new Promise((resolve) => {
          const socket = new net.Socket()
          socket.setTimeout(5000)
          socket.on('connect', () => {
            socket.destroy()
            resolve({ success: true, message: `TCP connection to ${address}:${port} successful (raw socket)` })
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
