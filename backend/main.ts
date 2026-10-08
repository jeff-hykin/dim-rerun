// dimos-app-server: this app's API and its built frontend on the unix socket Desktop gives, else a port. What Desktop
// passes: the DIMOS_APP env var, one JSON object and the whole interface (docs/apps.md; dimos_app.ts).
import { dimosApp } from "./dimos_app.ts"
import { handle } from "./http.ts"
import { DESCRIPTION, proxyViewer, routes, startProbing, stopStartedViewer, VIEWER_PATH } from "./routes.ts"

function flag(name: string): string | undefined {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}

const frontend = flag("frontend") ?? new URL("../frontend/dist", import.meta.url).pathname
const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript",
    css: "text/css",
    svg: "image/svg+xml",
    png: "image/png",
    json: "application/json",
    wasm: "application/wasm",
}

async function file(path: string): Promise<Response> {
    const clean = path.split("/").filter((part) => part && part !== "..").join("/") || "index.html"
    for (const candidate of [clean, "index.html"]) {
        try {
            const bytes = await Deno.readFile(`${frontend}/${candidate}`)
            const type = types[candidate.split(".").pop() ?? ""] ?? "application/octet-stream"
            return new Response(bytes, { headers: { "content-type": type } })
        } catch {
            // next candidate: unknown paths get the app (hash routing)
        }
    }
    return new Response("not found", { status: 404 })
}

async function serve(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/+/, "")
    if (path.startsWith(VIEWER_PATH)) {
        return proxyViewer(path.slice(VIEWER_PATH.length), url.search)
    }
    return (await handle(request, routes, DESCRIPTION)) ?? file(url.pathname)
}

startProbing()
// a viewer this app started stops with it (Desktop stops an app with SIGTERM)
for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, async () => {
        await stopStartedViewer()
        Deno.exit(0)
    })
}

const socket = dimosApp.socket
if (socket) {
    try {
        Deno.removeSync(socket)
    } catch {
        // not there
    }
    Deno.serve({ path: socket, transport: "unix", onListen: () => console.error(`listening on ${socket}`) }, serve)
} else {
    Deno.serve({ port: Number(flag("port") ?? 8787) }, serve)
}
