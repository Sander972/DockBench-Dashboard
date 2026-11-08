//! A minimal HTTP/1.1 responder for the dashboard: `GET /metrics`, `/history` and `/healthz`, one request per connection, each connection on its own thread so a stalled client or a long history answer never holds `/metrics`.

use crate::history::{History, Point, now_ms};
use crate::sample::Snapshot;
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Request line and headers above this are answered `400`.
const MAX_REQUEST: usize = 8 * 1024;

/// Two locks, so `/metrics` never waits for a history range or the daily file rewrite.
pub struct State {
    pub latest: Mutex<Option<Snapshot>>,
    pub history: Mutex<History>,
}

impl State {
    pub fn new(history: History) -> State {
        State { latest: Mutex::new(None), history: Mutex::new(history) }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryAnswer {
    step_ms: u64,
    points: Vec<Point>,
}

struct Reply {
    code: u16,
    json: bool,
    body: String,
}

fn text(code: u16, body: &str) -> Reply {
    Reply { code, json: false, body: body.to_string() }
}

/// Serves every connection on its own thread, forever; a broken connection never stops the loop. Only the dashboard reaches the port (internal network), so the thread count stays small.
pub fn serve(listener: TcpListener, state: Arc<State>) {
    for conn in listener.incoming().flatten() {
        let st = state.clone();
        std::thread::spawn(move || handle(conn, &st));
    }
}

/// Reads up to the end of the headers; `None` when the client sends more than `MAX_REQUEST` first or stalls.
fn read_head(c: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = c.read(&mut chunk).ok()?;
        if n == 0 || buf.len() + n > MAX_REQUEST {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    String::from_utf8(buf).ok()
}

fn handle(mut c: TcpStream, state: &State) {
    let _ = c.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = c.set_write_timeout(Some(Duration::from_secs(5)));
    let reply = match read_head(&mut c) {
        Some(head) => route(head.lines().next().unwrap_or(""), state),
        None => text(400, "bad request"),
    };
    let reason = match reply.code {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Service Unavailable",
    };
    let kind = if reply.json { "application/json" } else { "text/plain; charset=utf-8" };
    let head = format!("HTTP/1.1 {} {reason}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", reply.code, reply.body.len());
    let _ = c.write_all(head.as_bytes()).and_then(|_| c.write_all(reply.body.as_bytes()));
    // drain what the client still sends, so closing does not reset the connection before it reads the answer
    let _ = c.shutdown(Shutdown::Write);
    let _ = c.set_read_timeout(Some(Duration::from_millis(200)));
    let mut sink = [0u8; 4096];
    while matches!(c.read(&mut sink), Ok(n) if n > 0) {}
}

fn route(line: &str, state: &State) -> Reply {
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next()) else { return text(400, "bad request") };
    if !version.starts_with("HTTP/1.") {
        return text(400, "bad request");
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if method != "GET" {
        return text(404, "not found");
    }
    match path {
        "/metrics" => match &*state.latest.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(s) => Reply { code: 200, json: true, body: serde_json::to_string(s).unwrap_or_default() },
            None => text(503, "no sample yet"),
        },
        "/healthz" => match *state.latest.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(_) => text(200, "ok"),
            None => text(503, "no sample yet"),
        },
        "/history" => match parse_range(query) {
            Ok(q) => {
                // the lock is held for the range only; serializing happens after it is released
                let (step_ms, mut points) = state.history.lock().unwrap_or_else(|e| e.into_inner()).range(q.from, q.to, q.step);
                if !q.top {
                    points.iter_mut().for_each(|p| p.top.clear());
                }
                Reply { code: 200, json: true, body: serde_json::to_string(&HistoryAnswer { step_ms, points }).unwrap_or_default() }
            }
            Err(e) => text(400, e),
        },
        _ => text(404, "not found"),
    }
}

struct Range {
    from: u64,
    to: u64,
    step: u64,
    top: bool,
}

/// `from`, `to` (unix ms), `step` (ms) and `top` (0 leaves out the process lists) of a `/history` query: `to` defaults to now, `from` to an hour before `to`, `step` to 10 s, `top` to 1.
fn parse_range(query: &str) -> Result<Range, &'static str> {
    let (mut from, mut to, mut step, mut top) = (None, None, None, true);
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let n: u64 = v.parse().map_err(|_| "parameters must be whole numbers")?;
        match k {
            "from" => from = Some(n),
            "to" => to = Some(n),
            "step" => step = Some(n),
            "top" => top = n != 0,
            _ => {}
        }
    }
    let to = to.unwrap_or_else(now_ms);
    let from = from.unwrap_or(to.saturating_sub(3_600_000));
    let step = step.unwrap_or(10_000);
    if from > to {
        return Err("from is after to");
    }
    if step < 1000 {
        return Err("step must be at least 1000");
    }
    Ok(Range { from, to, step, top })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::Point;
    use crate::sample::{HostSample, Snapshot};
    use crate::testutil::tempdir;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    fn snap(at: u64) -> Snapshot {
        Snapshot { at, interval_ms: 2000, host: HostSample { ncpu: 4, cpu_pct: 50.0, steal_pct: 0.0, iowait_pct: 0.0, mem_total: 1, mem_used: 1, load1: 1.0, load5: 1.0, load15: 1.0, psi_cpu_some10: 0.0 }, containers: vec![], processes: vec![] }
    }

    fn server() -> (u16, Arc<State>) {
        let state = Arc::new(State::new(History::open(&tempdir("http"), 3_600_000)));
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let s = state.clone();
        std::thread::spawn(move || serve(l, s));
        (port, state)
    }

    fn set_latest(state: &Arc<State>, s: Snapshot) {
        *state.latest.lock().unwrap() = Some(s);
    }

    fn push_point(state: &Arc<State>, p: Point) {
        state.history.lock().unwrap().push(p);
    }

    // holds the history for a while from another thread, like a daily rewrite or a 24 h range
    fn hold_history(state: &Arc<State>, ms: u64) {
        let s = state.clone();
        std::thread::spawn(move || {
            let _g = s.history.lock().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(ms));
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    fn get(port: u16, raw: &str) -> (u16, String) {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        let code = out.split_whitespace().nth(1).unwrap().parse().unwrap();
        let body = out.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
        (code, body)
    }

    #[test]
    fn metrics_503_before_first_sample_then_200() {
        let (port, state) = server();
        assert_eq!(get(port, "GET /metrics HTTP/1.1\r\n\r\n").0, 503);
        assert_eq!(get(port, "GET /healthz HTTP/1.1\r\n\r\n").0, 503);
        set_latest(&state, snap(1));
        let (code, body) = get(port, "GET /metrics HTTP/1.1\r\nHost: x\r\n\r\n");
        assert_eq!(code, 200);
        assert!(body.contains("\"host\"") && body.contains("\"psiCpuSome10\""));
        assert_eq!(get(port, "GET /healthz HTTP/1.1\r\n\r\n"), (200, "ok".into()));
    }

    #[test]
    fn history_rejects_bad_ranges_and_serves_points() {
        let (port, state) = server();
        assert_eq!(get(port, "GET /history?from=5&to=1 HTTP/1.1\r\n\r\n").0, 400);
        assert_eq!(get(port, "GET /history?from=x HTTP/1.1\r\n\r\n").0, 400);
        assert_eq!(get(port, "GET /history?step=10 HTTP/1.1\r\n\r\n").0, 400);
        assert_eq!(get(port, "GET /history?to= HTTP/1.1\r\n\r\n").0, 400);
        let now = crate::history::now_ms();
        for i in 0..3 {
            push_point(&state, Point::from_samples(&[snap(now - 60_000 + i * 20_000)]));
        }
        let (code, body) = get(port, "GET /history HTTP/1.1\r\n\r\n");
        assert_eq!(code, 200);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["points"].as_array().unwrap().len(), 3);
        assert_eq!(v["stepMs"], 10_000);
        assert_eq!(v["points"][0]["host"]["cpuPct"], 50.0);
        let (_, body) = get(port, &format!("GET /history?from={}&to={now}&step=60000 HTTP/1.1\r\n\r\n", now - 90_000));
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!((v["stepMs"].as_u64(), v["points"].as_array().unwrap().len()), (Some(60_000), 2));
    }

    #[test]
    fn metrics_answers_at_once_while_another_client_stalls() {
        let (port, state) = server();
        set_latest(&state, snap(1));
        // a client that connects and sends nothing must not hold the next one
        let _idle = TcpStream::connect(("127.0.0.1", port)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let t = std::time::Instant::now();
        assert_eq!(get(port, "GET /metrics HTTP/1.1\r\n\r\n").0, 200);
        assert!(t.elapsed() < std::time::Duration::from_millis(500), "waited {:?}", t.elapsed());
    }

    #[test]
    fn metrics_answers_while_the_history_is_busy() {
        let (port, state) = server();
        set_latest(&state, snap(1));
        hold_history(&state, 1500);
        let t = std::time::Instant::now();
        assert_eq!(get(port, "GET /metrics HTTP/1.1\r\n\r\n").0, 200);
        assert!(t.elapsed() < std::time::Duration::from_millis(500), "waited {:?}", t.elapsed());
    }

    #[test]
    fn history_without_top_lists_when_asked() {
        let (port, state) = server();
        let now = crate::history::now_ms();
        let mut s = snap(now - 5000);
        s.processes = vec![crate::sample::ProcSample { comm: "node".into(), pids: vec![1], container: "host".into(), cpu_pct: 1.0, rss: 2 << 20 }];
        push_point(&state, Point::from_samples(&[s]));
        let (_, body) = get(port, "GET /history HTTP/1.1\r\n\r\n");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["points"][0]["top"]["host"][0]["comm"], "node");
        let (code, body) = get(port, "GET /history?top=0 HTTP/1.1\r\n\r\n");
        assert_eq!(code, 200);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["points"][0]["top"], serde_json::json!({}));
        assert_eq!(v["points"][0]["host"]["cpuPct"], 50.0);
    }

    #[test]
    fn unknown_path_404_and_oversized_request_400() {
        let (port, _) = server();
        assert_eq!(get(port, "GET /nope HTTP/1.1\r\n\r\n").0, 404);
        assert_eq!(get(port, "POST /metrics HTTP/1.1\r\n\r\n").0, 404);
        assert_eq!(get(port, "garbage\r\n\r\n").0, 400);
        let big = format!("GET /metrics HTTP/1.1\r\nX-Pad: {}\r\n\r\n", "a".repeat(9 * 1024));
        assert_eq!(get(port, &big).0, 400);
        assert_eq!(get(port, "GET /nope HTTP/1.1\r\n\r\n").0, 404, "the listener survives");
    }
}
