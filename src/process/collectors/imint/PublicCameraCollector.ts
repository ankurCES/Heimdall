import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import { imageIntelService } from '../../services/imint/ImageIntelService'
import log from 'electron-log'

// Public/open camera feeds — weather cams, city cams, port cams
// These are publicly accessible streams/snapshots

const DEFAULT_PUBLIC_CAMERAS = [
  // Weather cameras
  { name: 'Mt Washington Observatory', url: 'https://www.mountwashington.org/uploads/webcam/summit-0.jpg', lat: 44.2706, lon: -71.3033 },
  // Port/harbor cameras
  { name: 'Port of LA', url: 'https://www.portoflosangeles.org/webcam/webcam.jpg', lat: 33.7366, lon: -118.2640 },
  // City public webcams
  { name: 'Jackson Hole Town Square', url: 'https://www.see.cam/us/wy/jackson/town-square.jpg', lat: 43.4799, lon: -110.7624 },
  { name: 'Yellowstone Old Faithful', url: 'https://www.nps.gov/webcams-yell/oldfaithful.jpg', lat: 44.4605, lon: -110.8281 },
  // International
  { name: 'Abbey Road London', url: 'https://www.abbeyroad.com/crossing-cam/', lat: 51.5320, lon: -0.1779 },
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
