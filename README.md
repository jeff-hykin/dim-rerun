# dim-rerun

A [dimOS Desktop](https://github.com/jeff-hykin/dimos-desktop) app that shows the **[Rerun](https://rerun.io) web
viewer** inside Desktop: a live stream, or a recording (`.rrd`).

```sh
rerun --serve-web     # web viewer on :9090, data proxy on :9876
dimos-desktop install https://github.com/jeff-hykin/dim-rerun
```

It connects to the last-used viewer (default `localhost:9090`) and frames it once it answers, retrying until then; once
connected the controls collapse into a pill (click it to edit).

## Endpoints

Every action is an HTTP endpoint (`backend/routes.ts`, served as `agent.json` and listed in `dimos.yaml`), so Desktop's
agent drives the app like the UI does:

| endpoint                   | what                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `GET api/state`            | the viewer framed, what it shows, the frame URL, whether the viewer is reachable         |
| `POST api/viewer`          | `host` + `port` (or `url`): connect to a Rerun web viewer                                |
| `POST api/open`            | `url` (a `rerun+http://…/proxy` stream or an `.rrd` URL) or `path` (a local `.rrd` file) |
| `DELETE api/open`          | back to the viewer's default stream (`rerun+http://<host>:9876/proxy`)                   |
| `POST api/reconnect`       | check the viewer again and reload the frame                                              |
| `GET api/recording/{name}` | the opened local `.rrd`'s bytes (what the viewer fetches)                                |

There is no `view` endpoint: the viewer is a cross-origin iframe, so neither the page nor the server can capture it.

## Development

```sh
deno task test && deno task check     # backend tests, dimos.yaml ↔ routes check
cd frontend && npm install && npm run typecheck && npm run build
deno task dev                         # backend on :8787; `npm run dev` in frontend proxies api/ to it
nix build .#dimosApp                  # what Desktop builds: bin/dimos-app-server
```

Licensed under Apache-2.0.
