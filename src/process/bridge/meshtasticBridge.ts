import { ipcMain } from 'electron'
import { getDatabase } from '../services/database'
import { settingsService } from '../services/settings/SettingsService'
import { generateId, timestamp } from '@common/utils/id'
import type { MeshtasticConfig } from '@common/types/settings'
import log from 'electron-log'

// Pull nodes via Meshtastic HTTP API
async function pullViaHttp(baseUrl: string): Promise<{ success: boolean; message: string; nodesFound?: number }> {
  try {
    const url = baseUrl.replace(/\/+$/, '')
    log.info(`Meshtastic HTTP: trying ${url}`)

    // The Meshtastic HTTP API streams protobuf FromRadio packets
    // First, send a ToRadio with want_config_id to request full config dump
    await fetch(`${url}/api/v1/toradio`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: Buffer.from([0x08, 0x01]), // want_config_id = 1
      signal: AbortSignal.timeout(5000)
    }).catch(() => {})

    // Wait for device to prepare the dump
    await new Promise((r) => setTimeout(r, 2000))

    // Read all available FromRadio packets (contains NodeInfo, Position, etc.)
    const allData: Buffer[] = []
    let hasMore = true
    let iterations = 0

    while (hasMore && iterations < 200) {
      try {
        const response = await fetch(`${url}/api/v1/fromradio`, {
          headers: { Accept: 'application/x-protobuf' },
          signal: AbortSignal.timeout(5000)
        })

        if (response.status === 204 || !response.ok) {
          hasMore = false
          break
        }

        const data = Buffer.from(await response.arrayBuffer())
        if (data.length === 0) {
          hasMore = false
          break
        }

        allData.push(data)
        iterations++
      } catch {
        hasMore = false
      }
    }

    if (allData.length === 0) {
      return { success: false, message: 'No data from HTTP API. Device may need WiFi enabled.' }
    }

    log.info(`Meshtastic HTTP: received ${allData.length} packets, ${allData.reduce((s, d) => s + d.length, 0)} total bytes`)

    // Parse protobuf packets for node info
    // FromRadio contains nodeInfo with user (longName, shortName, macaddr, id) and position
    const db = getDatabase()
    const now = timestamp()
    let nodesStored = 0

    for (const packet of allData) {
      // Extract readable strings from protobuf — node names, IDs
      const text = packet.toString('utf-8').replace(/[^\x20-\x7E]/g, ' ').trim()
      const names = text.match(/[A-Za-z][A-Za-z0-9 _.-]{2,24}/g) || []

      // Extract node IDs (4-byte hex patterns)
      const hex = packet.toString('hex')
      const nodeIdMatches = hex.match(/([0-9a-f]{8})/gi) || []

      // Look for lat/lon patterns in protobuf (field tags for position)
      // Position fields: latitude_i (field 1, sint32), longitude_i (field 2, sint32)
      let lat: number | null = null
      let lon: number | null = null

      // Simple protobuf int32 extraction for known field patterns
      for (let i = 0; i < packet.length - 5; i++) {
        // Latitude field tag (0x08 = field 1, varint) followed by large value
        if (packet[i] === 0x0d && i + 4 < packet.length) {
          // Fixed32 (little-endian)
          const val = packet.readInt32LE(i + 1)
          if (Math.abs(val) > 1000000 && Math.abs(val) < 900000000) {
            if (!lat) lat = val / 10000000
            else if (!lon) lon = val / 10000000
          }
        }
      }

      // Store first meaningful name found per packet
      const validNames = names.filter((n) =>
        !['DEBUG', 'INFO', 'WARN', 'ERROR', 'config', 'radio', 'module', 'channel', 'position'].some((skip) => n.toLowerCase().includes(skip.toLowerCase()))
      )

      if (validNames.length > 0 || nodeIdMatches.length > 0) {
        const nodeId = nodeIdMatches.length > 0 ? `!${nodeIdMatches[0].toLowerCase()}` : `http_${nodesStored}`
        const nodeName = validNames[0] || null

        try {
          db.prepare(`
            INSERT INTO meshtastic_nodes (node_id, long_name, latitude, longitude, first_seen, last_seen, seen_count)
            VALUES (?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(node_id) DO UPDATE SET
              long_name = COALESCE(?, long_name),
              latitude = COALESCE(?, latitude),
              longitude = COALESCE(?, longitude),
              last_seen = ?,
              seen_count = seen_count + 1
          `).run(nodeId, nodeName, lat, lon, now, now, nodeName, lat, lon, now)
          nodesStored++
        } catch {}
      }
    }

    // Store as intel report
    db.prepare(
      'INSERT INTO intel_reports (id, discipline, title, content, severity, source_id, source_name, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      generateId(), 'sigint',
      `Meshtastic HTTP: ${nodesStored} nodes from ${url}`,
      `**Source**: ${url}\n**Packets**: ${allData.length}\n**Nodes Stored**: ${nodesStored}`,
      'info', 'meshtastic-http', 'Meshtastic HTTP API',
      generateId(), 75, 0, now, now
    )

    log.info(`Meshtastic HTTP: stored ${nodesStored} nodes from ${url}`)
    return { success: true, message: `${nodesStored} nodes pulled via HTTP from ${url}`, nodesFound: nodesStored }
  } catch (err) {
    log.warn(`Meshtastic HTTP pull failed: ${err}`)
    return { success: false, message: String(err) }
  }
}

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

  // Discover Meshtastic device on network
  ipcMain.handle('meshtastic:discover', async () => {
    const candidates = [
      'http://meshtastic.local',
      'http://192.168.1.1',
      'http://10.0.0.1'
    ]

    // Also scan common DHCP ranges
    for (let i = 2; i <= 30; i++) {
      candidates.push(`http://192.168.1.${i}`)
      candidates.push(`http://192.168.0.${i}`)
    }

    const found: string[] = []
    const checkPromises = candidates.slice(0, 10).map(async (url) => {
      try {
        const response = await fetch(`${url}/api/v1/fromradio`, {
          signal: AbortSignal.timeout(3000),
          headers: { Accept: 'application/x-protobuf' }
        })
        if (response.status === 200 || response.status === 204) {
          found.push(url)
        }
      } catch {}
    })

    await Promise.allSettled(checkPromises)
    return { found, message: found.length > 0 ? `Found device at: ${found[0]}` : 'No device found. Check WiFi is enabled on your Meshtastic device.' }
  })

  // Pull node database — try HTTP API first, then CLI
  ipcMain.handle('meshtastic:pullDeviceData', async () => {
    const config = settingsService.get<MeshtasticConfig>('meshtastic')

    // Try HTTP first if we have an address
    const httpAddress = config?.address || ''
    if (httpAddress || config?.connectionType === 'tcp') {
      const httpResult = await pullViaHttp(httpAddress || 'http://meshtastic.local')
      if (httpResult.success) return httpResult
      log.info(`Meshtastic HTTP pull failed, trying CLI...`)
    }

    if (!config?.serialPath && config?.connectionType === 'serial') {
      return { success: false, message: 'No serial port or HTTP address configured' }
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
