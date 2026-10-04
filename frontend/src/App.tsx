// Rerun page: frames a Rerun web viewer (inner iframe) once the backend says it's reachable, so a down server never
// shows the browser's "unable to connect" page; once connected the controls collapse into a pill (click to edit).
// Every action is a backend endpoint (api.ts); state arrives from api/state + api/events/ws, so the agent's changes
// show here too.
import { useEffect, useState } from "react"
import { call, events } from "./api.ts"
import { ThemeToggle } from "./ThemeToggle.tsx"

type State = {
    viewer: { host: string; port: string } | { url: string }
    viewerOrigin: string
    source: { kind: string; address: string | null; path?: string }
    frameUrl: string
    reachable: boolean | null
    reload: number
}

/** the backend's "@app/" prefix → this page's own absolute base, so a viewer on another origin can fetch it */
function resolve(frameUrl: string): string {
    const self = new URL(".", location.href).href
    return frameUrl.replace(encodeURIComponent("@app/"), encodeURIComponent(self))
}

export function App() {
    const [state, setState] = useState<State | null>(null)
    const [host, setHost] = useState("")
    const [port, setPort] = useState("")
    const [source, setSource] = useState("")
    const [expanded, setExpanded] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const show = (next: State) => {
            setState(next)
            setHost("url" in next.viewer ? next.viewer.url : next.viewer.host)
            setPort("url" in next.viewer ? "" : next.viewer.port)
        }
        call<State>("GET", "api/state").then(show, (e) => setError(e.message))
        return events((event) => event.type === "state" && show(event as unknown as State))
    }, [])

    const act = (promise: Promise<unknown>) => promise.then(() => setError(null), (e) => setError(e.message))
    const connect = () => {
        setExpanded(false)
        act(call("POST", "api/viewer", { host, port }))
    }
    const open = () => {
        const value = source.trim()
        act(
            value.startsWith("/")
                ? call("POST", "api/open", { path: value })
                : value
                ? call("POST", "api/open", { url: value })
                : call("DELETE", "api/open"),
        )
    }

    const connected = state?.reachable === true
    const collapsed = connected && !expanded
    const src = connected && state ? resolve(state.frameUrl) : undefined
    return (
        <div className="frame-wrap">
            {src && (
                <iframe
                    key={`${src}#${state?.reload}`}
                    id="viewer"
                    title="Rerun viewer"
                    src={src}
                    allow="cross-origin-isolated; fullscreen; clipboard-read; clipboard-write"
                />
            )}

            <div className={`overlay${connected ? "" : " show"}`}>
                <div className="big">{state?.reachable === false ? "Connecting…" : "Looking for a Rerun viewer…"}</div>
                <div>
                    Waiting for a Rerun web viewer at <code>{state?.viewerOrigin ?? "…"}</code>. Start one with{" "}
                    <code>rerun --serve-web</code> (web on :9090). This keeps retrying.
                </div>
            </div>

            <div
                className={`panel dim-panel glass${collapsed ? " collapsed" : ""}`}
                onClick={() => collapsed && setExpanded(true)}
            >
                <span className="title">Rerun</span>
                <label className="dim-label">host</label>
                <input
                    className="dim-input dim-mono"
                    id="host"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && connect()}
                />
                <label className="dim-label">port</label>
                <input
                    className="dim-input dim-mono"
                    id="port"
                    type="text"
                    inputMode="numeric"
                    spellCheck={false}
                    autoComplete="off"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && connect()}
                />
                <button
                    type="button"
                    className="dim-btn primary"
                    id="connect"
                    onClick={(e) => (e.stopPropagation(), connect())}
                >
                    Connect
                </button>
                <label className="dim-label">open</label>
                <input
                    className="dim-input dim-mono"
                    id="source"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={state?.source.kind === "default"
                        ? "live stream (default)"
                        : ".rrd URL / path, rerun+http://…"}
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && open()}
                />
                <span className="stat" title={state?.source.address ?? ""}>
                    <span className={`dot${connected ? " on" : " err"}`} />
                    <span>
                        {connected
                            ? (state?.source.kind === "default" ? "connected" : `connected · ${state?.source.kind}`)
                            : "waiting…"}
                    </span>
                </span>
                {error && <span className="dim-alert danger">{error}</span>}
                <ThemeToggle />
            </div>
        </div>
    )
}
