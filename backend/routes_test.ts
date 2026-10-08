import { assert, assertEquals } from "@std/assert"
import { handle } from "./http.ts"
import { DESCRIPTION, routes, stopStartedViewer } from "./routes.ts"

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

Deno.test("api/state: Desktop's machine (HOST, the browser's name for it) :9090 on dimos's gRPC :9877", async () => {
    const { json } = await call("GET", "api/state")
    assertEquals([json.viewer, json.grpc], [{ host: "", port: "9090" }, { port: "9877" }])
    assertEquals(json.viewerOrigin, "http://@host:9090")
    assertEquals(json.frameUrl, `http://@host:9090/?url=${encodeURIComponent("rerun+http://@host:9877/proxy")}`)
    assertEquals((await call("GET", "api/states")).status, 404)
})

Deno.test("api/viewer: a reachable viewer (a stand-in server) and an unreachable one", async () => {
    const server = Deno.serve({ port: 0, onListen: () => {} }, () => new Response("rerun"))
    const { port } = server.addr as Deno.NetAddr
    // localhost is Desktop's machine: the browser reaches it at HOST, this server probes 127.0.0.1
    const up = await call("POST", "api/viewer", { host: "localhost", port: String(port) })
    assertEquals([up.json.reachable, up.json.viewer], [true, { host: "", port: String(port) }])
    assertEquals(up.json.viewerOrigin, `http://@host:${port}`)
    assertEquals((await call("POST", "api/viewer", { host: `127.0.0.1:${port}` })).json.viewer.port, String(port))
    await server.shutdown()
    assertEquals((await call("POST", "api/reconnect")).json.reachable, false)
    assertEquals((await call("POST", "api/viewer", { host: "bad host!" })).status, 400)
    assertEquals((await call("POST", "api/viewer", { url: "ftp://x" })).status, 400)
    const full = await call("POST", "api/viewer", { url: "http://127.0.0.1:1/?url=rerun%2Bhttp%3A%2F%2Fx%3A1%2Fproxy" })
    assertEquals(full.json.frameUrl, "http://127.0.0.1:1/?url=rerun%2Bhttp%3A%2F%2Fx%3A1%2Fproxy")
    const robot = await call("POST", "api/viewer", { host: "robot.local", port: "9091" })
    assertEquals(
        robot.json.frameUrl,
        `http://robot.local:9091/?url=${encodeURIComponent("rerun+http://robot.local:9877/proxy")}`,
    )
    await call("POST", "api/viewer", { port: "9090" })
})

Deno.test("api/viewer grpc: the gRPC server the viewer shows, a port or a rerun+http URL", async () => {
    const port = await call("POST", "api/viewer", { port: "9090", grpc: "9876" })
    assertEquals(port.json.grpc, { port: "9876" })
    assert(port.json.frameUrl.endsWith(encodeURIComponent("rerun+http://@host:9876/proxy")))
    const url = await call("POST", "api/viewer", { port: "9090", grpc: "rerun+http://robot:9877/proxy" })
    assert(url.json.frameUrl.endsWith(encodeURIComponent("rerun+http://robot:9877/proxy")))
    // left out: kept
    assertEquals((await call("POST", "api/viewer", { port: "9090" })).json.grpc, {
        url: "rerun+http://robot:9877/proxy",
    })
    assertEquals((await call("POST", "api/viewer", { grpc: "http://x" })).status, 400)
    await call("POST", "api/viewer", { port: "9090", grpc: "9877" })
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
