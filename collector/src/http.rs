//! A minimal HTTP/1.1 responder for the dashboard: `GET /metrics`, `/history` and `/healthz`, one request per connection.

use crate::history::{History, Point, now_ms};
use crate::sample::Snapshot;
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Request line and headers above this are answered `400`.
const MAX_REQUEST: usize = 8 * 1024;

pub struct State {
    pub latest: Option<Snapshot>,
    pub history: History,
    /// The samples of the step in progress, folded into one history point when the step is full.
    pub pending: Vec<Snapshot>,
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

/// Serves connections one after the other, forever; a broken connection never stops the loop.
pub fn serve(listener: TcpListener, state: Arc<Mutex<State>>) {
    for conn in listener.incoming().flatten() {
        handle(conn, &state);
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

fn handle(mut c: TcpStream, state: &Mutex<State>) {
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

fn route(line: &str, state: &Mutex<State>) -> Reply {
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next()) else { return text(400, "bad request") };
    if !version.starts_with("HTTP/1.") {
        return text(400, "bad request");
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if method != "GET" {
        return text(404, "not found");
    }
    let st = state.lock().unwrap_or_else(|e| e.into_inner());
    match path {
        "/metrics" => match &st.latest {
            Some(s) => Reply { code: 200, json: true, body: serde_json::to_string(s).unwrap_or_default() },
            None => text(503, "no sample yet"),
        },
        "/healthz" => match st.latest {
            Some(_) => text(200, "ok"),
            None => text(503, "no sample yet"),
        },
        "/history" => match parse_range(query) {
            Ok((from, to, step)) => {
                let (step_ms, points) = st.history.range(from, to, step);
                Reply { code: 200, json: true, body: serde_json::to_string(&HistoryAnswer { step_ms, points }).unwrap_or_default() }
            }
            Err(e) => text(400, e),
        },
        _ => text(404, "not found"),
    }
}

/// `from`, `to` (unix ms) and `step` (ms) of a `/history` query: `to` defaults to now, `from` to an hour before `to`, `step` to 10 s.
fn parse_range(query: &str) -> Result<(u64, u64, u64), &'static str> {
    let (mut from, mut to, mut step) = (None, None, None);
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let n: u64 = v.parse().map_err(|_| "parameters must be whole numbers")?;
        match k {
            "from" => from = Some(n),
            "to" => to = Some(n),
            "step" => step = Some(n),
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
    Ok((from, to, step))
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

    fn server() -> (u16, Arc<Mutex<State>>) {
        let state = Arc::new(Mutex::new(State { latest: None, history: History::open(&tempdir("http"), 3_600_000), pending: vec![] }));
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let s = state.clone();
        std::thread::spawn(move || serve(l, s));
        (port, state)
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
        state.lock().unwrap().latest = Some(snap(1));
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
            state.lock().unwrap().history.push(Point::from_samples(&[snap(now - 60_000 + i * 20_000)]));
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
