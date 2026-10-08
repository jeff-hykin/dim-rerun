import { assert, assertEquals } from "@std/assert"
import { handle } from "./http.ts"
import { DESCRIPTION, routes, stopStartedServer } from "./routes.ts"

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

const freePort = () => {
    const listener = Deno.listen({ port: 0 })
    const port = String((listener.addr as Deno.NetAddr).port)
    listener.close()
    return port
}

Deno.test("api/state: dimos's gRPC :9877 on Desktop's machine (HOST, the browser's name for it)", async () => {
    const { json } = await call("GET", "api/state")
    assertEquals(json.grpc, { port: "9877" })
    assertEquals(json.source, { kind: "default", address: "rerun+http://@host:9877/proxy" })
    assertEquals((await call("GET", "api/states")).status, 404)
})

Deno.test("api/settings: a port or a rerun+http URL; whether it answers (a stand-in server)", async () => {
    const server = Deno.serve({ port: 0, onListen: () => {} }, () => new Response("grpc"))
    const port = String((server.addr as Deno.NetAddr).port)
    const up = await call("POST", "api/settings", { grpc: port })
    assertEquals([up.json.reachable, up.json.source.address], [true, `rerun+http://@host:${port}/proxy`])
    await server.shutdown()
    assertEquals((await call("POST", "api/reconnect")).json.reachable, false)
    const url = await call("POST", "api/settings", { grpc: "rerun+http://robot:9877/proxy" })
    assertEquals(url.json.source.address, "rerun+http://robot:9877/proxy")
    assertEquals((await call("POST", "api/settings", { grpc: "http://x" })).status, 400)
    assertEquals((await call("POST", "api/settings", {})).status, 400)
    await call("POST", "api/settings", { grpc: "9877" })
})

Deno.test("api/open: a stream, a recording URL, a local file; DELETE goes back to the default", async () => {
    const stream = await call("POST", "api/open", { url: "rerun+http://robot:9877/proxy" })
    assertEquals(stream.json.source, { kind: "stream", address: "rerun+http://robot:9877/proxy" })
    const url = await call("POST", "api/open", { url: "https://x/a.rrd" })
    assertEquals([url.json.source.kind, url.json.reachable], ["url", null])
    const path = await Deno.makeTempFile({ suffix: ".rrd" })
    await Deno.writeTextFile(path, "RRF2")
    const file = await call("POST", "api/open", { path })
    assertEquals(file.json.source.address, `@app/api/recording/${encodeURIComponent(path.split("/").pop()!)}`)
    assertEquals((await call("GET", "api/recording/a.rrd")).json, "RRF2")
    assertEquals((await call("POST", "api/open", { url: "ftp://nope" })).status, 400)
    assertEquals((await call("POST", "api/open", { path: "/no/such.rrd" })).status, 404)
    assertEquals((await call("DELETE", "api/open")).json.source.kind, "default")
    assertEquals((await call("GET", "api/recording/a.rrd")).status, 404)
    await Deno.remove(path)
})

Deno.test("api/grpc/check: a server that lets this page's origin read it, one that doesn't, none", async () => {
    const allowOnly = "http://localhost:5555"
    const server = Deno.serve({ port: 0, onListen: () => {} }, (request) =>
        new Response(null, {
            headers: request.headers.get("origin") === allowOnly ? { "access-control-allow-origin": allowOnly } : {},
        }))
    const port = String((server.addr as Deno.NetAddr).port)
    await call("POST", "api/settings", { grpc: port })
    const check = async (origin: string) =>
        (await call("GET", `api/grpc/check?origin=${encodeURIComponent(origin)}`)).json
    assertEquals(await check(allowOnly), { address: `rerun+http://@host:${port}/proxy`, allowed: true })
    assertEquals((await check("http://100.64.0.1:5555")).allowed, false)
    await server.shutdown()
    assertEquals((await check(allowOnly)).allowed, null)
    assertEquals((await call("GET", "api/grpc/check")).status, 400)
    await call("POST", "api/settings", { grpc: "9877" })
})

Deno.test("agent.json lists every route", async () => {
    const { json } = await call("GET", "agent.json")
    assertEquals(json.endpoints.length, routes.length)
})

Deno.test("api/server/start starts a gRPC server on this machine when none answers (a stand-in rerun CLI)", async () => {
    const dir = await Deno.makeTempDir()
    const fake = `${dir}/rerun`
    // `rerun --serve-grpc --port <port> ...` → any web server on that port will do
    await Deno.writeTextFile(
        fake,
        `#!/bin/sh\necho "$@" > "${dir}/args"\nexec python3 -m http.server --bind 127.0.0.1 "$3"\n`,
    )
    await Deno.chmod(fake, 0o755)
    const port = freePort()
    Deno.env.set("RERUN_BIN", fake)
    Deno.env.delete("DIM_RERUN_NO_START")
    try {
        assertEquals((await call("POST", "api/settings", { grpc: port })).json.reachable, false)
        const started = await call("POST", "api/server/start")
        assertEquals([started.json.started, started.json.reachable], [true, true])
        assert((await Deno.readTextFile(`${dir}/args`)).includes("--bind 0.0.0.0 --cors-allow-origin http://*"))
        // already up: nothing more to start
        assertEquals((await call("POST", "api/server/start")).json.started, false)
    } finally {
        await stopStartedServer()
        Deno.env.delete("RERUN_BIN")
        await call("POST", "api/settings", { grpc: "9877" })
    }
})
