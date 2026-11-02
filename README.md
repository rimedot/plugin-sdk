# Meva plugin SDK

Types, validators, a small runtime and the `meva-plugin` command for
building [Meva](https://github.com/rimedot) plugins as `.mevax` files.

Meva has three kinds of plugins:

| Kind | Runs | What it is |
|---|---|---|
| UI | in the desktop app | A TypeScript entrypoint bundled into `plugin.js`, plus a manifest that declares its views and permissions |
| Processor | on the Meva server | Only a manifest: how to send media to a model and what to write back (tags, ratings, descriptions) |
| Runner | as its own program | A manifest that lists a native build per platform, each a separate release file |

Example plugins: [Cat Printer](https://github.com/rimedot/cat-printer) (UI),
[WD Tagger](https://github.com/rimedot/wd-tagger) (processor),
[Meva runner](https://github.com/rimedot/runner) (runner).

## Install

The SDK is not on npm. Depend on a tagged version from GitHub:

```json
{
  "dependencies": {
    "@rimedot/meva-plugin-sdk": "github:rimedot/plugin-sdk#v0.1.0"
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

## Build and check

```sh
meva-plugin build --entry src/plugin.ts --manifest manifest.json --license LICENSE --out my-plugin.mevax
meva-plugin validate my-plugin.mevax
```

`build` bundles the entrypoint and its browser-safe dependencies into one
`plugin.js` with esbuild. A UI `.mevax` may hold only `manifest.json`,
`plugin.js`, `icon.svg` and `LICENSE`.

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
