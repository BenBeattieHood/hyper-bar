# 19. Selection, Row States, and Accessibility

Rows have a 36px outer track and 34px visual surface/control track in normal layouts.
Close controls remain compact at 20px by 20px with 5px right margin.
Responsive stacked action tracks may use 28px controls while compact Close remains intentionally smaller.

Use this visual hierarchy, with no state border:

- selected: faint accent background, approximately 8%;
- hover: stronger accent background, approximately 12%;
- active/foremost: strongest accent background, approximately 18%;
- keyboard focus: 2px focus outline with 1px offset;
- marquee: 1px focus-colored border with the hover background.

Attached controls share the row surface and therefore visually inherit selected/hover/active state.
Detached controls separated by a gap, including space indicators and bookmark-sync actions, remain transparent when the row is selected/active and show only their own hover/focus treatment.
Close remains compact but appears within the attached selected surface.

Support Command/Ctrl toggle selection, Shift visible-range selection, and pointer marquee selection.
Maintain separate selection scopes for tabs/tab folders, visible bookmarks/folders, favourites, and other sessions' tabs (`sessions`, [§20.2](20-drag-and-drop-contract.md)).
Browser-driven active-tab changes update active state without clearing selection; explicit Hyper activation may clear it.

Requirements:

- no nested interactive controls;
- stable dimensions and non-shrinking action lanes;
- `min-width: 0` and ellipsis for long labels;
- icon actions have accessible names and useful titles;
- command bar uses combobox/listbox/option and `aria-activedescendant`;
- compact workspace controls use tab semantics;
- modals trap focus;
- drag has keyboard instructions;
- reduced motion produces immediate state changes;
- no horizontal overflow at 360px, 719px, 720px, or 900px;
- the spaces bar sits whole at the foot of the side panel and the in-page sidebar at every size, however many tabs and bookmarks the lists hold.
