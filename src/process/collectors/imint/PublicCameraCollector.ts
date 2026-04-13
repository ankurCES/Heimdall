import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import { imageIntelService } from '../../services/imint/ImageIntelService'
import log from 'electron-log'

// Public/open camera feeds — weather cams, city cams, port cams
// These are publicly accessible streams/snapshots

const DEFAULT_PUBLIC_CAMERAS = [
  // Colorado mountain passes (verified working)
  { name: 'CO Eisenhower Tunnel', url: 'https://www.cotrip.org/dimages/camera?imageURL=remote/COACDOT-cam-I-70-Eisenhower-Tunnel-WB-212.9-static.jpg', lat: 39.6803, lon: -105.9111 },
  { name: 'CO Vail Pass', url: 'https://www.cotrip.org/dimages/camera?imageURL=remote/COACDOT-cam-I-70-Vail-Pass-WB-189.5-static.jpg', lat: 39.5314, lon: -106.2156 },
  // Virginia DOT additional
  { name: 'VA I-64 Charlottesville', url: 'https://cdn.511virginia.org/cameras/CAM-MP-050.jpg', lat: 38.0293, lon: -78.4767 },
  { name: 'VA I-66 DC Area', url: 'https://cdn.511virginia.org/cameras/CAM-MP-060.jpg', lat: 38.8804, lon: -77.1722 },
  // Minnesota additional
  { name: 'MN I-35 Duluth', url: 'https://511mn.org/camera?id=20', lat: 46.7867, lon: -92.1005 },
]

export class PublicCameraCollector extends BaseCollector {
  readonly discipline = 'imint' as const
  readonly type = 'public-camera'

  async collect(): Promise<IntelReport[]> {
    const cameras = this.getCameras()
    const reports: IntelReport[] = []

    for (const cam of cameras) {
      try {
        const report = await imageIntelService.analyzeFrame(cam.url, cam.name, cam.lat, cam.lon)
        if (report) reports.push(report)
      } catch (err) {
        log.debug(`PublicCamera: ${cam.name} failed: ${err}`)
      }

      await new Promise((r) => setTimeout(r, 5000))
    }

    log.info(`PublicCamera: processed ${cameras.length} cameras, ${reports.length} events`)
    return reports
  }

  private getCameras(): Array<{ name: string; url: string; lat: number; lon: number }> {
    const custom = this.sourceConfig?.config?.cameras as Array<{ name: string; url: string; lat: number; lon: number }> | undefined
    return custom && custom.length > 0 ? custom : DEFAULT_PUBLIC_CAMERAS
  }
}
