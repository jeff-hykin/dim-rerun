// Rerun page: frames a Rerun web viewer (inner iframe) once the backend says it's running and this browser can reach it
// (a no-cors fetch, dimos.yaml connects:), so a down or unreachable viewer never shows the browser's "unable to connect"
// page but a message with what to do; once connected the settings collapse into a pill (click to edit).
// Every action is a backend endpoint (api.ts); state is api/state, re-read when the backend says it changed (useBackendState: zenoh topic state/state), so the agent's changes
// show here too.
import { useEffect, useState } from "react";
import { call } from "./api.ts";
import { EmptyState, useBackendState } from "./dim-app/source/react.js";
import { openApp } from "./dim-app/source/desktop.js";
import { getZenoh } from "./dim-app/source/zenoh.js";

type State = {
  /** host "" = Desktop's machine */
  viewer: { host: string; port: string } | { url: string };
  grpc: { port: string } | { url: string };
  viewerOrigin: string;
  source: { kind: string; address: string | null; path?: string };
  frameUrl: string;
  reachable: boolean | null;
  reload: number;
  /** the rerun CLI this app can start a viewer with, null when there's none */
  rerun: string | null;
};

/** the backend's "@app/" → this page's own absolute base, so a viewer on another origin can fetch it; "@host" → the
 * host this browser reached Desktop at (Desktop's machine: never localhost, which is the browser's own) */
function resolve(url: string): string {
  const self = new URL(".", location.href).href;
  return url.replace(encodeURIComponent("@app/"), encodeURIComponent(self))
    .replaceAll("@host", location.hostname)
    .replaceAll(
      encodeURIComponent("@host"),
      encodeURIComponent(location.hostname),
    );
}

/** the settings' viewer field: a port (Desktop's machine), host:port, or a URL */
function viewerText(viewer: State["viewer"]): string {
  return "url" in viewer
    ? viewer.url
    : viewer.host
    ? `${viewer.host}:${viewer.port}`
    : viewer.port;
}

function viewerArgs(text: string): Record<string, string> {
  const value = text.trim();
  return /^\d+$/.test(value)
    ? { port: value }
    : /^https?:\/\//i.test(value)
    ? { url: value }
    : { host: value };
}

/** Whether this browser reaches `origin` (any answer counts): true, false, null = not known yet, or "unchecked" when
 * the page's CSP forbids the check (then only the backend's counts). Re-checks every 5 s while it can't, and on `again`. */
function useBrowserReach(
  origin: string | null,
  again: number,
): boolean | null | "unchecked" {
  const [reach, setReach] = useState<boolean | null | "unchecked">(null);
  useEffect(() => {
    setReach(null);
    if (!origin) {
      return;
    }
    let live = true;
    let timer: number | undefined;
    let blocked = false;
    const onViolation = (e: SecurityPolicyViolationEvent) => {
      if (e.blockedURI.startsWith(origin)) {
        blocked = true;
      }
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    const check = () =>
      fetch(origin, {
        mode: "no-cors",
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      }).then(
        () => live && setReach(true),
        () => {
          if (live) {
            setReach(blocked ? "unchecked" : false);
            if (!blocked) {
              timer = setTimeout(check, 5000);
            }
          }
        },
      );
    check();
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("securitypolicyviolation", onViolation);
    };
  }, [origin, again]);
  return reach;
}

export function App() {
  const [state, { error: stateError }] = useBackendState<State>("api/state");
  const [viewerField, setViewerField] = useState("");
  const [grpcField, setGrpcField] = useState("");
  const [source, setSource] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state) {
      setViewerField(viewerText(state.viewer));
      setGrpcField("url" in state.grpc ? state.grpc.url : state.grpc.port);
    }
  }, [state]);
  useEffect(() => setError(stateError?.message ?? null), [stateError]);

  // whether a blueprint is running (Desktop's runs, live over its zenoh `runs` event): a viewer with nothing sending
  // to it gets a hint
  const [running, setRunning] = useState<boolean | null>(null);
  const [hintClosed, setHintClosed] = useState(false);
  useEffect(() => {
    const read = () =>
      fetch("../../dimos/runs").then((r) => r.ok ? r.json() : null).then(
        (body) => setRunning(body ? (body.runs ?? []).length > 0 : null),
        () => setRunning(null),
      );
    read();
    const off = getZenoh().subscribeDesktop("runs", read);
    return () => {
      off();
    };
  }, []);

  const act = (promise: Promise<unknown>) =>
    promise.then(() => setError(null), (e) => setError(e.message));
  const [starting, setStarting] = useState(false);
  const startViewer = () => {
    setStarting(true);
    call<{ started: boolean; reason?: string }>("POST", "api/viewer/start")
      .then(
        (result) => setError(result.reason ?? null),
        (e) => setError(e.message),
      ).finally(() => setStarting(false));
  };
  const save = () => {
    setExpanded(false);
    act(
      call("POST", "api/viewer", {
        ...viewerArgs(viewerField),
        grpc: grpcField.trim(),
      }),
    );
  };
  const [again, setAgain] = useState(0);
  const retry = () => {
    setAgain((n) => n + 1);
    act(call("POST", "api/reconnect"));
  };
  const openSettings = () => setExpanded(true);
  const open = () => {
    const value = source.trim();
    act(
      value.startsWith("/")
        ? call("POST", "api/open", { path: value })
        : value
        ? call("POST", "api/open", { url: value })
        : call("DELETE", "api/open"),
    );
  };

  const origin = state ? resolve(state.viewerOrigin) : null;
  // the backend sees the viewer running; this browser checks it can reach it too (another machine may not)
  const reach = useBrowserReach(
    state?.reachable ? origin : null,
    again + (state?.reload ?? 0),
  );
  const unreachable = state?.reachable === true && reach === false;
  const connected = state?.reachable === true &&
    (reach === true || reach === "unchecked");
  const local = !!state && !("url" in state.viewer) && !state.viewer.host;
  const collapsed = !expanded;
  const src = connected && state ? resolve(state.frameUrl) : undefined;
  // the gRPC server the viewer reads: does it answer, and does it let the viewer (at origin, as this browser reaches it)
  // read it? Re-checked every 10 s while connected; the viewer itself is cross-origin, so the backend asks for us
  type Grpc = {
    address: string | null;
    reachable: boolean | null;
    allowed: boolean | null;
  };
  const [grpc, setGrpc] = useState<Grpc | null>(null);
  const [grpcClosed, setGrpcClosed] = useState(false);
  const grpcKey = connected && state
    ? `${origin}|${state.source.address}|${state.reload}|${again}`
    : null;
  useEffect(() => {
    setGrpc(null);
    setGrpcClosed(false);
    if (!grpcKey || !origin) {
      return;
    }
    let live = true;
    const check = () =>
      call<Grpc>("GET", `api/viewer/grpc?origin=${encodeURIComponent(origin)}`)
        .then(
          (result) => live && setGrpc(result),
          () => {},
        );
    check();
    const timer = setInterval(check, 10000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [grpcKey]);
  const grpcShown = grpc?.address ? resolve(grpc.address) : "";
  const viewerPort = origin ? new URL(origin).port || "80" : "9090";
  const grpcProblem = !grpc || grpcClosed ? null : grpc.reachable === false
    ? {
      testId: "grpc-down",
      text:
        `Nothing answers at ${grpcShown}: no Rerun gRPC server is running there. Launch a blueprint with a Rerun bridge, or set the gRPC port of your own server in Settings.`,
    }
    : grpc.allowed === false
    ? {
      testId: "grpc-refused",
      text:
        `The Rerun gRPC server at ${grpcShown} only lets viewers on its own computer read it (Rerun's default), so this viewer gets no data. Restart it with --cors-allow-origin 'http://*:${viewerPort}', or stop it and use Start a viewer here.`,
    }
    : null;

  const settingsAction = { label: "Settings", onClick: openSettings };
  const empty = !state && stateError
    ? {
      testId: "onboard-backend-down",
      label: "Server not answering",
      tone: "warn" as const,
      title: "The Rerun app's server isn't answering",
      body:
        "Restarting the app usually fixes it: close it with ✕ and open it again.",
      actions: [{ label: "Try again", onClick: () => location.reload() }],
    }
    : unreachable
    ? {
      testId: "viewer-unreachable",
      label: "Can't reach the viewer",
      tone: "warn" as const,
      title: "This browser can't reach the Rerun viewer",
      body: local
        ? `A Rerun viewer is running on Desktop's computer, but this browser gets no answer from ${origin}. A firewall on that computer may block port ${
          "port" in state.viewer ? state.viewer.port : ""
        }, or the viewer only listens on that computer itself: restart it there with rerun --serve-web --bind 0.0.0.0. Or point this app at another viewer port in Settings.`
        : `This browser gets no answer from ${origin}. Check that the viewer's machine is on and reachable from here (same network or tailnet, port open), or change the viewer in Settings.`,
      actions: [{ label: "Try again", onClick: retry }, settingsAction],
    }
    : state && state.reachable === false && !state.rerun && local
    ? {
      testId: "onboard-no-rerun",
      label: "Rerun not installed",
      tone: "warn" as const,
      title: "Rerun isn't installed",
      body:
        `There's no rerun command on this computer. Install it into dimOS's Python (pip install rerun-sdk), or launch a blueprint with a Rerun bridge, which starts a viewer for you. Waiting for a viewer at ${origin}.`,
      actions: [
        { label: "Open the Launcher", app: "launcher" },
        settingsAction,
      ],
    }
    : state && state.reachable === false
    ? {
      testId: "onboard-no-viewer",
      label: "No viewer",
      title: "No Rerun viewer is running",
      body: local
        ? `Start one here; blueprints with a Rerun bridge send to it. This page keeps looking at ${origin}, so a viewer started elsewhere shows up by itself. Running your own? Set its port in Settings.`
        : `Nothing answers at ${origin}. Start rerun --serve-web on that machine, or change the viewer in Settings. This page keeps looking, so it shows up by itself.`,
      actions: local
        ? [{
          label: starting ? "Starting…" : "Start a viewer",
          onClick: startViewer,
        }, settingsAction]
        : [{ label: "Try again", onClick: retry }, settingsAction],
    }
    : {
      testId: "onboard-looking",
      label: "Looking for a viewer",
      busy: true,
      title: "Looking for a Rerun viewer",
      body: `Checking ${origin ?? "…"}`,
      actions: [settingsAction],
    };

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
        {!connected && <EmptyState {...empty} />}
        {error && <div className="dim-alert warn">{error}</div>}
      </div>

      {connected && grpcProblem && (
        <div
          className="dim-alert warn nothing-sending"
          data-testid={grpcProblem.testId}
        >
          <span>{grpcProblem.text}</span>
          <button
            type="button"
            className="dim-btn sm primary"
            onClick={openSettings}
          >
            Settings
          </button>
          <button type="button" className="dim-btn sm ghost" onClick={retry}>
            Try again
          </button>
          <button
            type="button"
            className="dim-btn sm ghost"
            onClick={() => setGrpcClosed(true)}
          >
            Dismiss
          </button>
        </div>
      )}

      {connected && !grpcProblem && running === false &&
        state?.source.kind === "default" && !hintClosed && (
        <div
          className="dim-alert info nothing-sending"
          data-testid="onboard-nothing-sending"
        >
          <span>
            Nothing is sending to Rerun yet: launch a blueprint with a Rerun
            bridge.
          </span>
          <button
            type="button"
            className="dim-btn sm primary"
            onClick={() => openApp("launcher")}
          >
            Open the Launcher
          </button>
          <button
            type="button"
            className="dim-btn sm ghost"
            onClick={() => setHintClosed(true)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div
        className={`panel dim-panel glass${collapsed ? " collapsed" : ""}`}
        onClick={() => collapsed && setExpanded(true)}
        data-testid="settings"
      >
        {/* inside Desktop, its window bar already names the app */}
        {self.parent === self && <span className="title dim-title">Rerun</span>}
        <label
          className="dim-label"
          htmlFor="viewer-port"
          title="the Rerun web viewer (rerun --serve-web)"
        >
          viewer
        </label>
        <input
          className="dim-input dim-mono"
          id="viewer-port"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="9090"
          title="a port on Desktop's computer (9090), host:port of another machine, or a viewer URL"
          value={viewerField}
          onChange={(e) => setViewerField(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <label
          className="dim-label"
          htmlFor="grpc"
          title="the Rerun gRPC server the viewer shows"
        >
          gRPC
        </label>
        <input
          className="dim-input dim-mono"
          id="grpc"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="9877"
          title="the Rerun gRPC server to show: a port on the viewer's machine (9877 = dimos's Rerun bridge) or rerun+http://host:port/proxy"
          value={grpcField}
          onChange={(e) => setGrpcField(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button
          type="button"
          className="dim-btn primary"
          id="save"
          onClick={(e) => (e.stopPropagation(), save())}
        >
          Save
        </button>
        <label className="dim-label" htmlFor="source">open</label>
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
        <span
          className="stat"
          title={state?.source.address ? resolve(state.source.address) : ""}
        >
          <span className={`dot${connected ? " on" : " err"}`} />
          <span>
            {connected
              ? (state?.source.kind === "default"
                ? "connected"
                : `connected · ${state?.source.kind}`)
              : unreachable
              ? "unreachable"
              : "waiting…"}
          </span>
        </span>
        {collapsed && <span className="settings-link">⚙ Settings</span>}
        {error && <span className="dim-alert danger">{error}</span>}
      </div>
    </div>
  );
}
