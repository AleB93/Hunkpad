//! A local MCP server, so Claude Code can see what Hunkpad shows and use its
//! features (src/mcp.ts has the tools). Off by default; the user turns it on.
//!
//! Streamable HTTP, JSON responses only (no SSE), on 127.0.0.1. Every request
//! needs the bearer token the user installed into Claude Code; requests from a
//! browser (an Origin header) or for another host name are refused, so a web
//! page cannot reach it. `initialize` and `ping` are answered here; anything
//! else goes to the window (event "mcp-request"), which answers with `mcp_reply`.

use std::{
    collections::HashMap,
    io::Read,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::lock;

/// Protocol versions this server speaks, newest first.
const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// A tool call may wait for the user (e.g. approving a commit in Hunkpad).
const REPLY_LIMIT: Duration = Duration::from_secs(10 * 60);

const MAX_BODY: u64 = 4 * 1024 * 1024;

static SERVER: Mutex<Option<Arc<Server>>> = Mutex::new(None);
static PENDING: Mutex<Option<HashMap<u64, mpsc::Sender<Value>>>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

const INSTRUCTIONS: &str = "Hunkpad is the user's Git client. These tools show what the user is looking at in it \
(active repository, open file, cursor and selection, changes, change groups, review comments) and use its \
features. Change groups are Hunkpad's local changelists: blocks of uncommitted changes the user will commit \
together. Tools act on Hunkpad's active repository tab. Anything that runs Git (staging, committing) is shown \
to the user in Hunkpad for approval first, and may be declined.";

/// Starts (or restarts) the server on 127.0.0.1:`port`, accepting `token`.
#[tauri::command]
pub fn mcp_start(app: AppHandle, port: u16, token: String) -> Result<(), String> {
    mcp_stop();
    if token.len() < 32 {
        return Err("token too short".into());
    }
    let server = serve(port, token, move |method, params| forward(&app, method, params))?;
    *lock(&SERVER) = Some(server);
    Ok(())
}

/** Listens on 127.0.0.1:`port`; requests other than initialize / ping go to `forward`. */
fn serve<F>(port: u16, token: String, forward: F) -> Result<Arc<Server>, String>
where
    F: Fn(&str, Value) -> Value + Send + Sync + 'static,
{
    let server = Server::http(("127.0.0.1", port)).map_err(|e| format!("could not listen on 127.0.0.1:{port}: {e}"))?;
    let server = Arc::new(server);
    let listening = server.clone();
    let forward = Arc::new(forward);
    std::thread::spawn(move || {
        for request in listening.incoming_requests() {
            let token = token.clone();
            let forward = forward.clone();
            // One thread per request: a tool call can wait minutes for the user.
            std::thread::spawn(move || handle(request, port, &token, &*forward));
        }
    });
    Ok(server)
}

/// Stops the server (pending tool calls fail).
#[tauri::command]
pub fn mcp_stop() {
    if let Some(server) = lock(&SERVER).take() {
        server.unblock();
    }
    lock(&PENDING).take();
}

/// The window's answer to a forwarded request: `{ "result": … }` or `{ "error": { code, message } }`.
#[tauri::command]
pub fn mcp_reply(id: u64, response: Value) {
    if let Some(tx) = lock(&PENDING).as_mut().and_then(|m| m.remove(&id)) {
        let _ = tx.send(response);
    }
}

fn header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

fn reply(request: Request, status: u16, body: Option<Value>) {
    let text = body.map(|b| b.to_string()).unwrap_or_default();
    let mut response = Response::from_string(text).with_status_code(status);
    if let Ok(h) = Header::from_bytes("Content-Type", "application/json") {
        response = response.with_header(h);
    }
    let _ = request.respond(response);
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn handle(mut request: Request, port: u16, token: &str, forward: &dyn Fn(&str, Value) -> Value) {
    let path = request.url().split('?').next().unwrap_or("");
    if path != "/mcp" {
        return reply(request, 404, None);
    }
    // DNS rebinding: only our own address, and never from a web page.
    let host_ok = header(&request, "Host").is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
    if !host_ok || header(&request, "Origin").is_some() {
        return reply(request, 403, None);
    }
    let expected = format!("Bearer {token}");
    if header(&request, "Authorization").map(str::trim) != Some(expected.as_str()) {
        return reply(request, 401, None);
    }
    if *request.method() != Method::Post {
        // No server-to-client stream (GET) and no sessions to end (DELETE).
        return reply(request, 405, None);
    }

    let mut body = String::new();
    if request.as_reader().take(MAX_BODY).read_to_string(&mut body).is_err() {
        return reply(request, 400, Some(rpc_error(&Value::Null, -32700, "unreadable body")));
    }
    let message: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return reply(request, 400, Some(rpc_error(&Value::Null, -32700, "parse error"))),
    };
    if !message.is_object() {
        return reply(request, 400, Some(rpc_error(&Value::Null, -32600, "expected one JSON-RPC message")));
    }
    let Some(id) = message.get("id").cloned() else {
        return reply(request, 202, None); // a notification (e.g. notifications/initialized)
    };
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    let answer = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
            json!({ "result": {
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "hunkpad", "title": "Hunkpad", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }})
        }
        "ping" => json!({ "result": {} }),
        _ => forward(method, params),
    };
    let mut out = json!({ "jsonrpc": "2.0", "id": id });
    match (answer.get("result"), answer.get("error")) {
        (Some(result), _) => out["result"] = result.clone(),
        (None, Some(error)) => out["error"] = error.clone(),
        _ => out = rpc_error(&id, -32603, "no answer"),
    }
    reply(request, 200, Some(out));
}

/// Asks the window, and waits for its `mcp_reply`.
fn forward(app: &AppHandle, method: &str, params: Value) -> Value {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    lock(&PENDING).get_or_insert_with(HashMap::new).insert(id, tx);
    if app.emit("mcp-request", json!({ "id": id, "method": method, "params": params })).is_err() {
        lock(&PENDING).as_mut().map(|m| m.remove(&id));
        return json!({ "error": { "code": -32603, "message": "Hunkpad's window is not available" } });
    }
    match rx.recv_timeout(REPLY_LIMIT) {
        Ok(v) => v,
        Err(_) => {
            lock(&PENDING).as_mut().map(|m| m.remove(&id));
            json!({ "error": { "code": -32603, "message": "Hunkpad did not answer in time" } })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

    /** Sends a raw HTTP request; returns (status, body). */
    fn send(port: u16, method: &str, headers: &[(&str, String)], body: &str) -> (u16, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut req = format!("{method} /mcp HTTP/1.1\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        req.push_str(body);
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let status = out[9..12].parse().unwrap();
        let body = out.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
        (status, body)
    }

    fn ok_headers(port: u16) -> Vec<(&'static str, String)> {
        vec![("Host", format!("127.0.0.1:{port}")), ("Authorization", format!("Bearer {TOKEN}"))]
    }

    #[test]
    fn protocol_and_guards() {
        let port = 47999;
        let server = serve(port, TOKEN.into(), |method, params| {
            json!({ "result": { "echo": method, "params": params } })
        })
        .unwrap();
        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#;

        let (code, body) = send(port, "POST", &ok_headers(port), init);
        assert_eq!(code, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(v["result"]["serverInfo"]["name"], "hunkpad");

        // Forwarded, with the id put back.
        let call = r#"{"jsonrpc":"2.0","id":"x","method":"tools/list"}"#;
        let (_, body) = send(port, "POST", &ok_headers(port), call);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["id"], "x");
        assert_eq!(v["result"]["echo"], "tools/list");

        // Notifications get 202 and no body.
        let (code, _) = send(port, "POST", &ok_headers(port), r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert_eq!(code, 202);

        // Wrong or missing token.
        let mut h = ok_headers(port);
        h[1].1 = "Bearer nope".into();
        assert_eq!(send(port, "POST", &h, init).0, 401);
        assert_eq!(send(port, "POST", &h[..1], init).0, 401);

        // A web page: Origin header, or another host name (DNS rebinding).
        let mut h = ok_headers(port);
        h.push(("Origin", "https://evil.example".into()));
        assert_eq!(send(port, "POST", &h, init).0, 403);
        let mut h = ok_headers(port);
        h[0].1 = format!("evil.example:{port}");
        assert_eq!(send(port, "POST", &h, init).0, 403);

        // No stream, bad JSON, batches.
        assert_eq!(send(port, "GET", &ok_headers(port), "").0, 405);
        assert_eq!(send(port, "POST", &ok_headers(port), "{nope").0, 400);
        assert_eq!(send(port, "POST", &ok_headers(port), "[]").0, 400);

        server.unblock();
    }
}
