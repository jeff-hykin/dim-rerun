// Rerun page: runs Rerun's web viewer itself (@rerun-io/web-viewer, bundled, so it's this page's origin and Desktop's
// shortcuts like Cmd+K reach it) on the backend's source: a Rerun gRPC server, reached the way this browser reached
// Desktop (never localhost, which is the browser's own machine), or a recording. A gRPC server that's down, that this
// browser can't reach, or that won't let this page read it gets a message with what to do instead of a dead viewer.
// Every action is a backend endpoint (api.ts); state is api/state, re-read when the backend says it changed
// (useBackendState: zenoh topic state/state), so the agent's changes show here too.
import { useEffect, useRef, useState } from "react"
import { WebViewer } from "@rerun-io/web-viewer"
import {
    Alert,
    Button,
    ConnectionStatus,
    EmptyState,
    Hud,
    IconButton,
    Label,
    Spinner,
    TextInput,
    Toolbar,
    useBackendState,
    useZenoh,
} from "dimos-react"
import { call } from "./api.ts"
import { openApp } from "./dim-app/source/desktop.js"

type State = {
    grpc: { port: string } | { url: string }
    source: { kind: string; address: string; path?: string }
    /** whether the gRPC server answers the backend (null for a recording, or not checked yet) */
    reachable: boolean | null
    reload: number
    /** the rerun CLI this app can start a server with, null when there's none */
    rerun: string | null
}

/** the backend's "@app/" → this page's own absolute base; "@host" → the host this browser reached Desktop at */
function resolve(address: string): string {
    return address.replace(/^@app\//, new URL(".", location.href).href)
        .replaceAll("@host", location.hostname)
}

/** Whether this browser reaches `url` (any answer counts): true, false, null = not known yet, or "unchecked" when the
 * page's CSP forbids the check (then only the backend's counts). Re-checks every 5 s while it can't, and on `again`. */
function useBrowserReach(
    url: string | null,
    again: number,
): boolean | null | "unchecked" {
    const [reach, setReach] = useState<boolean | null | "unchecked">(null)
    useEffect(() => {
        setReach(null)
        if (!url) {
            return
        }
        let live = true
        let timer: number | undefined
        let blocked = false
        const onViolation = (e: SecurityPolicyViolationEvent) => {
            if (url.startsWith(e.blockedURI)) {
                blocked = true
            }
        }
        document.addEventListener("securitypolicyviolation", onViolation)
        const check = () =>
            fetch(url, {
                mode: "no-cors",
                cache: "no-store",
                signal: AbortSignal.timeout(4000),
            }).then(
                () => live && setReach(true),
                () => {
                    if (live) {
                        setReach(blocked ? "unchecked" : false)
                        if (!blocked) {
                            timer = setTimeout(check, 5000)
                        }
                    }
                },
            )
        check()
        return () => {
            live = false
            clearTimeout(timer)
            document.removeEventListener("securitypolicyviolation", onViolation)
        }
    }, [url, again])
    return reach
}

/** Rerun's viewer in `host`, started the first time `address` is set (its wasm is big) on it; a new address or reload
 * closes what it showed and opens that. */
function useRerunViewer(
    host: React.RefObject<HTMLDivElement | null>,
    address: string | null,
    reload: number,
) {
    const viewer = useRef<WebViewer | null>(null)
    const shown = useRef<{ address: string; reload: number } | null>(null)
    const [ready, setReady] = useState(false)
    const [failed, setFailed] = useState<string | null>(null)
    useEffect(() => {
        if (!address || viewer.current || !host.current) {
            return
        }
        const created = new WebViewer()
        viewer.current = created
        shown.current = { address, reload }
        created.start(address, host.current, {
            hide_welcome_screen: true,
            width: "100%",
            height: "100%",
        }).then(
            () => setReady(true),
            (e) => setFailed(e instanceof Error ? e.message : String(e)),
        )
    }, [address])
    useEffect(() => {
        const current = viewer.current
        const before = shown.current
        if (
            !ready || !current || !address ||
            (before?.address === address && before.reload === reload)
        ) {
            return
        }
        if (before) {
            current.close(before.address)
        }
        current.open(address, { follow_if_http: true })
        shown.current = { address, reload }
    }, [ready, address, reload])
    useEffect(() => () => viewer.current?.stop(), [])
    return { ready, failed }
}

export function App() {
    const [state, { error: stateError }] = useBackendState("state", {
        url: "api/state",
    }) as [
        State | undefined,
        { error: Error | null },
    ]
    const [grpcField, setGrpcField] = useState("")
    const [source, setSource] = useState("")
    const [expanded, setExpanded] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (state) {
            setGrpcField("url" in state.grpc ? state.grpc.url : state.grpc.port)
        }
    }, [state?.grpc])
    useEffect(() => setError(stateError?.message ?? null), [stateError])

    // whether a blueprint is running (Desktop's runs, live over its zenoh `runs` event): a viewer with nothing sending
    // to it gets a hint
    const [running, setRunning] = useState<boolean | null>(null)
    const [hintClosed, setHintClosed] = useState(false)
    const zenoh = useZenoh()
    useEffect(() => {
        const read = () =>
            fetch("../../gateways/dimos/active").then((r) => r.ok ? r.json() : null).then(
                (body) => setRunning(body ? body.running === true : null),
                () => setRunning(null),
            )
        read()
        const off = zenoh?.subscribeDesktop("runs", read)
        return () => {
            off?.()
        }
    }, [zenoh])

    const act = (promise: Promise<unknown>) => promise.then(() => setError(null), (e) => setError(e.message))
    const [starting, setStarting] = useState(false)
    const startServer = () => {
        setStarting(true)
        call<{ started: boolean; reason?: string }>("POST", "api/server/start")
            .then(
                (result) => setError(result.reason ?? null),
                (e) => setError(e.message),
            ).finally(() => setStarting(false))
    }
    const save = () => {
        setExpanded(false)
        act(call("POST", "api/settings", { grpc: grpcField.trim() }))
    }
    const [again, setAgain] = useState(0)
    const retry = () => {
        setAgain((n) => n + 1)
        act(call("POST", "api/reconnect"))
    }
    const openSettings = () => setExpanded(true)
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

    const address = state ? resolve(state.source.address) : null
    const grpcUrl = address && /^rerun\+https?:\/\//i.test(address)
        ? address.replace(/^rerun\+/i, "").replace(/\/proxy\/?$/, "")
        : null
    const hostPort = grpcUrl ? new URL(grpcUrl).host : ""
    const port = grpcUrl ? new URL(grpcUrl).port : ""
    // Desktop's machine: this app can start a server there
    const local = !!state && state.source.kind === "default" &&
        !("url" in state.grpc)

    // the backend sees the gRPC server answer; this browser checks it reaches it too (another machine may not), then
    // whether the server lets this page read it (Rerun allows only localhost pages by default)
    const reach = useBrowserReach(
        grpcUrl && state?.reachable ? grpcUrl : null,
        again + (state?.reload ?? 0),
    )
    const [allowed, setAllowed] = useState<boolean | null>(null)
    const corsKey = grpcUrl && reach !== false && reach !== null ? `${address}|${again}|${state?.reload}` : null
    useEffect(() => {
        setAllowed(null)
        if (!corsKey) {
            return
        }
        let live = true
        const check = () =>
            call<{ allowed: boolean | null }>(
                "GET",
                `api/grpc/check?origin=${encodeURIComponent(location.origin)}`,
            )
                .then((result) => live && setAllowed(result.allowed), () => {})
        check()
        const timer = setInterval(check, 10000)
        return () => {
            live = false
            clearInterval(timer)
        }
    }, [corsKey])

    const usable = !!state && (!grpcUrl ||
        (state.reachable === true && (reach === true || reach === "unchecked") &&
            allowed !== false))
    const host = useRef<HTMLDivElement>(null)
    const viewer = useRerunViewer(
        host,
        usable ? address : null,
        state?.reload ?? 0,
    )
    const connected = usable && viewer.ready

    type Action = { label: string; onClick: () => void; primary?: boolean }
    const settingsAction: Action = { label: "Settings", onClick: openSettings }
    const launcherAction: Action = {
        label: "Open the Launcher",
        onClick: () => openApp("launcher"),
    }
    type Empty = {
        testId: string
        tone?: "warn"
        busy?: boolean
        title: string
        body: string
        actions: Action[]
    }
    const empty: Empty = !state && stateError
        ? {
            testId: "onboard-backend-down",
            tone: "warn",
            title: "The Rerun app's server isn't answering",
            body: "Restarting the app usually fixes it: close it with ✕ and open it again.",
            actions: [{ label: "Try again", onClick: () => location.reload() }],
        }
        : viewer.failed
        ? {
            testId: "viewer-failed",
            tone: "warn",
            title: "Rerun's viewer couldn't start in this browser",
            body:
                `${viewer.failed}. It needs WebGL 2 or WebGPU: try another browser (Chrome, Firefox) or turn on hardware acceleration.`,
            actions: [{ label: "Try again", onClick: () => location.reload() }],
        }
        : state && grpcUrl && state.reachable === false
        ? local
            ? {
                testId: "onboard-no-server",
                title: "Nothing is serving Rerun data yet",
                body: state.rerun
                    ? `Nothing answers at ${hostPort}. Launch a blueprint with a Rerun bridge (it serves there), or start a server here that blueprints send to. Running your own Rerun server? Set its port in Settings.`
                    : `Nothing answers at ${hostPort}. Launch a blueprint with a Rerun bridge, which serves there. (There's no rerun command on this computer to start one here: pip install rerun-sdk into dimOS's Python.) Running your own Rerun server? Set its port in Settings.`,
                actions: [
                    ...(state.rerun
                        ? [{
                            label: starting ? "Starting…" : "Start a server",
                            onClick: startServer,
                            primary: true,
                        }]
                        : []),
                    launcherAction,
                    settingsAction,
                ],
            }
            : {
                testId: "onboard-no-server",
                tone: "warn",
                title: "The Rerun server doesn't answer",
                body:
                    `Nothing answers at ${hostPort}. Start it on that machine (rerun --serve-grpc --cors-allow-origin 'http://*'), or change it in Settings. This page keeps looking, so it shows up by itself.`,
                actions: [
                    { label: "Try again", onClick: retry, primary: true },
                    settingsAction,
                ],
            }
        : state && grpcUrl && state.reachable && reach === false
        ? {
            testId: "grpc-unreachable",
            tone: "warn",
            title: "This browser can't reach the Rerun server",
            body: local
                ? `A Rerun server is running on Desktop's computer, but this browser gets no answer from ${hostPort}. A firewall there may block port ${port}, or the server only listens on that computer itself: restart it with --bind 0.0.0.0. Or set another port in Settings.`
                : `This browser gets no answer from ${hostPort}. Check that machine is reachable from here (same network or tailnet, port ${port} open), or change it in Settings.`,
            actions: [
                { label: "Try again", onClick: retry, primary: true },
                settingsAction,
            ],
        }
        : state && grpcUrl && allowed === false
        ? {
            testId: "grpc-refused",
            tone: "warn",
            title: "The Rerun server won't let this page read it",
            body: local
                ? `The server at ${hostPort} only lets pages on its own computer read it (Rerun's default, as a blueprint's Rerun bridge starts it). Stop the blueprint, press Start a server here, then launch the blueprint again: it sends to this app's server, which any browser may read. Or restart your own server with --cors-allow-origin 'http://*'.`
                : `The server at ${hostPort} only lets pages on its own computer read it (Rerun's default). Restart it with --cors-allow-origin 'http://*', or change it in Settings.`,
            actions: [
                { label: "Try again", onClick: retry, primary: true },
                ...(local ? [launcherAction] : []),
                settingsAction,
            ],
        }
        : {
            testId: "onboard-looking",
            busy: true,
            title: usable ? "Loading Rerun's viewer" : "Looking for a Rerun server",
            body: usable ? "The first load takes a few seconds." : `Checking ${hostPort || "…"}`,
            actions: [settingsAction],
        }

    const status = connected
        ? (state?.source.kind === "default" ? "connected" : `connected · ${state?.source.kind}`)
        : "waiting…"

    return (
        // the viewer (and Rerun's own timeline at its bottom) ends above Desktop's dock
        <div
            style={{
                position: "fixed",
                inset: 0,
                bottom: "var(--dim-inset-bottom)",
                background: "var(--bg)",
            }}
        >
            <div
                ref={host}
                data-testid="viewer"
                style={{ width: "100%", height: "100%" }}
            />

            {!connected && (
                <EmptyState
                    layer
                    data-testid={empty.testId}
                    tone={empty.tone}
                    icon={empty.busy ? null : empty.tone === "warn" ? "warn" : "info"}
                    title={empty.title}
                    message={empty.body}
                    actions={empty.actions.map((action) => (
                        <Button
                            key={action.label}
                            size="sm"
                            variant={action.primary ? "primary" : "default"}
                            onClick={action.onClick}
                        >
                            {action.label}
                        </Button>
                    ))}
                >
                    {empty.busy && <Spinner label={empty.title} />}
                </EmptyState>
            )}

            {connected && running === false && state?.source.kind === "default" &&
                !hintClosed && (
                <Hud position="bottom">
                    <Alert
                        tone="info"
                        data-testid="onboard-nothing-sending"
                        onClose={() => setHintClosed(true)}
                        actions={
                            <Button
                                size="sm"
                                variant="primary"
                                onClick={() => openApp("launcher")}
                            >
                                Open the Launcher
                            </Button>
                        }
                    >
                        Nothing is sending to Rerun yet: launch a blueprint with a Rerun bridge.
                    </Alert>
                </Hud>
            )}

            <Hud position="top" data-testid="settings">
                <Toolbar floating>
                    {/* inside Desktop, its window bar already names the app */}
                    {self.parent === self && <Label>Rerun</Label>}
                    <ConnectionStatus
                        state={connected ? "connected" : stateError ? "lost" : "connecting"}
                        label={status}
                        title={address ?? ""}
                    />
                    {expanded
                        ? (
                            <>
                                <Label title="the Rerun gRPC server the viewer shows">
                                    gRPC
                                </Label>
                                <TextInput
                                    id="grpc"
                                    size="sm"
                                    mono
                                    spellCheck={false}
                                    autoComplete="off"
                                    placeholder="9877"
                                    title="the Rerun gRPC server to show: a port on Desktop's computer (9877 = dimos's Rerun bridge) or rerun+http://host:port/proxy"
                                    style={{ width: 120 }}
                                    value={grpcField}
                                    onChange={setGrpcField}
                                    onEnter={save}
                                />
                                <Button
                                    id="save"
                                    size="sm"
                                    variant="primary"
                                    icon="save"
                                    onClick={save}
                                >
                                    Save
                                </Button>
                                <Label>open</Label>
                                <TextInput
                                    id="source"
                                    size="sm"
                                    mono
                                    spellCheck={false}
                                    autoComplete="off"
                                    style={{ width: 220 }}
                                    placeholder={state?.source.kind === "default"
                                        ? "live stream (default)"
                                        : ".rrd URL / path, rerun+http://…"}
                                    value={source}
                                    onChange={setSource}
                                    onEnter={open}
                                />
                                <IconButton
                                    icon="close"
                                    size="sm"
                                    label="Close settings"
                                    onClick={() => setExpanded(false)}
                                />
                            </>
                        )
                        : (
                            <Button
                                size="sm"
                                variant="ghost"
                                icon="settings"
                                onClick={openSettings}
                            >
                                Settings
                            </Button>
                        )}
                </Toolbar>
                {error && state && <Alert tone="danger" onClose={() => setError(null)}>{error}</Alert>}
            </Hud>
        </div>
    )
}
