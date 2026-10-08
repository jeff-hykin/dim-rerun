# dim-rerun

A [dimOS Desktop](https://github.com/jeff-hykin/dimos-desktop) app that shows the **[Rerun](https://rerun.io) web
viewer** inside Desktop: a live stream, or a recording (`.rrd`).

```sh
dimos-desktop install https://github.com/jeff-hykin/dim-rerun
```

It frames a Rerun web viewer on Desktop's computer (port 9090; **Start a viewer** runs
`rerun --serve-web --bind
0.0.0.0 --port 9877`), reached the way the browser reached Desktop
(`http://<Desktop's host>:9090`, so a remote Desktop works too), showing the gRPC server on port 9877, where dimos's
Rerun bridge serves. **Settings** (the pill at the top; saved) picks another viewer port, host:port or URL, and another
gRPC server (a port or `rerun+http://…/proxy`), for a Rerun you run yourself. It frames the viewer only once the app's
server sees it running and this browser reaches it (`connects:` in dimos.yaml allows that check); otherwise it says
what's wrong and what to do.

## Endpoints

Every action is an HTTP endpoint (`backend/routes.ts`, served as `agent.json` and listed in `dimos.yaml`), so Desktop's
agent drives the app like the UI does:

| endpoint                   | what                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `GET api/state`            | the viewer framed, what it shows, the frame URL, whether the viewer is reachable         |
| `POST api/viewer`          | settings: viewer `port` (+ `host`, or `url`) and `grpc` (a port or `rerun+http` URL)     |
| `POST api/open`            | `url` (a `rerun+http://…/proxy` stream or an `.rrd` URL) or `path` (a local `.rrd` file) |
| `DELETE api/open`          | back to the default stream, the settings' gRPC server (`rerun+http://<host>:9877/proxy`) |
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
