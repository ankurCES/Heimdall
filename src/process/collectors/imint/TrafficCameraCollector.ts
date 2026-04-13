import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import { imageIntelService } from '../../services/imint/ImageIntelService'
import log from 'electron-log'

// Public traffic camera snapshot feeds — JPEG images from DOT sources
// These are publicly accessible government traffic cameras

const DEFAULT_CAMERAS = [
  // NYC DOT Traffic Cameras
  { name: 'NYC Times Square', url: 'https://webcams.nyctmc.org/api/cameras/1', lat: 40.758, lon: -73.9855 },
  // Chicago CDOT
  { name: 'Chicago Loop', url: 'https://www.travelmidwest.com/lmiga/cameraThumbnail.do?id=GATEWAY-cam-600', lat: 41.8819, lon: -87.6278 },
  // Caltrans
  { name: 'LA I-405', url: 'https://cwwp2.dot.ca.gov/vm/streamimage?cameraId=s-17-405', lat: 33.9425, lon: -118.4081 },
  // WSDOT
  { name: 'Seattle I-5', url: 'https://images.wsdot.wa.gov/nw/005vc08067.jpg', lat: 47.6062, lon: -122.3321 },
  // MnDOT
  { name: 'Minneapolis I-94', url: 'https://video.dot.state.mn.us/video/image/metro/C013.jpg', lat: 44.9778, lon: -93.2650 },
  // PennDOT
  { name: 'Philadelphia I-76', url: 'https://www.511pa.com/Cameras/Details/Camera-1', lat: 39.9526, lon: -75.1652 },
  // VDOT
  { name: 'DC Beltway I-495', url: 'https://www.511virginia.org/camera/snapshot/CAM-495-E-001', lat: 38.8462, lon: -77.0642 },
  // EarthCam public
  { name: 'NYC Brooklyn Bridge', url: 'https://www.earthcam.com/cams/newyork/brooklynbridge/cam.jpg', lat: 40.7061, lon: -73.9969 },
  { name: 'Miami Beach', url: 'https://www.earthcam.com/cams/florida/miamibeach/cam.jpg', lat: 25.7907, lon: -80.1300 }
]

export class TrafficCameraCollector extends BaseCollector {
  readonly discipline = 'imint' as const
  readonly type = 'traffic-camera'

  async collect(): Promise<IntelReport[]> {
    const cameras = this.getCameras()
    const reports: IntelReport[] = []

    for (const cam of cameras) {
      try {
        // Just capture and log the frame — ImageIntelService handles LLM analysis
        const report = await imageIntelService.analyzeFrame(cam.url, cam.name, cam.lat, cam.lon)
        if (report) reports.push(report)
      } catch (err) {
        log.debug(`TrafficCamera: ${cam.name} failed: ${err}`)
      }

      // Rate limit between cameras
      await new Promise((r) => setTimeout(r, 3000))
    }

    log.info(`TrafficCamera: processed ${cameras.length} cameras, ${reports.length} events detected`)
    return reports
  }

  private getCameras(): Array<{ name: string; url: string; lat: number; lon: number }> {
    const custom = this.sourceConfig?.config?.cameras as Array<{ name: string; url: string; lat: number; lon: number }> | undefined
    return custom && custom.length > 0 ? custom : DEFAULT_CAMERAS
  }
}
