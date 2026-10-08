// Every Rerun action, as an endpoint (http.ts). The UI calls these; so can Desktop's agent.
//
// The page runs Rerun's web viewer itself (@rerun-io/web-viewer, bundled: same origin as the page, so Desktop's
// shortcuts reach it) and points it at a source: by default a Rerun gRPC server on Desktop's machine
// (rerun+http://<host>:9877/proxy, where dimos's Rerun bridge serves), reached the way the browser reached Desktop:
// addresses say HOST and the page puts in its own location.hostname (never localhost, which is the browser's machine).
// Or another gRPC server (settings), or a recording (.rrd URL, or a local .rrd file this server hands out at
// api/recording). This server keeps the settings and source, checks the gRPC server answers, starts one on request,
// and says when anything changes: `stateChanged("state")` (frontend topic state/state, through Desktop's relay; the
// page re-GETs api/state).
import { HttpError, type Route, stateChanged } from "./http.ts"
import { dimosApp } from "./dimos_app.ts"

export const DESCRIPTION =
    "Rerun: Rerun's web viewer inside Desktop, on a live gRPC stream (dimos's Rerun bridge by default) or a recording (.rrd)"

/** dimos's Rerun bridge serves gRPC here (dimos/visualization/rerun/constants.py RERUN_GRPC_PORT) */
export const GRPC_PORT = "9877"
/** the page puts its own absolute base (…/apps/<name>/) in place of this, for sources this server serves */
export const SELF = "@app/"
/** the page puts the host the browser reached Desktop at (location.hostname) in place of this */
export const HOST = "@host"
const PROBE_TIMEOUT_MS = 2500
const READ_MESSAGES = "rerun.sdk_comms.v1alpha1.MessageProxyService/ReadMessages"

/** the gRPC server the viewer shows by default: a port on Desktop's machine, or a rerun+http(s) URL */
type Grpc = { port: string } | { url: string }
type Source = { kind: "default" } | { kind: "stream" | "url"; address: string } | { kind: "file"; path: string }

const dataDir = dimosApp.dataDir
const savedFile = dataDir ? `${dataDir}/settings.json` : null

function load(): { grpc: Grpc; source: Source } {
    const saved: { grpc?: Grpc; source?: Source } = {}
    try {
        if (savedFile) {
            Object.assign(saved, JSON.parse(Deno.readTextFileSync(savedFile)))
        }
    } catch {
        // first run
    }
    return { grpc: saved.grpc ?? { port: GRPC_PORT }, source: saved.source ?? { kind: "default" } }
}

let { grpc, source } = load()
/** whether the shown gRPC server answers (null: not checked yet, or the source is a recording) */
let reachable: boolean | null = null
let checkedAt: string | null = null
/** bumped by api/reconnect and a started server: pages reopen the source */
let reload = 0

/** the settings' gRPC server, rerun+http://HOST:<port>/proxy for a port */
export function grpcAddress(g: Grpc = grpc): string {
    return "url" in g ? g.url : `rerun+http://${HOST}:${g.port}/proxy`
}

/** what the viewer opens; SELF-prefixed for a local file */
export function sourceAddress(s: Source = source): string {
    switch (s.kind) {
        case "default":
            return grpcAddress()
        case "file":
            return `${SELF}api/recording/${encodeURIComponent(s.path.split("/").pop() ?? "recording.rrd")}`
        default:
            return s.address
    }
}

/** the gRPC server's plain http base as this server reaches it (HOST is this machine), null for a recording */
function grpcBase(): string | null {
    const address = sourceAddress()
    if (!/^rerun\+https?:\/\//i.test(address)) {
        return null
    }
    return address.replace(/^rerun\+/i, "").replace(`//${HOST}`, "//127.0.0.1").replace(/\/proxy\/?$/, "")
}

export function state() {
    return {
        grpc,
        source: { ...source, address: sourceAddress() },
        reachable,
        checkedAt,
        reload,
        hint:
            `${HOST} is the host the browser reached Desktop at. The default source is the gRPC server on Desktop's machine at :${GRPC_PORT} (dimos's Rerun bridge); POST api/server/start starts one there`,
        rerun: findRerun(),
    }
}

function changed() {
    stateChanged("state")
}

async function save() {
    if (savedFile) {
        await Deno.writeTextFile(savedFile, JSON.stringify({ grpc, source }))
    }
}

/** Is the shown gRPC server answering? (any HTTP response counts; a recording is always "null") */
export async function probe(): Promise<boolean | null> {
    const base = grpcBase()
    let ok: boolean | null = null
    if (base) {
        try {
            const response = await fetch(base, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
            await response.body?.cancel()
            ok = true
        } catch {
            ok = false
        }
    }
    if (base !== grpcBase()) {
        return ok // the source changed meanwhile: that change probes for itself
    }
    const before = reachable
    reachable = ok
    checkedAt = new Date().toISOString()
    if (before !== ok) {
        changed()
    }
    return ok
}

/** Whether the shown gRPC server lets a page at `origin` read it: Rerun's gRPC server allows only localhost origins
 * unless started with --cors-allow-origin, so from another machine the viewer gets no data. null = not a gRPC source,
 * or it doesn't answer. */
export async function grpcCheck(origin: string): Promise<{ address: string; allowed: boolean | null }> {
    const address = sourceAddress()
    const base = grpcBase()
    if (!base) {
        return { address, allowed: null }
    }
    try {
        const response = await fetch(`${base}/${READ_MESSAGES}`, {
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
        return { address, allowed: allow === "*" || allow === origin }
    } catch {
        return { address, allowed: null }
    }
}

/** main.ts keeps the reachability fresh while the app runs */
export function startProbing(everyMs = 3000) {
    probe()
    return setInterval(probe, everyMs)
}

// ── a gRPC server of our own ──
// When nothing serves the settings' port on this machine, api/server/start runs `rerun --serve-grpc` there: dimos's
// Rerun bridges started later send to it (they connect to a server already on their port), and it lets pages from any
// host read it, which a bridge's own server doesn't.
let started: { child: Deno.ChildProcess; port: string } | null = null

/** the rerun CLI: $RERUN_BIN, then dimos's (the version the bundled viewer and dimos's SDK speak), then PATH, … */
export function findRerun(): string | null {
    const home = Deno.env.get("HOME") ?? ""
    const dimosPython = dimosApp.dimosPython
    const candidates = [
        Deno.env.get("RERUN_BIN"),
        dimosPython ? `${dimosPython.replace(/\/[^/]+$/, "")}/rerun` : undefined,
        ...(Deno.env.get("PATH") ?? "").split(":").filter(Boolean).map((dir) => `${dir}/rerun`),
        `${home}/.cargo/bin/rerun`,
        "/opt/homebrew/bin/rerun",
        "/usr/local/bin/rerun",
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

/** Starts `rerun --serve-grpc` on the settings' port when nothing answers there; waits up to 15 s for it. */
export async function ensureServer(): Promise<{ started: boolean; reason?: string }> {
    if (source.kind === "file" || source.kind === "url") {
        return { started: false, reason: "a recording is open: it needs no gRPC server" }
    }
    if (await probe()) {
        return { started: false }
    }
    if (Deno.env.get("DIM_RERUN_NO_START")) {
        return { started: false, reason: "starting a server is off (DIM_RERUN_NO_START)" }
    }
    if (source.kind === "stream" || "url" in grpc) {
        return { started: false, reason: `the gRPC server is elsewhere (${sourceAddress()}): start it there` }
    }
    const rerun = findRerun()
    if (!rerun) {
        return { started: false, reason: "no rerun CLI here (pip install rerun-sdk, or cargo install rerun-cli)" }
    }
    const port = grpc.port
    if (!started || started.port !== port) {
        const child = new Deno.Command(rerun, {
            // every interface, and pages from any host may read it: a browser on another machine reaches it the way
            // it reaches Desktop
            args: [
                "--serve-grpc",
                "--port",
                port,
                "--bind",
                "0.0.0.0",
                "--cors-allow-origin",
                "http://*",
                "--cors-allow-origin",
                "https://*",
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
    return { started: false, reason: `started ${rerun} --serve-grpc, but :${port} didn't answer in 15 s` }
}

/** main.ts: the server this app started goes with it */
export async function stopStartedServer() {
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
            "Rerun's state: the settings' gRPC server, what the viewer shows (default stream, a stream address, a recording URL or local .rrd; @host = the host the browser reached Desktop at), and whether the gRPC server answers",
        role: "context",
        handler: () => state(),
    },
    {
        method: "POST",
        path: "api/settings",
        description:
            "The app's setting, saved: grpc, the Rerun gRPC server the viewer shows by default, a port on Desktop's machine (default 9877, where dimos's Rerun bridge serves) or a rerun+http(s)://host:port/proxy URL. Answers the new state",
        params: {
            grpc: {
                type: "string",
                required: true,
                description: "a port (default 9877) or rerun+http(s)://host:port/proxy",
            },
        },
        handler: async (args) => {
            const value = text(args.grpc) || GRPC_PORT
            if (/^\d{1,5}$/.test(value)) {
                grpc = { port: value }
            } else if (/^rerun\+https?:\/\//i.test(value) && URL.canParse(value)) {
                grpc = { url: value }
            } else {
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
            "Show something in the viewer: url = a live stream address (rerun+http://host:9877/proxy) or an http(s) .rrd recording URL; or path = a local .rrd file (served to the viewer by this app)",
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
            reachable = null
            await save()
            changed()
            await probe()
            return state()
        },
    },
    {
        method: "DELETE",
        path: "api/open",
        description: "Go back to the default live stream (the settings' gRPC server, rerun+http://<host>:9877/proxy)",
        handler: async () => {
            source = { kind: "default" }
            reachable = null
            await save()
            changed()
            await probe()
            return state()
        },
    },
    {
        method: "GET",
        path: "api/grpc/check",
        description:
            "Whether the shown gRPC server lets a page at origin read it (Rerun allows only localhost origins unless started with --cors-allow-origin); allowed null = it doesn't answer, or a recording is shown",
        params: {
            origin: {
                type: "string",
                required: true,
                description: "the page's origin as the browser reaches it, e.g. http://100.64.0.1:5555",
            },
        },
        handler: (args) => grpcCheck(text(args.origin)),
    },
    {
        method: "POST",
        path: "api/server/start",
        description:
            "Start a Rerun gRPC server on Desktop's machine (`rerun --serve-grpc` on the settings' port, any host may read it) when none answers there; dimos's Rerun bridges started later send to it",
        handler: async () => ({ ...(await ensureServer()), ...state() }),
    },
    {
        method: "POST",
        path: "api/reconnect",
        description: "Check the gRPC server again now and reopen the source in the viewer (when it restarted)",
        handler: async () => {
            reload++
            changed()
            await probe()
            return state()
        },
    },
    {
        method: "GET",
        path: "api/recording/{name}",
        description: "The local .rrd opened with api/open path, as bytes (what the viewer loads)",
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
                headers: { "content-type": "application/octet-stream", "content-length": String(size) },
            })
        },
    },
]
