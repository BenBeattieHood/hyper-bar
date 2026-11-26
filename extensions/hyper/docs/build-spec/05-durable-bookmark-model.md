# 5. Durable Bookmark Model

Create this canonical hierarchy under the browser bookmark bar:

```text
hyper
  favourites/
    <up to seven visible bookmark nodes with favouriteSlot metadata>
  bookmarks/
    <global visible nested bookmark tree, in no space>
  spaces/
    <ordered space folder: Space.id>/
      tabs { hyper.spaceTabs: true, hyper.spaceId: Space.id }/
        <optional marked shared tab folder>/
          <hidden exact tab-backing bookmarks>
        <unfiled hidden exact tab-backing bookmarks>
      bookmarks { hyper.spaceBookmarks: true, hyper.spaceId: Space.id }/
        <space visible nested bookmark tree: Space.rootId>
```

Folder order beneath `spaces` is visual space order.
Every space `bookmarks` root is structural and is not rendered as an ordinary row or Search result.
`hyper/bookmarks` holds global bookmarks, which belong to no space; it is structural and is not rendered as a row.
A tab opened from a global bookmark stays linked to it in any space.

Each backing has a distinct bookmark ID and `tabToken`; URLs never identify a backing or a unique live tab.
A backing's optional `tabIndex` orders backings for its local window, because physical bookmark sibling order cannot represent several window orders.

`Space` in `entrypoints/lib/bookmarks.ts` carries `id`, `rootId?`, `title`, `index`, `children`, `archived?` and `colour?`; `archived` comes from the space folder's metadata ([§6](06-metadata-codec-and-schemas.md)), and the model fills `colour` from the space's live tab groups ([§12.3](12-spaces-windows-and-activation.md)).

Preferences live on the `hyper` root title as `{"hyper":{"preferences":{...}}}`, and unset ones use defaults.
`entrypoints/lib/preferences.ts` owns the fields, defaults and clamps: `autofolders`, `bookmarkPanelPercent`, `combineTabsAndBookmarks`, `groupFavouritesByDomain`, `inPageSidebar`, `inPageSidebarWidth`, `showOtherSessions`, `syncTabStripOrder` and `timedMessageSeconds`.
Unknown preference and title metadata keys survive writes.
`saveHyperPreferences` and `migrateLegacyPreferences` (`bookmarkStorage.ts`) share one serialised root-title writer.
`migrateLegacyPreferences` moves preferences that earlier versions kept in `storage.local` onto the root before the model's first read, and a value the root already carries wins.

Use `Space.id` for space selection, space rename/delete/reorder, tab ownership, group ownership, and backing `spaceId`.
Use `Space.rootId` only as the destination root for visible-bookmark create/move/drop/import operations.
Never reorder or delete a space by `rootId`.
`rootId` is absent until repair creates the marked root; bookmark writes must refuse while it is absent rather than aim at `Space.id`.

Each space owns exactly one marked `tabs` root and one marked `bookmarks` root.
A direct plain folder named `bookmarks` is adopted and marked in place, preserving its bookmark ID, descendants, and order.
Nothing else is ever moved automatically: ordinary direct children of an existing space and hidden tab backings sitting outside the marked `tabs` root stay where the user left them, and are not shown as space bookmarks.

`deriveBookmarkState()` in `bookmarks.ts` derives `localBookmarksBySpaceId`, each space's visible bookmarks, and the Bookmarks pane shows `localBookmarksBySpaceId[activeSpaceId]`.
It also derives `localBookmarkSpaceIds`, the owning space of every descendant, so Search and scope moves do not infer ownership from a mutable title.
