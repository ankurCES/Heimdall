import { collectorManager } from './CollectorManager'

// OSINT
import { RssCollector } from './osint/RssCollector'
import { PublicRecordsCollector } from './osint/PublicRecordsCollector'
import { AcademicCollector } from './osint/AcademicCollector'
import { FactbookCollector } from './osint/FactbookCollector'
import { GdeltCollector } from './osint/GdeltCollector'
import { AhmiaCollector } from './osint/AhmiaCollector'
import { DarkSearchCollector } from './osint/DarkSearchCollector'
import { OnionFeedCollector } from './osint/OnionFeedCollector'
import { GovernmentDataCollector } from './osint/GovernmentDataCollector'
import { GNewsCollector } from './osint/GNewsCollector'
import { PredictionMarketCollector } from './osint/PredictionMarketCollector'
import { FbiCrimeStatsCollector } from './osint/FbiCrimeStatsCollector'
import { UkPoliceCrimeCollector } from './osint/UkPoliceCrimeCollector'

// CYBINT
import { CveCollector } from './cybint/CveCollector'
import { ThreatFeedCollector } from './cybint/ThreatFeedCollector'
import { DnsWhoisCollector } from './cybint/DnsWhoisCollector'
import { InternetOutageCollector } from './cybint/InternetOutageCollector'
import { CyberIocCollector } from './cybint/CyberIocCollector'
import { SansIscCollector } from './cybint/SansIscCollector'

// FININT
import { EdgarCollector } from './finint/EdgarCollector'
import { SanctionsCollector } from './finint/SanctionsCollector'
import { CommodityCollector } from './finint/CommodityCollector'
import { MfapiCollector } from './finint/MfapiCollector'
import { AlpacaStockCollector, AlpacaCryptoCollector } from './finint/AlpacaCollector'

// SOCMINT
import { TwitterCollector } from './socmint/TwitterCollector'
import { RedditCollector } from './socmint/RedditCollector'
import { TelegramChannelCollector } from './socmint/TelegramChannelCollector'
import { MastodonCollector } from './socmint/MastodonCollector'

// GEOINT
import { UsgsEarthquakeCollector } from './geoint/UsgsEarthquakeCollector'
import { NoaaWeatherCollector } from './geoint/NoaaWeatherCollector'
import { SentinelCollector } from './geoint/SentinelCollector'
import { NasaFirmsCollector } from './geoint/NasaFirmsCollector'
import { NasaEonetCollector } from './geoint/NasaEonetCollector'
import { RadiationCollector } from './geoint/RadiationCollector'
import { GdacsCollector } from './geoint/GdacsCollector'
import { ClimateAnomalyCollector } from './geoint/ClimateAnomalyCollector'

// SIGINT
import { AdsbCollector } from './sigint/AdsbCollector'
import { FccCollector } from './sigint/FccCollector'
import { AisCollector } from './sigint/AisCollector'
import { MeshtasticCollector } from './sigint/MeshtasticCollector'
import { AdsbLolCollector } from './sigint/AdsbLolCollector'
import { SatelliteCollector } from './sigint/SatelliteCollector'
import { AirportDelayCollector } from './sigint/AirportDelayCollector'
import { ChokepointCollector } from './sigint/ChokepointCollector'

// IMINT
import { TrafficCameraCollector } from './imint/TrafficCameraCollector'
import { PublicCameraCollector } from './imint/PublicCameraCollector'

// RUMINT
import { ForumCollector } from './rumint/ForumCollector'

// CI
import { HibpCollector } from './ci/HibpCollector'
import { BreachFeedCollector } from './ci/BreachFeedCollector'

// Custom (user-addable)
import { ApiEndpointCollector } from './custom/ApiEndpointCollector'
import { TelegramSubscriberCollector } from './custom/TelegramSubscriberCollector'
import { GitHubRepoCollector } from './custom/GitHubRepoCollector'

// Agency
import { InterpolCollector } from './agency/InterpolCollector'
import { FbiCollector } from './agency/FbiCollector'
import { EuropolCollector } from './agency/EuropolCollector'
import { UnscCollector } from './agency/UnscCollector'
import { SecurityAdvisoryCollector } from './agency/SecurityAdvisoryCollector'

export function registerAllCollectors(): void {
  // OSINT (7)
  collectorManager.registerFactory('rss', () => new RssCollector())
  collectorManager.registerFactory('public-records', () => new PublicRecordsCollector())
  collectorManager.registerFactory('academic', () => new AcademicCollector())
  collectorManager.registerFactory('factbook', () => new FactbookCollector())
  collectorManager.registerFactory('gdelt', () => new GdeltCollector())
  collectorManager.registerFactory('government-data', () => new GovernmentDataCollector())
  collectorManager.registerFactory('gnews', () => new GNewsCollector())
  collectorManager.registerFactory('fbi-crime-stats', () => new FbiCrimeStatsCollector())
  collectorManager.registerFactory('prediction-market', () => new PredictionMarketCollector())
  collectorManager.registerFactory('uk-police-crime', () => new UkPoliceCrimeCollector())

  // Dark-web (3) — see Settings → Dark Web for SOCKS5 + watch-term config
  collectorManager.registerFactory('ahmia', () => new AhmiaCollector())
  collectorManager.registerFactory('darksearch', () => new DarkSearchCollector())
  collectorManager.registerFactory('onion-feed', () => new OnionFeedCollector())

  // CYBINT (4)
  collectorManager.registerFactory('cve', () => new CveCollector())
  collectorManager.registerFactory('threat-feed', () => new ThreatFeedCollector())
  collectorManager.registerFactory('dns-whois', () => new DnsWhoisCollector())
  collectorManager.registerFactory('sans-isc', () => new SansIscCollector())
  collectorManager.registerFactory('internet-outage', () => new InternetOutageCollector())
  collectorManager.registerFactory('cyber-ioc', () => new CyberIocCollector())

  // FININT (2)
  collectorManager.registerFactory('edgar', () => new EdgarCollector())
  collectorManager.registerFactory('sanctions', () => new SanctionsCollector())
  collectorManager.registerFactory('commodity', () => new CommodityCollector())
  collectorManager.registerFactory('mfapi', () => new MfapiCollector())
  collectorManager.registerFactory('alpaca-stock', () => new AlpacaStockCollector())
  collectorManager.registerFactory('alpaca-crypto', () => new AlpacaCryptoCollector())

  // SOCMINT (4)
  collectorManager.registerFactory('twitter', () => new TwitterCollector())
  collectorManager.registerFactory('reddit', () => new RedditCollector())
  collectorManager.registerFactory('telegram-channel', () => new TelegramChannelCollector())
  collectorManager.registerFactory('mastodon', () => new MastodonCollector())

  // GEOINT (3)
  collectorManager.registerFactory('usgs-earthquake', () => new UsgsEarthquakeCollector())
  collectorManager.registerFactory('noaa-weather', () => new NoaaWeatherCollector())
  collectorManager.registerFactory('sentinel', () => new SentinelCollector())
  collectorManager.registerFactory('nasa-firms', () => new NasaFirmsCollector())
  collectorManager.registerFactory('nasa-eonet', () => new NasaEonetCollector())
  collectorManager.registerFactory('radiation', () => new RadiationCollector())
  collectorManager.registerFactory('gdacs', () => new GdacsCollector())
  collectorManager.registerFactory('climate-anomaly', () => new ClimateAnomalyCollector())

  // SIGINT (6)
  collectorManager.registerFactory('adsb', () => new AdsbCollector())
  collectorManager.registerFactory('adsb-lol', () => new AdsbLolCollector())
  collectorManager.registerFactory('satellite', () => new SatelliteCollector())
  collectorManager.registerFactory('fcc', () => new FccCollector())
  collectorManager.registerFactory('meshtastic', () => new MeshtasticCollector())
  collectorManager.registerFactory('ais-maritime', () => new AisCollector())
  collectorManager.registerFactory('airport-delay', () => new AirportDelayCollector())
  collectorManager.registerFactory('chokepoint', () => new ChokepointCollector())

  // IMINT (2)
  collectorManager.registerFactory('traffic-camera', () => new TrafficCameraCollector())
  collectorManager.registerFactory('public-camera', () => new PublicCameraCollector())

  // RUMINT (1)
  collectorManager.registerFactory('forum', () => new ForumCollector())

  // CI (2)
  collectorManager.registerFactory('hibp', () => new HibpCollector())
  collectorManager.registerFactory('breach-feed', () => new BreachFeedCollector())

  // Agency (4)
  collectorManager.registerFactory('interpol', () => new InterpolCollector())
  collectorManager.registerFactory('fbi', () => new FbiCollector())
  collectorManager.registerFactory('europol', () => new EuropolCollector())
  collectorManager.registerFactory('unsc', () => new UnscCollector())
  collectorManager.registerFactory('security-advisory', () => new SecurityAdvisoryCollector())

  // Custom (user-addable)
  collectorManager.registerFactory('api-endpoint', () => new ApiEndpointCollector())
  collectorManager.registerFactory('telegram-subscriber', () => new TelegramSubscriberCollector())
  collectorManager.registerFactory('github-repo', () => new GitHubRepoCollector())
}
