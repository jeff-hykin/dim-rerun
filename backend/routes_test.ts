import { assert, assertEquals } from "@std/assert"
import { handle } from "./http.ts"
import { DESCRIPTION, proxyViewer, routes, stopStartedViewer } from "./routes.ts"

const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle(
        new Request(`http://app/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
        routes,
        DESCRIPTION,
    )
    const text = await response!.text()
    let json
    try {
        json = JSON.parse(text)
    } catch {
        json = text
    }
    return { status: response!.status, json, headers: response!.headers }
}

Deno.test("api/state: localhost:9090 on the default stream", async () => {
    const { json } = await call("GET", "api/state")
    assertEquals(json.viewer, { host: "localhost", port: "9090" })
    const source = `?url=${encodeURIComponent("rerun+http://localhost:9876/proxy")}`
    assertEquals([json.viewerUrl, json.frameUrl], [`http://localhost:9090/${source}`, `@app/viewer/${source}`])
    assertEquals((await call("GET", "api/states")).status, 404)
})

Deno.test("api/viewer: a reachable viewer (a stand-in server) and an unreachable one", async () => {
    const server = Deno.serve({ port: 0, onListen: () => {} }, () => new Response("rerun"))
    const { port } = server.addr as Deno.NetAddr
    const up = await call("POST", "api/viewer", { host: "127.0.0.1", port: String(port) })
    assertEquals(up.json.reachable, true)
    assertEquals(up.json.viewerOrigin, `http://127.0.0.1:${port}`)
    await server.shutdown()
    assertEquals((await call("POST", "api/reconnect")).json.reachable, false)
    assertEquals((await call("POST", "api/viewer", { host: "bad host!" })).status, 400)
    assertEquals((await call("POST", "api/viewer", { url: "ftp://x" })).status, 400)
    const full = await call("POST", "api/viewer", { url: "http://127.0.0.1:1/?url=rerun%2Bhttp%3A%2F%2Fx%3A1%2Fproxy" })
    assertEquals(full.json.viewerUrl, "http://127.0.0.1:1/?url=rerun%2Bhttp%3A%2F%2Fx%3A1%2Fproxy")
    assertEquals(full.json.frameUrl, "@app/viewer/?url=rerun%2Bhttp%3A%2F%2Fx%3A1%2Fproxy")
    const page = await call("POST", "api/viewer", { url: "https://h/v/0.32/index.html?url=x" })
    assertEquals(page.json.frameUrl, "@app/viewer/index.html?url=x")
    await call("POST", "api/viewer", { host: "localhost", port: "9090" })
})

Deno.test("api/open: a stream, a recording URL, a local file; DELETE goes back to the default", async () => {
    const stream = await call("POST", "api/open", { url: "rerun+http://robot:9876/proxy" })
    assertEquals(stream.json.source.kind, "stream")
    assert(stream.json.frameUrl.endsWith(encodeURIComponent("rerun+http://robot:9876/proxy")))
    assertEquals((await call("POST", "api/open", { url: "https://x/a.rrd" })).json.source.kind, "url")
    const path = await Deno.makeTempFile({ suffix: ".rrd" })
    await Deno.writeTextFile(path, "RRF2")
    const file = await call("POST", "api/open", { path })
    assertEquals(file.json.source.kind, "file")
    assert(file.json.frameUrl.includes(encodeURIComponent("@app/api/recording")))
    const bytes = await call("GET", "api/recording/a.rrd")
    assertEquals([bytes.json, bytes.headers.get("access-control-allow-origin")], ["RRF2", "*"])
    assertEquals((await call("POST", "api/open", { url: "ftp://nope" })).status, 400)
    assertEquals((await call("POST", "api/open", { path: "/no/such.rrd" })).status, 404)
    assertEquals((await call("DELETE", "api/open")).json.source.kind, "default")
    assertEquals((await call("GET", "api/recording/a.rrd")).status, 404)
    await Deno.remove(path)
})

Deno.test("viewer/: the viewer's files from this app's origin (its frame is same-origin, so its keys reach Desktop)", async () => {
    const server = Deno.serve({ port: 0, onListen: () => {} }, (request) => {
        const url = new URL(request.url)
        return url.pathname === "/re_viewer_bg.wasm"
            ? new Response("wasm" + url.search, { headers: { "content-type": "application/wasm", "x-other": "1" } })
            : new Response("missing", { status: 404 })
    })
    const { port } = server.addr as Deno.NetAddr
    try {
        await call("POST", "api/viewer", { host: "127.0.0.1", port: String(port) })
        const wasm = await proxyViewer("re_viewer_bg.wasm", "?v=1")
        assertEquals([await wasm.text(), wasm.headers.get("content-type"), wasm.headers.get("x-other")], [
            "wasm?v=1",
            "application/wasm",
            null,
        ])
        const missing = await proxyViewer("nope.js", "")
        assertEquals([missing.status, await missing.text()], [404, "missing"])
    } finally {
        await server.shutdown()
    }
    await call("POST", "api/viewer", { host: "127.0.0.1", port: "1" })
    const down = await proxyViewer("", "")
    await down.body?.cancel()
    assertEquals(down.status, 502)
    await call("POST", "api/viewer", { host: "localhost", port: "9090" })
})

Deno.test("agent.json lists every route", async () => {
    const { json } = await call("GET", "agent.json")
    assertEquals(json.endpoints.length, routes.length)
})

Deno.test("api/open starts a viewer on this machine when none answers (a stand-in rerun CLI)", async () => {
    const dir = await Deno.makeTempDir()
    const fake = `${dir}/rerun`
    // `rerun --serve-web --web-viewer-port <port> ...` → any web server on that port will do
    await Deno.writeTextFile(fake, `#!/bin/sh\nexec python3 -m http.server --bind 127.0.0.1 "$3"\n`)
    await Deno.chmod(fake, 0o755)
    const rrd = `${dir}/a.rrd`
    await Deno.writeTextFile(rrd, "RRF2")
    const listener = Deno.listen({ port: 0 })
    const port = String((listener.addr as Deno.NetAddr).port)
    listener.close()
    Deno.env.set("RERUN_BIN", fake)
    Deno.env.delete("DIM_RERUN_NO_START")
    try {
        assertEquals((await call("POST", "api/viewer", { host: "127.0.0.1", port })).json.reachable, false)
        const opened = await call("POST", "api/open", { path: rrd })
        assertEquals(opened.json.viewerStart, { started: true })
        assertEquals((await call("GET", "api/state")).json.reachable, true)
        // already up: nothing more to start
        assertEquals((await call("POST", "api/viewer/start")).json.started, false)
    } finally {
        await stopStartedViewer()
        Deno.env.delete("RERUN_BIN")
    }
})
