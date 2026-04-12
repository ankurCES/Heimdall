import { ipcMain } from 'electron'
import { getDatabase } from '../services/database'
import { settingsService } from '../services/settings/SettingsService'
import { generateId, timestamp } from '@common/utils/id'
import type { MeshtasticConfig } from '@common/types/settings'
import log from 'electron-log'

export function registerMeshtasticBridge(): void {
  ipcMain.handle('meshtastic:getNodes', () => {
    const db = getDatabase()
    return db.prepare('SELECT * FROM meshtastic_nodes ORDER BY last_seen DESC').all()
  })

  ipcMain.handle('meshtastic:getNodeCount', () => {
    const db = getDatabase()
    const result = db.prepare('SELECT COUNT(*) as count FROM meshtastic_nodes').get() as { count: number }
    return result.count
  })

  ipcMain.handle('meshtastic:getMessages', (_event, params?: { limit?: number }) => {
    const db = getDatabase()
    const limit = params?.limit || 100
    return db.prepare(
      "SELECT * FROM intel_reports WHERE discipline = 'sigint' AND source_name LIKE 'Meshtastic%' ORDER BY created_at DESC LIMIT ?"
    ).all(limit)
  })

  ipcMain.handle('meshtastic:getRecommendedMode', () => {
    const db = getDatabase()
    const nodeCount = (db.prepare('SELECT COUNT(*) as count FROM meshtastic_nodes').get() as { count: number }).count
    const recentMessages = (db.prepare(
      "SELECT COUNT(*) as count FROM intel_reports WHERE discipline = 'sigint' AND source_name LIKE 'Meshtastic%' AND created_at > ?"
    ).get(Date.now() - 3600000) as { count: number }).count

    if (recentMessages > 50) return { mode: 'SHORT_FAST', reason: 'High message volume. Short range / fast mode reduces congestion.' }
    if (nodeCount > 10) return { mode: 'LONG_MODERATE', reason: 'Many nodes detected. Long range with moderate speed for coverage.' }
    if (recentMessages > 10) return { mode: 'MEDIUM_SLOW', reason: 'Moderate traffic. Medium range for reliability.' }
    return { mode: 'LONG_FAST', reason: 'Low traffic. Long range / fast mode for maximum SIGINT capture.' }
  })

  // Check if meshtastic CLI is installed
  ipcMain.handle('meshtastic:checkCli', async () => {
    const { exec } = await import('child_process')
    return new Promise((resolve) => {
      exec('meshtastic --version', { env: { ...process.env, PATH: `${process.env.HOME}/Library/Python/3.9/bin:${process.env.PATH}` } }, (err, stdout) => {
        if (err) {
          resolve({ installed: false, message: 'Meshtastic CLI not found. Install with: pip3 install --user meshtastic' })
        } else {
          resolve({ installed: true, version: stdout.trim() })
        }
      })
    })
  })

  // Pull node database using meshtastic CLI (most reliable method)
  ipcMain.handle('meshtastic:pullDeviceData', async () => {
    const config = settingsService.get<MeshtasticConfig>('meshtastic')
    if (!config?.serialPath && config?.connectionType === 'serial') {
      return { success: false, message: 'No serial port configured' }
    }

    const serialPath = config?.serialPath || ''

    try {
      const { exec } = await import('child_process')
      const db = getDatabase()
      const now = timestamp()
      const envPath = `${process.env.HOME}/Library/Python/3.9/bin:${process.env.PATH}`

      log.info(`Meshtastic: pulling node DB via CLI from ${serialPath}`)

      return new Promise((resolve) => {
        // Use meshtastic CLI --nodes to get all nodes in JSON-like format
        // Timeout after 120 seconds (device needs time to dump 139 nodes)
        const proc = exec(
          `meshtastic --port ${serialPath} --nodes`,
          { env: { ...process.env, PATH: envPath }, timeout: 120000 },
          (err, stdout, stderr) => {
            if (err && !stdout) {
              log.error('Meshtastic CLI failed:', err.message)
              resolve({ success: false, message: `CLI error: ${err.message}. Ensure meshtastic CLI is installed (pip3 install --user meshtastic)` })
              return
            }

            const output = stdout || ''
            log.info(`Meshtastic CLI: ${output.length} chars output`)

            // Parse the CLI table output — format:
            // ╔══════════╤═══════════╤════════════╤═════════╤═══════╤═══════════╗
            // ║ N  Num   │ User      │ AKA        │ Lat/Lon │ Batt  │ SNR       ║
            const nodeLines = output.split('\n').filter((line) =>
              line.includes('║') && !line.includes('Num') && !line.includes('═')
            )

            let stored = 0
            for (const line of nodeLines) {
              try {
                // Parse table columns separated by │
                const cols = line.split('│').map((c) => c.replace(/║/g, '').trim())
                if (cols.length < 4) continue

                const numAndId = cols[0].trim()
                const user = cols[1]?.trim() || ''
                const aka = cols[2]?.trim() || ''
                const latLon = cols[3]?.trim() || ''
                const batt = cols[4]?.trim() || ''
                const snr = cols[5]?.trim()?.replace('║', '') || ''

                // Extract node ID (hex number like !a1b2c3d4)
                const idMatch = numAndId.match(/!?([0-9a-f]{6,8})/i)
                const nodeId = idMatch ? `!${idMatch[1].toLowerCase()}` : `node_${stored}`

                // Parse lat/lon
                let lat: number | null = null
                let lon: number | null = null
                const geoMatch = latLon.match(/([-\d.]+)[,\s]+([-\d.]+)/)
                if (geoMatch) {
                  lat = parseFloat(geoMatch[1])
                  lon = parseFloat(geoMatch[2])
                }

                // Parse battery
                const battMatch = batt.match(/(\d+)/)
                const battLevel = battMatch ? parseInt(battMatch[1]) : null

                // Parse SNR
                const snrVal = parseFloat(snr) || null

                db.prepare(`
                  INSERT INTO meshtastic_nodes (node_id, long_name, short_name, latitude, longitude, battery_level, snr, first_seen, last_seen, seen_count)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                  ON CONFLICT(node_id) DO UPDATE SET
                    long_name = COALESCE(?, long_name),
                    short_name = COALESCE(?, short_name),
                    latitude = COALESCE(?, latitude),
                    longitude = COALESCE(?, longitude),
                    battery_level = COALESCE(?, battery_level),
                    snr = COALESCE(?, snr),
                    last_seen = ?,
                    seen_count = seen_count + 1
                `).run(
                  nodeId, user || null, aka || null, lat, lon, battLevel, snrVal, now, now,
                  user || null, aka || null, lat, lon, battLevel, snrVal, now
                )
                stored++
              } catch (parseErr) {
                log.debug(`Mesh node parse error: ${parseErr}`)
              }
            }

            // Also try JSON output if table parsing got nothing
            if (stored === 0) {
              // Try parsing as JSON (some CLI versions output JSON)
              try {
                const jsonMatch = output.match(/\{[\s\S]*\}/)
                if (jsonMatch) {
                  const data = JSON.parse(jsonMatch[0])
                  // Handle various JSON formats
                  const nodes = data.nodes || Object.values(data)
                  for (const node of (Array.isArray(nodes) ? nodes : [])) {
                    const nodeId = node.num ? `!${node.num.toString(16)}` : `node_${stored}`
                    db.prepare(`
                      INSERT INTO meshtastic_nodes (node_id, long_name, short_name, latitude, longitude, battery_level, snr, first_seen, last_seen, seen_count)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                      ON CONFLICT(node_id) DO UPDATE SET last_seen = ?, seen_count = seen_count + 1
                    `).run(
                      nodeId, node.user?.longName || null, node.user?.shortName || null,
                      node.position?.latitude || null, node.position?.longitude || null,
                      node.deviceMetrics?.batteryLevel || null, node.snr || null,
                      now, now, now
                    )
                    stored++
                  }
                }
              } catch {}
            }

            // Store as intel report
            db.prepare(
              'INSERT INTO intel_reports (id, discipline, title, content, severity, source_id, source_name, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(
              generateId(), 'sigint',
              `Meshtastic Node DB: ${stored} nodes from ${serialPath}`,
              `**Device**: ${serialPath}\n**Nodes Stored**: ${stored}\n**CLI Output Lines**: ${nodeLines.length}\n\n**Raw Output (first 2000 chars)**:\n\`\`\`\n${output.slice(0, 2000)}\n\`\`\``,
              stored > 0 ? 'low' : 'info', 'meshtastic-cli', 'Meshtastic CLI Dump',
              generateId(), 80, 0, now, now
            )

            log.info(`Meshtastic CLI: stored ${stored} nodes from ${serialPath}`)
            resolve({
              success: true,
              message: `${stored} nodes pulled from device via CLI.`,
              nodesFound: stored
            })
          }
        )

        // Handle process timeout
        proc.on('error', (err) => {
          resolve({ success: false, message: `CLI process error: ${err.message}` })
        })
      })
    } catch (err) {
      log.error('Meshtastic pull failed:', err)
      return { success: false, message: String(err) }
    }
  })

  log.info('Meshtastic bridge registered')
}
