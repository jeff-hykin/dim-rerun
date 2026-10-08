// Every Rerun action, as an endpoint (http.ts). The UI calls these; so can Desktop's agent.
//
// The page frames a Rerun web viewer (`rerun --serve-web`, :9090) in an iframe, pointed at a source with `?url=`: by
// default the viewer host's gRPC server (rerun+http://<host>:9877/proxy, where dimos's Rerun bridge serves), or a
// recording (.rrd URL, or a local .rrd file this server hands out at api/recording). The viewer is on Desktop's
// machine unless the settings name another host, and the browser reaches it the way it reached Desktop: frame URLs say
// HOST and the page puts in its own location.hostname (never localhost, which is the browser's machine). This server
// keeps the target, checks the viewer is reachable (so the page never frames a connection error) and says when it
// changes: `stateChanged("state")` (frontend topic state/state, through Desktop's relay; the page re-GETs api/state).
import { HttpError, type Route, stateChanged } from "./http.ts"
import { dimosApp } from "./dimos_app.ts"

export const DESCRIPTION =
    "Rerun: shows a Rerun web viewer (rerun --serve-web) inside Desktop, on a live stream or a recording (.rrd)"

export const VIEWER_PORT = "9090"
/** dimos's Rerun bridge serves gRPC here (dimos/visualization/rerun/constants.py RERUN_GRPC_PORT) */
export const GRPC_PORT = "9877"
/** the page puts its own absolute base (…/apps/<name>/) in place of this, for sources this server serves */
export const SELF = "@app/"
/** the page puts the host the browser reached Desktop at (location.hostname) in place of this */
export const HOST = "@host"
const PROBE_TIMEOUT_MS = 2500

/** host "" = Desktop's machine, as the browser reaches it */
type Viewer = { host: string; port: string } | { url: string }
/** the gRPC server the viewer shows by default: a port on the viewer's machine, or a rerun+http(s) URL */
type Grpc = { port: string } | { url: string }
type Source = { kind: "default" } | { kind: "stream" | "url"; address: string } | { kind: "file"; path: string }

const dataDir = dimosApp.dataDir
const savedFile = dataDir ? `${dataDir}/target.json` : null

const LOOPBACK = ["", "localhost", "127.0.0.1", "::1", "[::1]"]

function load(): { viewer: Viewer; grpc: Grpc; source: Source } {
    const saved: { viewer?: Viewer; grpc?: Grpc; source?: Source } = {}
    try {
        if (savedFile) {
            Object.assign(saved, JSON.parse(Deno.readTextFileSync(savedFile)))
        }
    } catch {
        // first run
    }
    return {
        viewer: saved.viewer ?? { host: "", port: VIEWER_PORT },
        grpc: saved.grpc ?? { port: GRPC_PORT },
        source: saved.source ?? { kind: "default" },
    }
}

let { viewer, grpc, source } = load()
let reachable: boolean | null = null
let checkedAt: string | null = null
/** bumped by api/reconnect: pages reload the viewer frame */
let reload = 0

/** Desktop's machine: a viewer there is reached at the browser's HOST, and this server starts and probes it locally */
export const isLocal = (v: Viewer = viewer) => !("url" in v) && LOOPBACK.includes(v.host.split(":")[0])

/** the viewer's plain http origin as the browser reaches it (HOST for Desktop's machine) */
export function viewerOrigin(v: Viewer = viewer): string {
    if ("url" in v) {
        try {
            return new URL(v.url).origin
        } catch {
            return v.url
        }
    }
    return `http://${isLocal(v) ? HOST : v.host}${v.port ? `:${v.port}` : ""}`
}

/** what this server probes: Desktop's machine is 127.0.0.1 from here */
function probeOrigin(): string {
    return viewerOrigin().replace(`//${HOST}`, "//127.0.0.1")
}

function viewerHost(v: Viewer): string {
    return "url" in v
        ? (URL.canParse(v.url) ? new URL(v.url).hostname : HOST)
        : isLocal(v)
        ? HOST
        : v.host.split(":")[0]
}

/** the gRPC server's address, rerun+http://<viewer host>:<port>/proxy for a port */
export function grpcAddress(v: Viewer = viewer, g: Grpc = grpc): string {
    return "url" in g ? g.url : `rerun+http://${viewerHost(v)}:${g.port}/proxy`
}

/** what the viewer is told to show (its `?url=`); SELF-prefixed for a local file */
export function sourceAddress(v: Viewer = viewer, s: Source = source): string | null {
    switch (s.kind) {
        case "default":
            return "url" in v && v.url.includes("?") ? null : grpcAddress(v)
        case "file":
            return `${SELF}api/recording/${encodeURIComponent(s.path.split("/").pop() ?? "recording.rrd")}`
        default:
            return s.address
    }
}

/** the iframe's src */
export function frameUrl(v: Viewer = viewer, s: Source = source): string {
    const address = sourceAddress(v, s)
    if ("url" in v && (v.url.includes("?") && s.kind === "default")) {
        return v.url
    }
    const base = "url" in v ? v.url.split("?")[0] : `${viewerOrigin(v)}/`
    return address ? `${base}?url=${encodeURIComponent(address)}` : base
}

export function state() {
    return {
        viewer,
        grpc,
        viewerOrigin: viewerOrigin(),
        source: { ...source, address: sourceAddress() },
        frameUrl: frameUrl(),
        reachable,
        checkedAt,
        reload,
        hint:
            `${HOST} is the host the browser reached Desktop at. Opening something starts a viewer on Desktop's machine (\`rerun --serve-web\`, web viewer on :${VIEWER_PORT}, gRPC on :${GRPC_PORT}); POST api/viewer/start does it now`,
        rerun: findRerun(),
    }
}

function changed() {
    stateChanged("state")
}

async function save() {
    if (savedFile) {
        await Deno.writeTextFile(savedFile, JSON.stringify({ viewer, grpc, source }))
    }
}

/** Is the viewer's web server answering? (any HTTP response counts) */
export async function probe(): Promise<boolean> {
    const origin = probeOrigin()
    let ok = false
    try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        await response.body?.cancel()
        ok = true
    } catch {
        ok = false
    }
    if (origin !== probeOrigin()) {
        return ok // the target changed meanwhile: that change probes for itself
    }
    const before = reachable
    reachable = ok
    checkedAt = new Date().toISOString()
    if (before !== ok) {
        changed()
    }
    return ok
}

/** Whether the gRPC server the viewer is told to show answers, and lets a viewer at `origin` (as the browser reaches
 * it) read it: Rerun's gRPC server allows only localhost origins unless started with --cors-allow-origin, so from
 * another machine the viewer loads but gets no data. null = not a gRPC source (a recording). */
export async function grpcCheck(
    origin: string,
): Promise<{ address: string | null; reachable: boolean | null; allowed: boolean | null }> {
    const address = sourceAddress()
    if (!address || !/^rerun\+https?:\/\//i.test(address)) {
        return { address, reachable: null, allowed: null }
    }
    const base = address.replace(/^rerun\+/i, "").replace(`//${HOST}`, "//127.0.0.1").replace(/\/proxy\/?$/, "")
    try {
        const response = await fetch(`${base}/rerun.sdk_comms.v1alpha1.MessageProxyService/ReadMessages`, {
            method: "OPTIONS",
            headers: {
                origin,
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type,x-grpc-web",
            },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        await response.body?.cancel()
        const allow = response.headers.get("access-control-allow-origin")
        return { address, reachable: true, allowed: allow === "*" || allow === origin }
    } catch {
        return { address, reachable: false, allowed: null }
    }
}

/** main.ts keeps the reachability fresh while the app runs */
export function startProbing(everyMs = 3000) {
    probe()
    return setInterval(probe, everyMs)
}

// ── a viewer of our own ──
// Opening something while the framed viewer is down (the usual case: nobody started `rerun --serve-web`) starts one,
// when the target is this machine and a `rerun` CLI is here: $RERUN_BIN, PATH, ~/.cargo/bin, the dimos venv.
let started: { child: Deno.ChildProcess; port: string } | null = null

export function findRerun(): string | null {
    const home = Deno.env.get("HOME") ?? ""
    const dimosPython = dimosApp.dimosPython
    const candidates = [
        Deno.env.get("RERUN_BIN"),
        ...(Deno.env.get("PATH") ?? "").split(":").filter(Boolean).map((dir) => `${dir}/rerun`),
        `${home}/.cargo/bin/rerun`,
        "/opt/homebrew/bin/rerun",
        "/usr/local/bin/rerun",
        dimosPython ? `${dimosPython.replace(/\/[^/]+$/, "")}/rerun` : undefined,
    ]
    for (const candidate of candidates) {
        try {
            if (candidate && Deno.statSync(candidate).isFile) {
                return candidate
            }
        } catch {
            // not here
        }
    }
    return null
}

/** Starts `rerun --serve-web` on the viewer's port when it isn't answering; waits up to 15 s for it. */
export async function ensureViewer(): Promise<{ started: boolean; reason?: string }> {
    if (await probe()) {
        return { started: false }
    }
    if (Deno.env.get("DIM_RERUN_NO_START")) {
        return { started: false, reason: "starting a viewer is off (DIM_RERUN_NO_START)" }
    }
    if (!isLocal(viewer)) {
        return { started: false, reason: `the viewer is on another machine (${viewerOrigin()}): start it there` }
    }
    const rerun = findRerun()
    if (!rerun) {
        return { started: false, reason: "no rerun CLI here (pip install rerun-sdk, or cargo install rerun-cli)" }
    }
    const port = "url" in viewer ? VIEWER_PORT : viewer.port || VIEWER_PORT
    // every interface, so a browser on another machine reaches it the way it reaches Desktop; gRPC on the settings'
    // port (dimos's bridge port by default: a bridge started later sends to it; one already there keeps it, and the web
    // viewer still starts)
    const grpcPort = "port" in grpc ? grpc.port : GRPC_PORT
    if (!started || started.port !== port) {
        const child = new Deno.Command(rerun, {
            // its gRPC server lets the viewer read it from any host (Rerun allows only localhost origins by default)
            args: [
                "--serve-web",
                "--web-viewer-port",
                port,
                "--port",
                grpcPort,
                "--bind",
                "0.0.0.0",
                "--cors-allow-origin",
                `http://*:${port}`,
            ],
            stdin: "null",
            stdout: "null",
            stderr: "null",
        }).spawn()
        started = { child, port }
        child.status.then(() => {
            if (started?.child === child) {
                started = null
            }
        })
    }
    for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (await probe()) {
            reload++
            changed()
            return { started: true }
        }
    }
    return { started: false, reason: `started ${rerun} --serve-web, but :${port} didn't answer in 15 s` }
}

/** main.ts: the viewer this app started goes with it */
export async function stopStartedViewer() {
    const child = started?.child
    if (child) {
        try {
            child.kill("SIGTERM")
        } catch {
            // already gone
        }
        await child.status
    }
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : value === undefined ? "" : String(value))

export const routes: Route[] = [
    {
        method: "GET",
        path: "api/state",
        description:
            "Rerun's state: which web viewer it frames (host:port or URL), what that viewer shows (default stream, a stream address, a recording URL or local .rrd), the frame URL, and whether the viewer is reachable",
        role: "context",
        handler: () => state(),
    },
    {
        method: "POST",
        path: "api/viewer",
        description:
            "The app's settings: which Rerun web viewer it frames and the gRPC server that viewer shows. Viewer: port (default 9090) of `rerun --serve-web` on Desktop's machine, or host + port of one elsewhere, or url, a full viewer URL (its own ?url= is kept). grpc: the Rerun gRPC server to show, a port on the viewer's machine (default 9877, where dimos's Rerun bridge serves) or a rerun+http(s)://…/proxy URL. Saved; answers whether the viewer is reachable",
        params: {
            host: { type: "string", description: "viewer host (or host:port); empty = Desktop's machine" },
            port: { type: "string", description: "viewer web port (default 9090)" },
            url: { type: "string", description: "a full http(s) viewer URL instead of host/port" },
            grpc: {
                type: "string",
                description: "the gRPC server it shows: a port (default 9877) or rerun+http(s)://host:port/proxy",
            },
        },
        handler: async (args) => {
            const url = text(args.url)
            if (url) {
                if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) {
                    throw new HttpError(400, "url must be an http(s) URL of a Rerun web viewer")
                }
                viewer = { url }
            } else {
                // host:port is split, so Desktop's machine keeps its port when its name becomes HOST
                const [, hostPart, portPart] = text(args.host).match(/^([^:\[\]]*):(\d{1,5})$/) ??
                    [, text(args.host), ""]
                const host = hostPart
                const port = text(args.port) || portPart || VIEWER_PORT
                if (/^https?:\/\//i.test(host)) {
                    viewer = { url: host }
                } else if ((host && !/^[\w.\-\[\]:]+$/.test(host)) || (port && !/^\d{1,5}$/.test(port))) {
                    throw new HttpError(400, "host must be a hostname (or host:port) and port a number")
                } else {
                    viewer = { host: LOOPBACK.includes(host) ? "" : host, port }
                }
            }
            const grpcArg = text(args.grpc)
            if (/^\d{1,5}$/.test(grpcArg)) {
                grpc = { port: grpcArg }
            } else if (/^rerun\+https?:\/\//i.test(grpcArg) && URL.canParse(grpcArg)) {
                grpc = { url: grpcArg }
            } else if (grpcArg) {
                throw new HttpError(400, "grpc must be a port number or rerun+http(s)://host:port/proxy")
            }
            reachable = null
            await save()
            changed()
            await probe()
            return state()
        },
    },
    {
        method: "POST",
        path: "api/open",
        description:
            "Show something in the viewer: url = a live stream address (rerun+http://host:9877/proxy) or an http(s) .rrd recording URL; or path = a local .rrd file (served to the viewer by this app). Starts a local viewer (rerun --serve-web) first when none is answering",
        params: {
            url: { type: "string", description: "rerun+http(s):// stream address, or http(s) URL of a .rrd" },
            path: { type: "string", description: "absolute path of a local .rrd file" },
        },
        handler: async (args) => {
            const url = text(args.url)
            const path = text(args.path)
            if (url && path) {
                throw new HttpError(400, "give url or path, not both")
            }
            if (path) {
                if (!path.startsWith("/") || !path.endsWith(".rrd")) {
                    throw new HttpError(400, "path must be an absolute path to a .rrd file")
                }
                try {
                    if (!(await Deno.stat(path)).isFile) {
                        throw new Error()
                    }
                } catch {
                    throw new HttpError(404, `no such file: ${path}`)
                }
                source = { kind: "file", path }
            } else if (/^rerun\+https?:\/\//i.test(url)) {
                source = { kind: "stream", address: url }
            } else if (/^https?:\/\//i.test(url) && URL.canParse(url)) {
                source = { kind: "url", address: url }
            } else {
                throw new HttpError(
                    400,
                    "url must be rerun+http(s)://… (a stream) or http(s)://… (a .rrd), or give path",
                )
            }
            await save()
            changed()
            const viewerStart = await ensureViewer()
            return { ...state(), viewerStart }
        },
    },
    {
        method: "GET",
        path: "api/viewer/grpc",
        description:
            "Whether the gRPC server the viewer shows answers and lets a viewer at origin read it (Rerun allows only localhost origins unless started with --cors-allow-origin)",
        params: {
            origin: {
                type: "string",
                required: true,
                description: "the viewer's origin as the browser reaches it, e.g. http://100.64.0.1:9090",
            },
        },
        handler: (args) => grpcCheck(text(args.origin)),
    },
    {
        method: "POST",
        path: "api/viewer/start",
        description:
            "Start a Rerun web viewer on this machine (`rerun --serve-web` on the viewer port) when the framed one isn't answering; api/open does this by itself",
        handler: async () => ({ ...(await ensureViewer()), ...state() }),
    },
    {
        method: "DELETE",
        path: "api/open",
        description:
            "Go back to the viewer's default live stream (the settings' gRPC server, rerun+http://<viewer host>:9877/proxy)",
        handler: async () => {
            source = { kind: "default" }
            await save()
            changed()
            return state()
        },
    },
    {
        method: "POST",
        path: "api/reconnect",
        description: "Check the viewer again now and reload its frame (when it was restarted or shows stale data)",
        handler: async () => {
            reload++
            changed()
            const ok = await probe()
            return { ...state(), reachable: ok }
        },
    },
    {
        method: "GET",
        path: "api/recording/{name}",
        description:
            "The local .rrd opened with api/open path, as bytes (what the viewer loads; CORS-open so a viewer on another port can fetch it)",
        params: {
            name: {
                type: "string",
                required: true,
                description: "the file's name (the viewer goes by its .rrd extension)",
            },
        },
        handler: async () => {
            if (source.kind !== "file") {
                throw new HttpError(404, "no local recording is open (api/open with path)")
            }
            const file = await Deno.open(source.path).catch(() => {
                throw new HttpError(404, `the recording is gone: ${source.kind === "file" ? source.path : ""}`)
            })
            const { size } = await file.stat()
            return new Response(file.readable, {
                headers: {
                    "content-type": "application/octet-stream",
                    "content-length": String(size),
                    "access-control-allow-origin": "*",
                },
            })
        },
    },
]
