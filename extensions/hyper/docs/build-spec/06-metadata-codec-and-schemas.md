# 6. Metadata Codec and Schemas

Store machine metadata as one compact JSON object after whitespace at the end of a human title.

Parsing:

1. Scan candidate `{` characters from right to left.
2. Require whitespace immediately before the candidate.
3. Parse the entire suffix.
4. Accept only a non-array object.
5. If no candidate succeeds, expose the entire raw title with empty metadata.

Serialization:

- trim trailing visible-title whitespace;
- recursively omit `undefined` and empty object metadata;
- append one space and compact JSON only when meaningful metadata remains;
- preserve unknown top-level and `hyper` keys during updates.

All UI and Search surfaces display only the visible title.

## 6.1 Structural metadata

```json
{"hyper":{"spaceTabs":true,"spaceId":"space-bookmark-id"}}
```

```json
{"hyper":{"spaceBookmarks":true,"spaceId":"space-bookmark-id"}}
```

```json
{"hyper":{"tabFolder":true}}
```

A split view folder, titled `Side by side`, holds one split's backings in pane order.
It stays a tab folder, so anything that cannot show it as panes shows it as a folder:

```json
{"hyper":{"splitView":true,"tabFolder":true}}
```

```json
{"hyper":{"favouriteSlot":0}}
```

A space folder carries, once archived, its archive flag (`spaceBookmarkArchived` in `bookmarks.ts`).
It carries no colour: a space's colour is its tab groups' ([§12.3](12-spaces-windows-and-activation.md)), and the `hyper.colour` earlier versions kept is removed.

```json
{"hyper":{"archived":true}}
```

## 6.2 Space focus metadata

Persist the last active backing token globally and per native window on the space folder:

```json
{
  "hyper": {
    "lastActiveTabToken": "fallback-token",
    "lastActiveTabTokensByWindow": {
      "42": "window-token"
    }
  }
}
```

`spaceLastActiveTabToken()` in `bookmarks.ts` reads them.
Given a window ID while `lastActiveTabTokensByWindow` is an object, only that window's entry counts, and a missing entry means no token, with no fallback.
`lastActiveTabToken` applies only when the map is absent or no window ID is given.
Migrate keys only across an unambiguous old-to-current window mapping.

## 6.3 Tab backing metadata

```json
{
  "hyper": {
    "tab": true,
    "tabIndex": 3,
    "tabToken": "stable-random-token",
    "spaceId": "space-bookmark-id",
    "windowId": 42,
    "installationId": "local-random-id",
    "pageTitle": "Original page title",
    "linkedBookmarkId": "visible-bookmark-id",
    "declinedBookmarkId": "previously-unlinked-bookmark-id"
  },
  "isCustomName": true
}
```

The last four fields are conditional: `pageTitle` retains the page's own name beside a user name; a linked or declined bookmark ID remembers the tab's same-domain relationship.
`isCustomName` is top-level metadata, not inside `hyper`, and appears after an explicit rename.
URL lives on the bookmark node, not in title metadata.
Lifecycle synchronisation refreshes URL, index, token, space, window, and installation fields while preserving a custom visible title and marker.
The visible title of an unnamed backing is the page's last known title; a browser placeholder for the same page does not replace it ([§14](14-tab-naming.md)).
On leaving the domain, clear the custom name and bookmark-link IDs.
