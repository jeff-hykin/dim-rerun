// Every Rerun action, as an endpoint (http.ts). The UI calls these; so can Desktop's agent.
//
// The page frames a Rerun web viewer (`rerun --serve-web`, :9090) in an iframe, pointed at a source with `?url=`: by
// default the viewer host's gRPC data proxy (rerun+http://<host>:9876/proxy), or a recording (.rrd URL, or a local .rrd
// file this server hands out at api/recording). This server keeps the target, checks the viewer is reachable (so the
// page never frames a connection error) and says when it changes: `stateChanged("state")` (frontend topic state/state,
// through Desktop's relay; the page re-GETs api/state).
import { HttpError, type Route, stateChanged } from "./http.ts"
import { dimosApp } from "./dimos_app.ts"

export const DESCRIPTION =
    "Rerun: shows a Rerun web viewer (rerun --serve-web) inside Desktop, on a live stream or a recording (.rrd)"

export const DATA_PORT = 9876
/** the page puts its own absolute base (…/apps/<name>/) in place of this, for sources this server serves */
export const SELF = "@app/"
const PROBE_TIMEOUT_MS = 2500

type Viewer = { host: string; port: string } | { url: string }
type Source = { kind: "default" } | { kind: "stream" | "url"; address: string } | { kind: "file"; path: string }

const dataDir = dimosApp.dataDir
const savedFile = dataDir ? `${dataDir}/target.json` : null

function load(): { viewer: Viewer; source: Source } {
    try {
        if (savedFile) {
            return JSON.parse(Deno.readTextFileSync(savedFile))
        }
    } catch {
        // first run
    }
    return { viewer: { host: "localhost", port: "9090" }, source: { kind: "default" } }
}

let { viewer, source } = load()
let reachable: boolean | null = null
let checkedAt: string | null = null
/** bumped by api/reconnect: pages reload the viewer frame */
let reload = 0

/** the viewer's plain http origin, what the probe checks */
export function viewerOrigin(v: Viewer = viewer): string {
    if ("url" in v) {
        try {
            return new URL(v.url).origin
        } catch {
            return v.url
        }
    }
    return `http://${v.host}${v.port ? `:${v.port}` : ""}`
}

function viewerHost(v: Viewer): string {
    return "url" in v ? (URL.canParse(v.url) ? new URL(v.url).hostname : "localhost") : v.host.split(":")[0]
}

/** what the viewer is told to show (its `?url=`); SELF-prefixed for a local file */
export function sourceAddress(v: Viewer = viewer, s: Source = source): string | null {
    switch (s.kind) {
        case "default":
            return "url" in v && v.url.includes("?") ? null : `rerun+http://${viewerHost(v)}:${DATA_PORT}/proxy`
        case "file":
            return `${SELF}api/recording/${encodeURIComponent(s.path.split("/").pop() ?? "recording.rrd")}`
        default:
            return s.address
    }
}

/** the viewer's page URL (what `rerun --serve-web` serves, or the given URL), with its source */
export function viewerUrl(v: Viewer = viewer, s: Source = source): string {
    const address = sourceAddress(v, s)
    if ("url" in v && (v.url.includes("?") && s.kind === "default")) {
        return v.url
    }
    const base = "url" in v ? v.url.split("?")[0] : `${viewerOrigin(v)}/`
    return address ? `${base}?url=${encodeURIComponent(address)}` : base
}

/** the folder of the viewer's page: what VIEWER_PATH proxies */
function viewerDir(v: Viewer = viewer): string {
    return new URL(".", viewerUrl(v, { kind: "default" }).split("?")[0]).href
}

/** where this app serves the viewer's files from its own origin (proxy, below) */
export const VIEWER_PATH = "viewer/"

/** the iframe's src: the viewer through this app (same origin as the page, so its keys reach Desktop: Cmd+K) */
export function frameUrl(v: Viewer = viewer, s: Source = source): string {
    return `${SELF}${VIEWER_PATH}${new URL(viewerUrl(v, s)).href.slice(viewerDir(v).length)}`
}

/**
 * The viewer's own files (its page, re_viewer.js, the wasm) served from this app's origin: a frame on the viewer's
 * port is another origin, whose keys never reach the page or Desktop (Cmd+K, Alt shortcuts while the viewer has
 * focus). The viewer streams its data from the data proxy (:9876) itself, as before.
 */
export async function proxyViewer(rest: string, search: string): Promise<Response> {
    let response: Response
    try {
        response = await fetch(new URL(`${rest}${search}`, viewerDir()), { signal: AbortSignal.timeout(30_000) })
    } catch (error) {
        return new Response(`the Rerun viewer at ${viewerOrigin()} isn't answering: ${error}`, { status: 502 })
    }
    const headers = new Headers()
    for (const name of ["content-type", "cache-control", "etag", "last-modified"]) {
        const value = response.headers.get(name)
        if (value) {
            headers.set(name, value)
        }
    }
    return new Response(response.body, { status: response.status, headers })
}

export function state() {
    return {
        viewer,
        viewerOrigin: viewerOrigin(),
        source: { ...source, address: sourceAddress() },
        frameUrl: frameUrl(),
        viewerUrl: viewerUrl(),
        reachable,
        checkedAt,
        reload,
        hint:
            "opening something starts a viewer here (`rerun --serve-web`, web viewer on :9090, data proxy on :9876); POST api/viewer/start does it now",
        rerun: findRerun(),
    }
}

function changed() {
    stateChanged("state")
}

async function save() {
    if (savedFile) {
        await Deno.writeTextFile(savedFile, JSON.stringify({ viewer, source }))
    }
}

/** Is the viewer's web server answering? (any HTTP response counts) */
export async function probe(): Promise<boolean> {
    const origin = viewerOrigin()
    let ok = false
    try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        await response.body?.cancel()
        ok = true
    } catch {
        ok = false
    }
    if (origin !== viewerOrigin()) {
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

const isLocal = (v: Viewer) =>
    !("url" in v) && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(v.host.split(":")[0])

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
    const port = "url" in viewer ? "9090" : viewer.port || "9090"
    if (!started || started.port !== port) {
        const child = new Deno.Command(rerun, {
            args: ["--serve-web", "--web-viewer-port", port, "--port", String(DATA_PORT)],
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
            "Connect to a Rerun web viewer (the UI's host/port + Connect): host and port of `rerun --serve-web` (default port 9090), or url, a full viewer URL (its own ?url= is kept). Answers whether it is reachable",
        params: {
            host: { type: "string", description: "viewer host, e.g. localhost (or host:port)" },
            port: { type: "string", description: "viewer web port (default 9090)" },
            url: { type: "string", description: "a full http(s) viewer URL instead of host/port" },
        },
        handler: async (args) => {
            const url = text(args.url)
            if (url) {
                if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) {
                    throw new HttpError(400, "url must be an http(s) URL of a Rerun web viewer")
                }
                viewer = { url }
            } else {
                const host = text(args.host) || "localhost"
                const port = text(args.port) || (host.includes(":") ? "" : "9090")
                if (/^https?:\/\//i.test(host)) {
                    viewer = { url: host }
                } else if (!/^[\w.\-\[\]:]+$/.test(host) || (port && !/^\d{1,5}$/.test(port))) {
                    throw new HttpError(400, "host must be a hostname (or host:port) and port a number")
                } else {
                    viewer = { host, port }
                }
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
            "Show something in the viewer: url = a live stream address (rerun+http://host:9876/proxy) or an http(s) .rrd recording URL; or path = a local .rrd file (served to the viewer by this app). Starts a local viewer (rerun --serve-web) first when none is answering",
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
        method: "POST",
        path: "api/viewer/start",
        description:
            "Start a Rerun web viewer on this machine (`rerun --serve-web` on the viewer port) when the framed one isn't answering; api/open does this by itself",
        handler: async () => ({ ...(await ensureViewer()), ...state() }),
    },
    {
        method: "DELETE",
        path: "api/open",
        description: "Go back to the viewer's default live stream (rerun+http://<viewer host>:9876/proxy)",
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
