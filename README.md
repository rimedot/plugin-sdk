# Meva plugin SDK

Types, validators, a small runtime and the `meva-plugin` command for
building [Meva](https://github.com/rimedot) plugins as `.mevax` files.

Meva has four kinds of plugins:

| Kind | Runs | What it is |
|---|---|---|
| UI | in the desktop app | A TypeScript entrypoint bundled into `plugin.js`, plus a manifest that declares its views and permissions |
| Processor | on the Meva server | Only a manifest: how to send media to a model and what to write back (tags, ratings, descriptions) |
| Runner | as its own program | A manifest that lists a native build per platform, each a separate release file |
| Source | in a Web Worker in each Meva app | A site in the Sources page: a TypeScript entrypoint bundled into `plugin.js` that browses and imports through the Meva server |

Example plugins: [Cat Printer](https://github.com/rimedot/cat-printer) (UI),
[WD Tagger](https://github.com/rimedot/wd-tagger) (processor),
[Meva runner](https://github.com/rimedot/runner) (runner),
[Booru](https://github.com/rimedot/booru) (source).

## Install

The SDK is not on npm. Depend on a tagged version from GitHub:

```json
{
  "dependencies": {
    "@rimedot/meva-plugin-sdk": "github:rimedot/plugin-sdk#v0.2.0"
  }
}
```

`npm install` (or `pnpm install`) builds it on install. Node.js 20 or newer.

## A UI plugin

`manifest.json` is the source of truth. Meva reads and checks it before it
starts any code, and the code cannot add a permission, view, action or
Bluetooth UUID that the manifest does not list.

```json
{
  "formatVersion": 1,
  "source": "https://github.com/you/my-plugin",
  "id": "github.com/you/my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "requiresMeva": ">=0.1.0",
  "entrypoint": "plugin.js",
  "permissions": { "currentMedia": { "read": true } },
  "contributes": {
    "mediaDialogWorkspaces": [{
      "id": "main",
      "action": { "slot": "media.dialog.actions", "label": "Process", "icon": "wand", "when": { "mediaType": "image" } },
      "layout": { "type": "comparison", "secondaryImage": "result" },
      "sidebar": "settings"
    }]
  },
  "views": {
    "settings": {
      "type": "stack",
      "children": [
        { "type": "slider", "label": "Contrast", "bind": "contrast", "min": -100, "max": 100 },
        { "type": "button", "label": "Run", "command": "run", "role": "primary" }
      ]
    }
  }
}
```

- `source` is the HTTPS address of the plugin's repository, and `id` is
  made from it: `github.com/<owner>/<repo>` in lowercase (`<host>/<path>`
  elsewhere). A manifest whose id is not its source is refused.
- `requiresMeva` is a semver range (`>=`, `<=`, `>`, `<`, `^`, `~`,
  space-separated clauses, `||`) checked against Meva's plugin API version
  (`MEVA_PLUGIN_API_VERSION`), not the app version.
- The only action slot is `media.dialog.actions`. It opens a workspace with
  the `comparison` layout: the selected image, one image your plugin makes
  (the `secondaryImage` binding) and a sidebar view.
- Views are data, not HTML or React: `stack`, `row`, `text`, `heading`,
  `separator`, `slider`, `numberInput`, `select`, `switch`, `button` and
  `status`. Controls bind to keys of the plugin's state; buttons name a
  command.

The entrypoint:

```ts
import { definePlugin, ui, type PluginRuntimeContext } from "@rimedot/meva-plugin-sdk"

export default definePlugin({
  id: "github.com/you/my-plugin",
  permissions: { currentMedia: { read: true } },
  contributes: { /* the same as the manifest */ },
  views: {
    settings: ui.stack([
      ui.slider({ label: "Contrast", bind: "contrast", min: -100, max: 100 }),
      ui.button({ label: "Run", command: "run", role: "primary" }),
    ]),
  },
  commands: {
    run: async (context: PluginRuntimeContext) => {
      const media = await context.media.readCurrent()   // bytes and mime of the open image
      const contrast = context.state.get<number>("contrast") ?? 0
      // ... make a PNG ...
      // context.preview("result", pngBytes, width, height)
      context.state.set("status", "Done")
    },
  },
})
```

`plugin.js` runs in a hidden, sandboxed Electron renderer: no Node, no
network (`http`, `https`, `ws` and `wss` requests are cancelled), no DOM
that the user sees. Meva draws the controls. What the plugin can ask for:

- `media.readCurrent`: the bytes of the image that is open, nothing else.
- `bluetooth.requestDevice`, then `connect`, `write`, `subscribe` and
  `disconnect` on the handle Meva gives back, limited to the services and
  characteristics in the manifest. The user picks the device in Meva.
  `requestDevice` needs a button with `"userActivation":
  "bluetooth.requestDevice"`.

Closing the workspace revokes the media and Bluetooth grants.

## A source plugin

A source plugin is a site in Meva's Sources page. Its entrypoint's default
export is the plugin (`defineSource` from `@rimedot/meva-plugin-sdk/source-plugin`):
`feed` is required; `post`, `importPost`, `importArtist`, `resolveUrl`,
`autocomplete`, `sites`, `artistPreviews` and `favorites` are optional and
go with the `browse.capabilities` in the manifest.

The code runs in a Web Worker with no network access of its own. Every
request goes through `host.fetch`, which the Meva server sends only to the
hosts in `network.hosts` (local or private addresses only when listed in
`network.local` and accepted by the user). `host.storage` keeps the plugin's
own files on the server, and `host.settings` holds the values of the
manifest's `settings`. Imports return a plan of files to download with
their sidecar fields; the server does the downloads.

`network.mediaProxy` lists hosts whose images only load with a certain
`Referer`; Meva serves those through signed links. `urlPatterns` are the
pages the browser extension and pasted links send to the plugin.

## Build and check

```sh
meva-plugin build --entry src/plugin.ts --manifest manifest.json --license LICENSE --out my-plugin.mevax
meva-plugin validate my-plugin.mevax
```

`build` bundles the entrypoint and its browser-safe dependencies into one
`plugin.js` with esbuild. A UI `.mevax` may hold only `manifest.json`,
`plugin.js`, `icon.svg` and `LICENSE`. A source plugin is built the same
way, as one classic script for a Web Worker, and may also hold `README.md`.

Processor and runner plugins have no code:

```sh
meva-plugin build --manifest manifest.json --readme README.md --license LICENSE --out my-plugin.mevax
```

Their `.mevax` holds `manifest.json` and, optionally, `README.md`,
`LICENSE` and `icon.svg`. A runner's manifest lists each platform's build
(`os`, `arch`, the release file name, its sha256 and size); the program
itself is never in the `.mevax`. See `src/processor.ts` and `src/runner.ts`
for every field.

The archive is a plain ZIP with limits: at most 10 MB compressed, 25 MiB
expanded and 16 entries, no ZIP64, encryption or unsafe paths.

## Release

Attach the `.mevax` to a GitHub release whose tag is the manifest version
(`v1.2.0` or `1.2.0`). When you install from the repository link, Meva
checks the file against GitHub's sha256 for that release file, and shows
the plugin as open source when the repository is public, has an
OSI-approved license and the file has a build attestation from a workflow in
that repository (`actions/attest-build-provenance`). On other hosts, put a
`SHA256SUMS` file next to the `.mevax`.

## Develop the SDK

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

## License

MIT
