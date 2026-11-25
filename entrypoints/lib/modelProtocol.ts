import { isCount, isRecord } from './collections';
import { hyperActionKinds, type CommandStatus, type HyperActionKind } from './modelActions';
import type { SearchCommand, SharedSearchResult } from './searchIndex';

export const HYPER_MODEL_PORT_NAME = 'hyper-model-v1';
export const HYPER_MODEL_PROTOCOL_VERSION = 1;
/**
 * The build this code came from. The browser keeps starting the worker script
 * it registered until Hyper is reloaded, while pages load the newest build from
 * disk, so the worker states its build and each page compares it with its own.
 */
export const HYPER_BUILD_ID: string = import.meta.env?.HYPER_BUILD_ID ?? 'unbuilt';

export type HyperModelClientRole = 'newtab' | 'page-search' | 'sidebar';

export type ProtocolErrorReason =
  | 'duplicate-hello'
  | 'malformed-message'
  | 'unauthenticated'
  | 'unexpected-ack'
  | 'unknown-message'
  | 'unsupported-protocol-version';

export interface HelloMessage {
  protocolVersion: number;
  role: HyperModelClientRole;
  type: 'hello';
  windowId?: number;
}

export interface AckMessage {
  sequence: number;
  type: 'ack';
}

export interface IntentMessage {
  baseRevision: number;
  commandId: string;
  kind: HyperActionKind;
  payload: unknown;
  type: 'intent';
}

export interface ResyncMessage {
  type: 'resync';
}

/**
 * Commands describe a client's presentation only. Browser and Hyper records
 * are deliberately absent: the background derives those from its committed
 * model before serving the query.
 */
export interface SearchQueryMessage {
  commands: SearchCommand[];
  includeFolders?: boolean;
  limit?: number;
  query: string;
  requestId: string;
  type: 'search-query';
}

export type ClientMessage =
  | AckMessage
  | HelloMessage
  | IntentMessage
  | ResyncMessage
  | SearchQueryMessage;

export interface WelcomeMessage {
  buildId: string;
  clientId: string;
  protocolVersion: number;
  role: HyperModelClientRole;
  type: 'welcome';
}

export interface SnapshotMessage<Payload> {
  payload: Payload;
  revision: number;
  sequence: number;
  type: 'snapshot';
}

export interface CommandStatusMessage {
  revision: number;
  sequence: number;
  statuses: readonly CommandStatus[];
  type: 'command-status';
}

export interface AcceptedMessage {
  commandId: string;
  revision: number;
  type: 'accepted';
}

export interface RejectedMessage {
  commandId: string;
  reason: string;
  type: 'rejected';
}

export interface ProtocolErrorMessage {
  buildId: string;
  reason: ProtocolErrorReason;
  type: 'protocol-error';
}

export interface SearchResultMessage {
  requestId: string;
  results: SharedSearchResult[];
  revision: number;
  type: 'search-result';
}

export interface SearchErrorMessage {
  reason: 'browser-error' | 'unsupported';
  requestId: string;
  type: 'search-error';
}

export type ServerMessage<Payload = unknown> =
  | AcceptedMessage
  | CommandStatusMessage
  | ProtocolErrorMessage
  | RejectedMessage
  | SearchErrorMessage
  | SearchResultMessage
  | SnapshotMessage<Payload>
  | WelcomeMessage;

function isRole(value: unknown): value is HyperModelClientRole {
  return value === 'newtab' || value === 'page-search' || value === 'sidebar';
}

const knownActionKinds: ReadonlySet<string> = new Set(hyperActionKinds);
const MAX_COMMAND_ID_LENGTH = 128;
const MAX_SEARCH_COMMANDS = 96;
const MAX_SEARCH_FIELD_LENGTH = 512;
const MAX_SEARCH_LIMIT = 48;
const MAX_SEARCH_QUERY_LENGTH = 512;

function isBoundedString(value: unknown, maximum = MAX_SEARCH_FIELD_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function isActionKind(value: unknown): value is HyperActionKind {
  return typeof value === 'string' && knownActionKinds.has(value);
}

function isSearchCommand(value: unknown): value is SearchCommand {
  if (!isRecord(value) ||
    !isBoundedString(value.id) || !value.id ||
    !isBoundedString(value.label) ||
    !isBoundedString(value.detail) ||
    !isBoundedString(value.icon)
  ) return false;
  if (value.shortcut !== undefined && !isBoundedString(value.shortcut)) return false;
  if (value.tabId !== undefined && !isCount(value.tabId)) return false;
  return value.keywords === undefined || (
    Array.isArray(value.keywords) &&
    value.keywords.length <= MAX_SEARCH_COMMANDS &&
    value.keywords.every((keyword) => isBoundedString(keyword))
  );
}

export type ParsedClientMessage =
  | { message: ClientMessage; status: 'parsed' }
  | { reason: ProtocolErrorReason; status: 'rejected' };

/**
 * The wire format is validated before any handler sees it, so an unknown or
 * malformed message is a protocol error rather than a partially applied change.
 */
export function parseClientMessage(value: unknown): ParsedClientMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { reason: 'malformed-message', status: 'rejected' };
  }
  switch (value.type) {
    case 'ack':
      return isCount(value.sequence)
        ? { message: { sequence: value.sequence, type: 'ack' }, status: 'parsed' }
        : { reason: 'malformed-message', status: 'rejected' };
    case 'hello': {
      if (typeof value.protocolVersion !== 'number' || !isRole(value.role)) {
        return { reason: 'malformed-message', status: 'rejected' };
      }
      if (value.protocolVersion !== HYPER_MODEL_PROTOCOL_VERSION) {
        return { reason: 'unsupported-protocol-version', status: 'rejected' };
      }
      return {
        message: {
          protocolVersion: value.protocolVersion,
          role: value.role,
          type: 'hello',
          ...(typeof value.windowId === 'number' ? { windowId: value.windowId } : {}),
        },
        status: 'parsed',
      };
    }
    case 'intent':
      // Only a listed kind reaches handler lookup, so an inherited key such as
      // `toString` can never be mistaken for a handler.
      return isCount(value.baseRevision)
        && isBoundedString(value.commandId, MAX_COMMAND_ID_LENGTH) && value.commandId
        && isActionKind(value.kind)
        ? {
          message: {
            baseRevision: value.baseRevision,
            commandId: value.commandId,
            kind: value.kind,
            payload: value.payload,
            type: 'intent',
          },
          status: 'parsed',
        }
        : { reason: 'malformed-message', status: 'rejected' };
    case 'resync':
      return { message: { type: 'resync' }, status: 'parsed' };
    case 'search-query': {
      if (
        !isBoundedString(value.requestId, 128) || !value.requestId ||
        !isBoundedString(value.query, MAX_SEARCH_QUERY_LENGTH) ||
        !Array.isArray(value.commands) ||
        value.commands.length > MAX_SEARCH_COMMANDS ||
        !value.commands.every(isSearchCommand) ||
        (value.includeFolders !== undefined && typeof value.includeFolders !== 'boolean') ||
        (value.limit !== undefined && (
          typeof value.limit !== 'number' ||
          !Number.isInteger(value.limit) ||
          value.limit < 1 ||
          value.limit > MAX_SEARCH_LIMIT
        ))
      ) return { reason: 'malformed-message', status: 'rejected' };
      return {
        message: {
          commands: value.commands,
          ...(value.includeFolders === undefined ? {} : { includeFolders: value.includeFolders }),
          ...(value.limit === undefined ? {} : { limit: value.limit }),
          query: value.query,
          requestId: value.requestId,
          type: 'search-query',
        },
        status: 'parsed',
      };
    }
    default:
      return { reason: 'unknown-message', status: 'rejected' };
  }
}

export interface DeliveryInstruction {
  revision: number;
  sequence: number;
}

export type AckResult =
  | { deliver?: DeliveryInstruction; status: 'accepted' }
  | { reason: ProtocolErrorReason; status: 'rejected' };

/**
 * A port carries at most one unacknowledged delivery. Revisions produced while
 * one is in flight collapse into a single follow-up, so a slow or wedged view
 * cannot make the background queue an unbounded number of snapshots, and the
 * acknowledged revision is the only base a patch may ever be computed against.
 */
export interface DeliveryCursor {
  acknowledgedRevision(): number | undefined;
  ack(sequence: number): AckResult;
  offer(revision: number): DeliveryInstruction | undefined;
  /** Forgets the in-flight delivery and forces the next offer to be sent. */
  reset(): void;
}

export function createDeliveryCursor(): DeliveryCursor {
  let acknowledged: number | undefined;
  let inFlight: DeliveryInstruction | undefined;
  let queuedRevision: number | undefined;
  let nextSequence = 1;

  const send = (revision: number): DeliveryInstruction => {
    inFlight = { revision, sequence: nextSequence };
    nextSequence += 1;
    queuedRevision = undefined;
    return inFlight;
  };

  return {
    ack(sequence) {
      if (!inFlight || inFlight.sequence !== sequence) {
        return { reason: 'unexpected-ack', status: 'rejected' };
      }
      acknowledged = inFlight.revision;
      inFlight = undefined;
      if (queuedRevision === undefined || queuedRevision <= acknowledged) {
        queuedRevision = undefined;
        return { status: 'accepted' };
      }
      return { deliver: send(queuedRevision), status: 'accepted' };
    },
    acknowledgedRevision() {
      return acknowledged;
    },
    offer(revision) {
      if (inFlight) {
        queuedRevision = queuedRevision === undefined
          ? revision
          : Math.max(queuedRevision, revision);
        return undefined;
      }
      return send(revision);
    },
    reset() {
      acknowledged = undefined;
      inFlight = undefined;
      queuedRevision = undefined;
    },
  };
}
