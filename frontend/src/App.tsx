// Rerun page: frames a Rerun web viewer (inner iframe) once the backend says it's reachable, so a down server never
// shows the browser's "unable to connect" page; once connected the controls collapse into a pill (click to edit).
// Every action is a backend endpoint (api.ts); state is api/state, re-read when the backend says it changed (useBackendState: zenoh topic state/state), so the agent's changes
// show here too.
import { useEffect, useState } from "react"
import { call } from "./api.ts"
import { EmptyState, useBackendState } from "./dim-app/source/react.js"
import { openApp } from "./dim-app/source/desktop.js"
import { getZenoh } from "./dim-app/source/zenoh.js"

type State = {
    viewer: { host: string; port: string } | { url: string }
    viewerOrigin: string
    source: { kind: string; address: string | null; path?: string }
    frameUrl: string
    reachable: boolean | null
    reload: number
    /** the rerun CLI this app can start a viewer with, null when there's none */
    rerun: string | null
}

/** the backend's "@app/" prefix → this page's own absolute base, so a viewer on another origin can fetch it */
function resolve(frameUrl: string): string {
    const self = new URL(".", location.href).href
    return frameUrl.replace(encodeURIComponent("@app/"), encodeURIComponent(self))
}

export function App() {
    const [state, { error: stateError }] = useBackendState<State>("api/state")
    const [host, setHost] = useState("")
    const [port, setPort] = useState("")
    const [source, setSource] = useState("")
    const [expanded, setExpanded] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (state) {
            setHost("url" in state.viewer ? state.viewer.url : state.viewer.host)
            setPort("url" in state.viewer ? "" : state.viewer.port)
        }
    }, [state])
    useEffect(() => setError(stateError?.message ?? null), [stateError])

    // whether a blueprint is running (Desktop's runs, live over its zenoh `runs` event): a viewer with nothing sending
    // to it gets a hint
    const [running, setRunning] = useState<boolean | null>(null)
    const [hintClosed, setHintClosed] = useState(false)
    useEffect(() => {
        const read = () =>
            fetch("../../dimos/runs").then((r) => r.ok ? r.json() : null).then(
                (body) => setRunning(body ? (body.runs ?? []).length > 0 : null),
                () => setRunning(null),
            )
        read()
        const off = getZenoh().subscribeDesktop("runs", read)
        return () => {
            off()
        }
    }, [])

    const act = (promise: Promise<unknown>) => promise.then(() => setError(null), (e) => setError(e.message))
    const [starting, setStarting] = useState(false)
    const startViewer = () => {
        setStarting(true)
        call<{ started: boolean; reason?: string }>("POST", "api/viewer/start").then(
            (result) => setError(result.reason ?? null),
            (e) => setError(e.message),
        ).finally(() => setStarting(false))
    }
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
                {!connected && (
                    <EmptyState
                        {...(!state && stateError
                            ? {
                                testId: "onboard-backend-down",
                                label: "Server not answering",
                                tone: "warn" as const,
                                title: "The Rerun app's server isn't answering",
                                body: "Restarting the app usually fixes it: close it with ✕ and open it again.",
                                actions: [{ label: "Try again", onClick: () => location.reload() }],
                            }
                            : state && !state.rerun
                            ? {
                                testId: "onboard-no-rerun",
                                label: "Rerun not installed",
                                tone: "warn" as const,
                                title: "Rerun isn't installed",
                                body:
                                    `There's no rerun command on this computer. Install it into dimOS's Python (pip install rerun-sdk), or launch a blueprint with a Rerun bridge, which starts a viewer for you. Waiting for a viewer at ${state.viewerOrigin}.`,
                                actions: [{
                                    label: "Open the Launcher",
                                    app: "launcher",
                                }],
                            }
                            : {
                                testId: "onboard-no-viewer",
                                label: state?.reachable === null || !state ? "Looking for a viewer" : "No viewer",
                                busy: state?.reachable === null || !state,
                                title: "No Rerun viewer is running",
                                body:
                                    `Start one here; blueprints with a Rerun bridge send to it. This page keeps looking at ${
                                        state?.viewerOrigin ?? "…"
                                    }, so a viewer started elsewhere shows up by itself.`,
                                actions: [{ label: starting ? "Starting…" : "Start a viewer", onClick: startViewer }],
                            })}
                    />
                )}
                {error && <div className="dim-alert warn">{error}</div>}
            </div>

            {connected && running === false && state?.source.kind === "default" && !hintClosed && (
                <div className="dim-alert info nothing-sending" data-testid="onboard-nothing-sending">
                    <span>Nothing is sending to Rerun yet: launch a blueprint with a Rerun bridge.</span>
                    <button
                        type="button"
                        className="dim-btn sm primary"
                        onClick={() =>
                            openApp("launcher")}
                    >
                        Open the Launcher
                    </button>
                    <button
                        type="button"
                        className="dim-btn sm ghost"
                        onClick={() =>
                            setHintClosed(true)}
                    >
                        Dismiss
                    </button>
                </div>
            )}

            <div
                className={`panel dim-panel glass${collapsed ? " collapsed" : ""}`}
                onClick={() => collapsed && setExpanded(true)}
            >
                {/* inside Desktop, its window bar already names the app */}
                {window.parent === window && <span className="title dim-title">Rerun</span>}
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
            </div>
        </div>
    )
}
