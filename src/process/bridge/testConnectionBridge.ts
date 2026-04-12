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

      // For TCP, attempt a basic socket connection test
      if (connectionType === 'tcp') {
        const net = await import('net')
        return new Promise((resolve) => {
          const socket = new net.Socket()
          socket.setTimeout(5000)

          socket.on('connect', () => {
            socket.destroy()
            resolve({
              success: true,
              message: `TCP connection to ${address}:${port} successful. Full Meshtastic protocol available in Phase 4.`
            })
          })

          socket.on('timeout', () => {
            socket.destroy()
            resolve({ success: false, message: `Connection to ${address}:${port} timed out` })
          })

          socket.on('error', (err) => {
            resolve({ success: false, message: `Connection failed: ${err.message}` })
          })

          socket.connect(port || 4403, address)
        })
      }

      return {
        success: true,
        message: `${connectionType.toUpperCase()} config validated. Full connection test available in Phase 4.`
      }
    } catch (err) {
      log.error('Meshtastic test failed:', err)
      return { success: false, message: String(err) }
    }
  })

  log.info('Test connection bridge registered')
}
