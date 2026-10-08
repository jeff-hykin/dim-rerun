# dim-rerun

A [dimOS Desktop](https://github.com/jeff-hykin/dimos-desktop) app that runs the **[Rerun](https://rerun.io) web
viewer** inside Desktop: a live stream, or a recording (`.rrd`).

```sh
dimos-desktop install https://github.com/jeff-hykin/dim-rerun
```

The viewer is Rerun's own embeddable one (`@rerun-io/web-viewer`, pinned to dimos's `rerun-sdk` version), bundled into
the page: same origin as the app, so Desktop's shortcuts (Cmd+K) work with the viewer focused, and no
`rerun
--serve-web` is needed. It reads the Rerun gRPC server on Desktop's computer at port 9877 (where dimos's Rerun
bridge serves), reached the way the browser reached Desktop (`rerun+http://<Desktop's host>:9877/proxy`), so a remote
Desktop works too. **Settings** (the pill at the top; saved) points it at another gRPC server: a port, or
`rerun+http://host:port/proxy`. **Start a server** runs
`rerun --serve-grpc --bind 0.0.0.0 --cors-allow-origin 'http://*'` on that port, which blueprints started afterwards
send to.

When the server is down, unreachable from this browser, or only lets pages on its own computer read it (Rerun's default
CORS, e.g. a bridge's own server seen from another machine), the page says so and what to do. `connects:` in dimos.yaml
lets the page reach gRPC servers and `.rrd` URLs on any host.

## Endpoints

Every action is an HTTP endpoint (`backend/routes.ts`, served as `agent.json` and listed in `dimos.yaml`), so Desktop's
agent drives the app like the UI does:

| endpoint                   | what                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `GET api/state`            | the settings' gRPC server, what the viewer shows, whether the gRPC server answers        |
| `POST api/settings`        | `grpc`: a port on Desktop's computer (default 9877) or a `rerun+http://…/proxy` URL      |
| `POST api/open`            | `url` (a `rerun+http://…/proxy` stream or an `.rrd` URL) or `path` (a local `.rrd` file) |
| `DELETE api/open`          | back to the default stream, the settings' gRPC server                                    |
| `POST api/server/start`    | start a Rerun gRPC server on Desktop's computer, on the settings' port                   |
| `GET api/grpc/check`       | whether the shown gRPC server lets a page at `origin` read it                            |
| `POST api/reconnect`       | check the gRPC server again and reopen the source                                        |
| `GET api/recording/{name}` | the opened local `.rrd`'s bytes (what the viewer fetches)                                |

There is no `view` endpoint: the viewer draws on a WebGL/WebGPU canvas in the browser, which the server can't capture.

## Development

```sh
deno task test && deno task check     # backend tests, dimos.yaml ↔ routes check
cd frontend && npm install && npm run typecheck && npm run build
deno task dev                         # backend on :8787; `npm run dev` in frontend proxies api/ to it
nix build .#dimosApp                  # what Desktop builds: bin/dimos-app-server
```

Licensed under Apache-2.0.
