import { isRecord } from './collections';
import { chromeScripting } from './scriptingAccess';

export type MediaPlaybackState = 'paused' | 'playing';

export const mediaControlMessageType = 'hyper:media-control';
export const mediaPlaybackChangedMessageType = 'hyper:media-playback-changed';

export interface MediaPlaybackChangedMessage {
  type: typeof mediaPlaybackChangedMessageType;
  state: MediaPlaybackState;
}

export type MediaControlMessage = {
  type: typeof mediaControlMessageType;
  action: 'inspect';
} | {
  type: typeof mediaControlMessageType;
  action: 'set-playback';
  elementIndex: number;
  state: MediaPlaybackState;
};

export interface FrameMediaState {
  elementIndex: number;
  state: MediaPlaybackState;
}

export interface MediaControlTarget {
  tabId: number;
  frameId: number;
  elementIndex: number;
  state: MediaPlaybackState;
}

/**
 * A page that cannot be reached is told apart from one with no player, because
 * only the first can be fixed by granting access to it.
 */
export type TabMediaInspection =
  | { reachable: true; target?: MediaControlTarget }
  | { reachable: false; target?: undefined };

interface FrameMediaResult {
  frameId: number;
  result?: FrameMediaState | null;
}

interface MediaMessagingApi {
  getAllFrames: (tabId: number) => Promise<Array<{ frameId: number }>>;
  sendMessage: (
    tabId: number,
    message: MediaControlMessage,
    frameId: number,
  ) => Promise<unknown>;
}

function messagingApi(): MediaMessagingApi | undefined {
  const runtimeGlobal = globalThis as unknown as {
    browser?: {
      tabs?: {
        sendMessage?: (
          tabId: number,
          message: MediaControlMessage,
          options: { frameId: number },
        ) => Promise<unknown>;
      };
      webNavigation?: {
        getAllFrames?: (details: { tabId: number }) => Promise<Array<{ frameId: number }>>;
      };
    };
  };
  const runtimeBrowser = runtimeGlobal.browser;
  if (!runtimeBrowser?.tabs?.sendMessage) return undefined;
  return {
    getAllFrames: async (tabId) => {
      if (!runtimeBrowser.webNavigation?.getAllFrames) return [{ frameId: 0 }];
      const frames = await runtimeBrowser.webNavigation.getAllFrames({ tabId });
      return frames.length > 0 ? frames : [{ frameId: 0 }];
    },
    sendMessage: (tabId, message, frameId) =>
      runtimeBrowser.tabs!.sendMessage!(tabId, message, { frameId }),
  };
}

export function isMediaControlMessage(message: unknown): message is MediaControlMessage {
  if (!isRecord(message)) return false;
  const candidate = message as Partial<MediaControlMessage>;
  if (candidate.type !== mediaControlMessageType) return false;
  if (candidate.action === 'inspect') return true;
  return candidate.action === 'set-playback' &&
    typeof candidate.elementIndex === 'number' &&
    (candidate.state === 'paused' || candidate.state === 'playing');
}

export function isMediaPlaybackChangedMessage(
  message: unknown,
): message is MediaPlaybackChangedMessage {
  if (!isRecord(message)) return false;
  const candidate = message as Partial<MediaPlaybackChangedMessage>;
  return candidate.type === mediaPlaybackChangedMessageType &&
    (candidate.state === 'paused' || candidate.state === 'playing');
}

function isFrameMediaState(result: unknown): result is FrameMediaState {
  if (!isRecord(result)) return false;
  const candidate = result as Partial<FrameMediaState>;
  return typeof candidate.elementIndex === 'number' &&
    (candidate.state === 'paused' || candidate.state === 'playing');
}

export function inspectFrameMedia(): FrameMediaState | null {
  const elements = Array.from(document.querySelectorAll<HTMLMediaElement>('audio, video'));
  let elementIndex = elements.findIndex((element) => !element.paused && !element.ended);
  if (elementIndex < 0) {
    elementIndex = elements.findIndex((element) =>
      element.paused && !element.ended && element.currentTime > 0);
  }
  const element = elements[elementIndex];
  if (!element) return null;
  return {
    elementIndex,
    state: element.paused ? 'paused' : 'playing',
  };
}

export async function setFrameMediaPlayback(
  elementIndex: number,
  state: MediaPlaybackState,
): Promise<FrameMediaState | null> {
  const element = document.querySelectorAll<HTMLMediaElement>('audio, video')[elementIndex];
  if (!element || element.ended) return null;
  if (state === 'playing') await element.play();
  else element.pause();
  return {
    elementIndex,
    state: element.paused ? 'paused' : 'playing',
  };
}

export function selectMediaControlTarget(
  tabId: number,
  results: FrameMediaResult[],
): MediaControlTarget | undefined {
  const selected = results.find(({ result }) => result?.state === 'playing')
    ?? results.find(({ result }) => result?.state === 'paused');
  return selected?.result ? {
    tabId,
    frameId: selected.frameId,
    ...selected.result,
  } : undefined;
}

export function canControlTabMedia(): boolean {
  return messagingApi() !== undefined || chromeScripting() !== undefined;
}

export async function inspectTabMedia(tabId: number): Promise<TabMediaInspection> {
  // Chrome does not inject content scripts into pages already open when Hyper
  // reloads, so a top frame that answers shows the page's own script is alive.
  let topFrameAnswered = false;
  const messaging = messagingApi();
  if (messaging) {
    const frames = await messaging.getAllFrames(tabId).catch(() => [{ frameId: 0 }]);
    const results = await Promise.all(frames.map(async ({ frameId }) => {
      try {
        const result = await messaging.sendMessage(tabId, {
          type: mediaControlMessageType,
          action: 'inspect',
        }, frameId);
        if (frameId === 0) topFrameAnswered = true;
        return { frameId, result: isFrameMediaState(result) ? result : null };
      } catch {
        return { frameId, result: null };
      }
    }));
    const target = selectMediaControlTarget(tabId, results);
    if (target) return { reachable: true, target };
  }
  const scripting = chromeScripting();
  if (!scripting) return { reachable: topFrameAnswered };
  try {
    const results = await scripting.executeScript({
      target: { tabId, allFrames: true },
      func: inspectFrameMedia,
    });
    return { reachable: true, target: selectMediaControlTarget(tabId, results) };
  } catch {
    return { reachable: topFrameAnswered };
  }
}

export async function setTabMediaPlayback(
  target: MediaControlTarget,
  state: MediaPlaybackState,
): Promise<MediaControlTarget | undefined> {
  const messaging = messagingApi();
  let messagingError: unknown;
  if (messaging) {
    try {
      const result = await messaging.sendMessage(target.tabId, {
        type: mediaControlMessageType,
        action: 'set-playback',
        elementIndex: target.elementIndex,
        state,
      }, target.frameId);
      if (isFrameMediaState(result)) {
        return {
          tabId: target.tabId,
          frameId: target.frameId,
          ...result,
        };
      }
    } catch (error) {
      messagingError = error;
    }
  }
  const scripting = chromeScripting();
  if (!scripting) {
    if (messagingError) throw messagingError;
    return undefined;
  }
  const [result] = await scripting.executeScript({
    target: { tabId: target.tabId, frameIds: [target.frameId] },
    func: setFrameMediaPlayback,
    args: [target.elementIndex, state],
  });
  return result?.result ? {
    tabId: target.tabId,
    frameId: target.frameId,
    ...result.result,
  } : undefined;
}

export async function pausePlayingTabMedia(tabIds: readonly number[]): Promise<void> {
  const inspections = await Promise.all(tabIds.map(inspectTabMedia));
  await Promise.allSettled(inspections.flatMap(({ target }) =>
    target?.state === 'playing'
      ? [setTabMediaPlayback(target, 'paused')]
      : []));
}