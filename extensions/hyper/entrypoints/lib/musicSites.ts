import { isHttpProtocol } from './urlIdentity';

/**
 * Sites people play music from in the background. Each entry matches the host
 * itself and any subdomain of it.
 */
const MUSIC_HOSTS = [
  'music.youtube.com',
  'spotify.com',
  'music.apple.com',
  'soundcloud.com',
  'tidal.com',
  'deezer.com',
  'pandora.com',
  'qobuz.com',
  'bandcamp.com',
  'mixcloud.com',
  'audiomack.com',
  'iheart.com',
  'tunein.com',
  'napster.com',
  'radio.garden',
  'lofi.cafe',
];

/** Amazon Music runs on many country domains, such as music.amazon.co.uk. */
const AMAZON_MUSIC_HOST = /^music\.amazon\.[a-z.]+$/;

export function isMusicSite(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    const parsed = new URL(url);
    if (!isHttpProtocol(parsed.protocol)) return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  return AMAZON_MUSIC_HOST.test(host) ||
    MUSIC_HOSTS.some((music) => host === music || host.endsWith(`.${music}`));
}
