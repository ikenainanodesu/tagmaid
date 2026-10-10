# TagMaid

<p align="center"><img src="extension/icons/icon-128.png" width="128" height="128" alt="TagMaid pixel maid logo"></p>

**A little maid for your browser tabs.** Preview, edit, and confirm AI-powered tab groups or sorting in the Microsoft Edge sidebar. Bring your own OpenAI-compatible API, or sort by domain entirely on your device.

**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

## Install and use

1. Download and extract `TagMaid-v1.0.1.zip` from [Releases](https://github.com/ikenainanodesu/tagmaid/releases), or clone this repository.
2. Open `edge://extensions`, enable **Developer mode**, and select **Load unpacked**.
3. Choose the extracted `TagMaid` folder containing `manifest.json`; for a source checkout, choose `extension`.
4. Click the TagMaid toolbar icon or press **Alt+Shift+Y**. Change conflicting shortcuts at `edge://extensions/shortcuts`.
5. For AI modes, enter your API URL, model name, and key, then save and authorize the API site. Example: `https://api.example.com/v1`; a full `/chat/completions` URL also works. A local service without authentication may use an empty key.
6. Choose a mode, optionally add instructions, review the outgoing data, and generate a preview. Edit new group names, colors, and assignments, or exclude tabs. Confirm to apply.

No Node.js installation or build is needed to use the extension. After updating its files, click **Reload** in the extension manager and reopen the sidebar. This release is an unpacked extension, not a browser-store installation.

## Five modes

| Mode | Behavior |
| --- | --- |
| Reorganize all | Regroup eligible tabs, including those already in groups. |
| New groups only (default) | Preserve existing groups; organize only ungrouped tabs. |
| Allow existing groups | Let ungrouped tabs join existing or new groups; preserve existing group properties. |
| AI sort · no grouping | Sort ungrouped tabs by topic or task without creating groups. |
| Domain sort · no grouping | Sort locally by full hostname, retaining the original order within each hostname; no API needed. |

Only the sidebar's window is affected. Pinned tabs and non-HTTP(S) pages are excluded. Sorting moves participating tabs to the window's end, after existing groups; existing groups retain their members, names, colors, collapsed state, and relative order. Excluded and newly opened tabs do not participate, though their absolute positions may shift when other tabs move.

## Languages

The interface supports **English, 简体中文, and 日本語**. First use follows the browser language, falling back to English for other languages. Manual choices are stored locally. Switching preserves the preview and edits without another API request. AI group names use the language selected when generation starts, unless your instructions explicitly request another language. Page titles and existing or edited group names are not translated. Browser-managed extension text follows the browser language separately.

## Privacy and security

- Only an explicit AI preview request sends data directly to your configured API. There is no relay server, telemetry, content script, page-body collection, or scheduled organization. Domain sorting makes no API request or API-site permission request.
- AI receives eligible tab titles, IDs, sanitized URLs, and your instructions. URL queries, fragments, usernames, and passwords are removed. **Titles, hostnames, paths, instructions, and group names can still contain private information.** The existing-groups mode also sends existing group names and eligible member metadata. Review the data before sending.
- Keys use browser-session storage by default. **Remember on this device** opts into local extension storage without cloud sync. This storage is not an encrypted vault. Uncheck and save to remove the persistent key.
- Public API endpoints require HTTPS; HTTP is allowed only for `localhost` and `127.0.0.1`. Requests reject redirects, time out after 90 seconds, and are not automatically retried. The API must support non-streaming Chat Completions.
- Required permissions are `tabs`, `tabGroups`, `sidePanel`, and `storage`. Website access is optional and requested for your configured API site through a user action, rather than granted for all sites at installation.
- Model output is parsed and validated as data, rendered as plain text, and requires confirmation before browser changes. Classification may still be wrong; inspect the preview.

Implementation: [network requests](extension/api.js), [URL cleanup and plan validation](extension/core.js), [settings and preview](extension/sidepanel.js), [permissions](extension/manifest.json). See [SECURITY.md](SECURITY.md) for reporting and boundaries.

## Undo and recovery

Each window keeps one undo record for the current browser session. Undo restores eligible tabs still in that window; it does not reopen closed tabs, retrieve tabs from other windows, unpin newly pinned tabs, or close new tabs. Group IDs may change. Avoid manual tab changes while applying or undoing.

Closed, moved, or newly pinned tabs are removed from previews while remaining edits are preserved. New tabs wait for the next preview. Navigation, regrouping, or changed target-group properties may require regeneration or exclusion. Application failures trigger rollback; interrupted recovery remains available in the sidebar.

## Development

Use Node.js 22 or newer. Playwright is development-only; the extension has no runtime package dependencies.

```sh
npm ci
npm test
npm run check
npm run package
```

Tests cover URL cleanup, response validation, five modes, preview changes, rollback, and undo with mock browser APIs. Static checks validate the manifest, resources, script syntax, and UI references. Packaging replaces the generated `dist/TagMaid` directory with a clean extension and all three READMEs.

On Windows with Edge, `npm run test:language-browser` tests the actual sidebar in an isolated profile with a local mock API. Set `EDGE_PATH` for another Edge executable. Artifacts stay under ignored `test-results/`. These checks do not establish real-provider classification quality, retention policies, or native permission-dialog interaction.

## License

Copyright © 2026 ikenainanodesu. TagMaid's original code, documentation, Logo, icons, and animation assets are licensed under **GNU GPL version 3 only** (`GPL-3.0-only`). See [LICENSE](LICENSE) for the full terms and [NOTICE](NOTICE) for the project notice. Third-party components retain their own licenses. The release package includes both files; [corresponding source for v1.0.1](https://github.com/ikenainanodesu/tagmaid/tree/v1.0.1) is available in this repository.

## Feedback

Use [Issues](https://github.com/ikenainanodesu/tagmaid/issues) for bugs and [Discussions](https://github.com/ikenainanodesu/tagmaid/discussions) for ideas and conversation. Remove keys, sensitive URLs, and private tab titles before posting screenshots or logs.
