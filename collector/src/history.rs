//! The history: one point per step, a ring of `HISTORY_HOURS` in memory, appended as JSON lines to `history.jsonl`.

use crate::sample::Snapshot;
use serde::{Deserialize, Serialize, Serializer};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Points answered by one `/history` call at most, and the smallest step.
pub const MAX_POINTS: u64 = 1000;
pub const MIN_STEP_MS: u64 = 10_000;
/// Process names kept per group and point: the top N by CPU plus the top N by resident memory (3 and 3, not 5 and 5, keeps a day of points within the 50 MB budget, see tests/budget.rs).
const TOP_N: usize = 3;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Two decimals are plenty for a percentage and keep the file and the answers short.
fn round2<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64((v * 100.0).round() / 100.0)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopEntry {
    pub comm: String,
    pub pids: Vec<u32>,
    #[serde(serialize_with = "round2")]
    pub cpu_pct: f64,
    pub rss: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerPoint {
    pub name: String,
    #[serde(serialize_with = "round2")]
    pub cpu_pct: f64,
    pub mem_used: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPoint {
    #[serde(serialize_with = "round2")]
    pub cpu_pct: f64,
    #[serde(serialize_with = "round2")]
    pub steal_pct: f64,
    pub mem_used: u64,
    #[serde(serialize_with = "round2")]
    pub load1: f64,
}

/// One step of history. `containers` is keyed by container id, `top` by container id or `"host"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub t: u64,
    pub host: HostPoint,
    pub containers: HashMap<String, ContainerPoint>,
    pub top: HashMap<String, Vec<TopEntry>>,
}

impl Point {
    /// One point with every process of one snapshot (pruned by `merge`).
    fn from_snapshot(s: &Snapshot) -> Point {
        let mut top: HashMap<String, Vec<TopEntry>> = HashMap::new();
        for p in &s.processes {
            top.entry(p.container.clone()).or_default().push(TopEntry { comm: p.comm.clone(), pids: p.pids.clone(), cpu_pct: p.cpu_pct, rss: p.rss });
        }
        Point {
            t: s.at,
            host: HostPoint { cpu_pct: s.host.cpu_pct, steal_pct: s.host.steal_pct, mem_used: s.host.mem_used, load1: s.host.load1 },
            containers: s.containers.iter().map(|c| (c.id.clone(), ContainerPoint { name: c.name.clone(), cpu_pct: c.cpu_pct, mem_used: c.mem_used })).collect(),
            top,
        }
    }

    /// The samples of one step: CPU averaged over them, memory and pids from the last one that has the key.
    pub fn from_samples(samples: &[Snapshot]) -> Point {
        let points: Vec<Point> = samples.iter().map(Point::from_snapshot).collect();
        Point::merge(&points.iter().collect::<Vec<_>>())
    }

    /// Averages several points into one: CPU and load averaged over all of them (a key missing from a point counts 0 there), memory, names and pids from the last point that has the key, `t` of the last point; each group keeps its top `TOP_N` names by CPU and its top `TOP_N` by resident memory.
    pub fn merge(points: &[&Point]) -> Point {
        let n = points.len().max(1) as f64;
        let last = points.last();
        let mut containers: HashMap<String, ContainerPoint> = HashMap::new();
        let mut groups: HashMap<String, HashMap<String, TopEntry>> = HashMap::new();
        for p in points {
            for (id, c) in &p.containers {
                let e = containers.entry(id.clone()).or_insert_with(|| ContainerPoint { name: String::new(), cpu_pct: 0.0, mem_used: 0 });
                e.cpu_pct += c.cpu_pct / n;
                e.mem_used = c.mem_used;
                e.name.clone_from(&c.name);
            }
            for (key, entries) in &p.top {
                let g = groups.entry(key.clone()).or_default();
                for t in entries {
                    let e = g.entry(t.comm.clone()).or_insert_with(|| TopEntry { comm: t.comm.clone(), pids: Vec::new(), cpu_pct: 0.0, rss: 0 });
                    e.cpu_pct += t.cpu_pct / n;
                    e.rss = t.rss;
                    e.pids.clone_from(&t.pids);
                }
            }
        }
        let top = groups.into_iter().map(|(k, g)| (k, prune(g.into_values().collect()))).collect();
        Point {
            t: last.map_or(0, |p| p.t),
            host: HostPoint {
                cpu_pct: points.iter().map(|p| p.host.cpu_pct).sum::<f64>() / n,
                steal_pct: points.iter().map(|p| p.host.steal_pct).sum::<f64>() / n,
                mem_used: last.map_or(0, |p| p.host.mem_used),
                load1: points.iter().map(|p| p.host.load1).sum::<f64>() / n,
            },
            containers,
            top,
        }
    }
}

/// The union of the top `TOP_N` by CPU (above 0) and the top `TOP_N` by resident memory, sorted by CPU then memory.
fn prune(mut all: Vec<TopEntry>) -> Vec<TopEntry> {
    let by_cpu = |a: &TopEntry, b: &TopEntry| b.cpu_pct.total_cmp(&a.cpu_pct).then(b.rss.cmp(&a.rss));
    all.sort_by(|a, b| b.rss.cmp(&a.rss).then(b.cpu_pct.total_cmp(&a.cpu_pct)));
    let mut keep: Vec<TopEntry> = all.iter().take(TOP_N).cloned().collect();
    all.sort_by(by_cpu);
    for e in all.into_iter().filter(|e| e.cpu_pct > 0.0).take(TOP_N) {
        if !keep.iter().any(|k| k.comm == e.comm) {
            keep.push(e);
        }
    }
    keep.sort_by(by_cpu);
    keep
}

/// Shared strings of the ring (container ids, names, process names): a point refers to them by index, so a day of points does not hold a million copies of the same few hundred strings.
#[derive(Default)]
struct Syms {
    strs: Vec<Arc<str>>,
    index: HashMap<Arc<str>, u32>,
}

impl Syms {
    fn get(&mut self, s: &str) -> u32 {
        if let Some(&i) = self.index.get(s) {
            return i;
        }
        let a: Arc<str> = Arc::from(s);
        let i = self.strs.len() as u32;
        self.strs.push(a.clone());
        self.index.insert(a, i);
        i
    }

    fn str(&self, i: u32) -> &str {
        &self.strs[i as usize]
    }
}

struct SlotEntry {
    comm: u32,
    cpu: f32,
    rss: u64,
    pids: Box<[u32]>,
}

struct SlotContainer {
    id: u32,
    name: u32,
    cpu: f32,
    mem: u64,
}

/// A point as the ring keeps it: strings as `Syms` indexes, boxed slices instead of maps.
pub struct Slot {
    pub t: u64,
    host: HostPoint,
    containers: Box<[SlotContainer]>,
    top: Box<[(u32, Box<[SlotEntry]>)]>,
}

impl Slot {
    fn pack(syms: &mut Syms, p: &Point) -> Slot {
        Slot {
            t: p.t,
            host: p.host.clone(),
            containers: p.containers.iter().map(|(id, c)| SlotContainer { id: syms.get(id), name: syms.get(&c.name), cpu: c.cpu_pct as f32, mem: c.mem_used }).collect(),
            top: p
                .top
                .iter()
                .map(|(k, es)| (syms.get(k), es.iter().map(|e| SlotEntry { comm: syms.get(&e.comm), cpu: e.cpu_pct as f32, rss: e.rss, pids: e.pids.clone().into() }).collect()))
                .collect(),
        }
    }

    fn unpack(&self, syms: &Syms) -> Point {
        Point {
            t: self.t,
            host: self.host.clone(),
            containers: self.containers.iter().map(|c| (syms.str(c.id).to_string(), ContainerPoint { name: syms.str(c.name).to_string(), cpu_pct: c.cpu as f64, mem_used: c.mem })).collect(),
            top: self
                .top
                .iter()
                .map(|(k, es)| (syms.str(*k).to_string(), es.iter().map(|e| TopEntry { comm: syms.str(e.comm).to_string(), pids: e.pids.to_vec(), cpu_pct: e.cpu as f64, rss: e.rss }).collect()))
                .collect(),
        }
    }

    fn remap(&mut self, from: &Syms, to: &mut Syms) {
        for c in self.containers.iter_mut() {
            c.id = to.get(from.str(c.id));
            c.name = to.get(from.str(c.name));
        }
        for (k, es) in self.top.iter_mut() {
            *k = to.get(from.str(*k));
            for e in es.iter_mut() {
                e.comm = to.get(from.str(e.comm));
            }
        }
    }
}

type LineEntry = (String, Vec<u32>, f64, u64);

/// The file's compact line: `h` = host `[cpuPct, stealPct, memUsed, load1]`, `c` = container id → `[name, cpuPct, memUsed, top]`, `p` = top lists of keys that are not a container (`host`).
#[derive(Serialize, Deserialize)]
struct Line {
    t: u64,
    h: (f64, f64, u64, f64),
    c: HashMap<String, (String, f64, u64, Vec<LineEntry>)>,
    #[serde(default)]
    p: HashMap<String, Vec<LineEntry>>,
}

fn r2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

impl Line {
    fn from_point(p: &Point) -> Line {
        let entries = |k: &str| p.top.get(k).map_or_else(Vec::new, |es| es.iter().map(|e| (e.comm.clone(), e.pids.clone(), r2(e.cpu_pct), e.rss)).collect());
        Line {
            t: p.t,
            h: (r2(p.host.cpu_pct), r2(p.host.steal_pct), p.host.mem_used, r2(p.host.load1)),
            c: p.containers.iter().map(|(id, c)| (id.clone(), (c.name.clone(), r2(c.cpu_pct), c.mem_used, entries(id)))).collect(),
            p: p.top.keys().filter(|k| !p.containers.contains_key(*k)).map(|k| (k.clone(), entries(k))).collect(),
        }
    }

    fn into_point(self) -> Point {
        let entries = |es: Vec<LineEntry>| es.into_iter().map(|(comm, pids, cpu_pct, rss)| TopEntry { comm, pids, cpu_pct, rss }).collect::<Vec<_>>();
        let mut top: HashMap<String, Vec<TopEntry>> = self.p.into_iter().map(|(k, es)| (k, entries(es))).collect();
        let mut containers = HashMap::new();
        for (id, (name, cpu_pct, mem_used, es)) in self.c {
            if !es.is_empty() {
                top.insert(id.clone(), entries(es));
            }
            containers.insert(id, ContainerPoint { name, cpu_pct, mem_used });
        }
        Point { t: self.t, host: HostPoint { cpu_pct: self.h.0, steal_pct: self.h.1, mem_used: self.h.2, load1: self.h.3 }, containers, top }
    }
}

pub struct History {
    pub ring: VecDeque<Slot>,
    syms: Syms,
    keep_ms: u64,
    file: PathBuf,
    lines: usize,
}

impl History {
    /// Loads `history.jsonl` from `dir` line by line, keeping the points of the last `keep_ms` and skipping unparsable lines (bytes, so a line that is not UTF-8 is one of them).
    pub fn open(dir: &Path, keep_ms: u64) -> History {
        let _ = fs::create_dir_all(dir);
        let file = dir.join("history.jsonl");
        let since = now_ms().saturating_sub(keep_ms);
        let mut syms = Syms::default();
        let mut ring = VecDeque::new();
        let mut lines = 0;
        if let Ok(f) = fs::File::open(&file) {
            for l in BufReader::new(f).split(b'\n').map_while(Result::ok) {
                lines += 1;
                if let Some(l) = serde_json::from_slice::<Line>(&l).ok().filter(|l| l.t >= since) {
                    ring.push_back(Slot::pack(&mut syms, &l.into_point()));
                }
            }
        }
        History { ring, syms, keep_ms, file, lines }
    }

    /// Adds a point to the ring, drops what left the window and appends one line; when the file holds more than twice the ring, it is rewritten from the ring and unused strings are dropped.
    pub fn push(&mut self, p: Point) {
        let since = p.t.saturating_sub(self.keep_ms);
        let line = serde_json::to_string(&Line::from_point(&p)).unwrap_or_default();
        self.ring.push_back(Slot::pack(&mut self.syms, &p));
        while self.ring.front().is_some_and(|f| f.t < since) {
            self.ring.pop_front();
        }
        let res = if self.lines + 1 > 2 * self.ring.len() + 16 { self.rewrite() } else { self.append(line) };
        if let Err(e) = res {
            eprintln!("dockbench-collector: cannot write {}: {e}", self.file.display());
        }
    }

    fn append(&mut self, mut line: String) -> std::io::Result<()> {
        line.push('\n');
        OpenOptions::new().create(true).append(true).open(&self.file)?.write_all(line.as_bytes())?;
        self.lines += 1;
        Ok(())
    }

    fn rewrite(&mut self) -> std::io::Result<()> {
        let old = std::mem::take(&mut self.syms);
        let mut out = String::new();
        for s in self.ring.iter_mut() {
            out.push_str(&serde_json::to_string(&Line::from_point(&s.unpack(&old)))?);
            out.push('\n');
            s.remap(&old, &mut self.syms);
        }
        let tmp = self.file.with_extension("jsonl.tmp");
        fs::write(&tmp, out)?;
        fs::rename(&tmp, &self.file)?;
        self.lines = self.ring.len();
        Ok(())
    }

    /// The points of `[from, to]` averaged into buckets of the effective step: at least 10 s, raised so the answer holds at most 1000 points.
    pub fn range(&self, from: u64, to: u64, step_ms: u64) -> (u64, Vec<Point>) {
        let step = step_ms.max(MIN_STEP_MS).max((to.saturating_sub(from)).div_ceil(MAX_POINTS));
        let mut out = Vec::new();
        let mut bucket: Vec<Point> = Vec::new();
        let mut idx = u64::MAX;
        for s in self.ring.iter().filter(|s| s.t >= from && s.t <= to) {
            let i = (s.t - from) / step;
            if i != idx && !bucket.is_empty() {
                out.push(Point::merge(&bucket.iter().collect::<Vec<_>>()));
                bucket.clear();
            }
            idx = i;
            bucket.push(s.unpack(&self.syms));
        }
        if !bucket.is_empty() {
            out.push(Point::merge(&bucket.iter().collect::<Vec<_>>()));
        }
        (step, out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sample::{ContainerSample, HostSample, ProcSample, Snapshot};
    use crate::testutil::tempdir;

    fn snap(at: u64, cpu: f64, mem: u64, procs: Vec<ProcSample>) -> Snapshot {
        Snapshot {
            at,
            interval_ms: 2000,
            host: HostSample { ncpu: 4, cpu_pct: cpu, steal_pct: 1.0, iowait_pct: 0.0, mem_total: 1 << 30, mem_used: mem, load1: 2.0, load5: 1.0, load15: 0.5, psi_cpu_some10: 3.0 },
            containers: vec![ContainerSample { id: "c1".into(), name: "shop".into(), image: "img".into(), dockbench: true, cpu_pct: cpu / 2.0, mem_used: mem / 2, mem_limit: 1 << 30 }],
            processes: procs,
        }
    }

    fn proc_(comm: &str, container: &str, cpu: f64, rss: u64) -> ProcSample {
        ProcSample { comm: comm.into(), pids: vec![1], container: container.into(), cpu_pct: cpu, rss }
    }

    #[test]
    fn point_averages_cpu_keeps_last_mem_and_unions_top_lists() {
        let busy: Vec<ProcSample> = (0..6).map(|i| proc_(&format!("busy{i}"), "c1", 10.0 + i as f64, 1 << 20)).collect();
        let mut last = busy.clone();
        last.push(proc_("lsp", "c1", 0.0, 2 << 30));
        last.push(proc_("sshd", "host", 1.0, 5 << 20));
        let p = Point::from_samples(&[snap(1000, 10.0, 100, busy.clone()), snap(3000, 20.0, 200, busy), snap(5000, 30.0, 300, last)]);
        assert_eq!(p.t, 5000);
        assert_eq!((p.host.cpu_pct, p.host.mem_used, p.host.steal_pct), (20.0, 300, 1.0));
        assert_eq!((p.containers["c1"].cpu_pct, p.containers["c1"].mem_used, p.containers["c1"].name.as_str()), (10.0, 150, "shop"));
        let top: Vec<&str> = p.top["c1"].iter().map(|e| e.comm.as_str()).collect();
        assert_eq!(top.len(), 4, "top 3 by cpu plus lsp by rss: {top:?}");
        assert!(top.contains(&"lsp") && !top.contains(&"busy2"));
        let sshd = &p.top["host"][0];
        assert_eq!((sshd.comm.as_str(), sshd.rss), ("sshd", 5 << 20));
        assert!((sshd.cpu_pct - 1.0 / 3.0).abs() < 1e-9);
    }

    fn point(t: u64, cpu: f64) -> Point {
        Point::from_samples(&[snap(t, cpu, 100, vec![proc_("node", "c1", cpu, 1 << 20)])])
    }

    #[test]
    fn history_persists_and_reloads_within_the_window() {
        let d = tempdir("history");
        let now = now_ms();
        let mut h = History::open(&d, 60_000);
        h.push(point(now - 120_000, 1.0));
        h.push(point(now, 2.0));
        assert_eq!(h.ring.len(), 1, "the old point falls out of the ring");
        let r = History::open(&d, 60_000);
        assert_eq!(r.ring.len(), 1);
        assert_eq!(r.ring[0].t, now);
        assert_eq!(r.range(now - 1, now, 10_000).1[0].top["c1"][0].comm, "node", "the top list survives the compact line");
        let valid = std::fs::read_to_string(d.join("history.jsonl")).unwrap();
        std::fs::write(d.join("history.jsonl"), format!("not json\n{valid}")).unwrap();
        assert_eq!(History::open(&d, 60_000).ring.len(), 1, "an unparsable line is skipped");
        let mut bytes = b"\xff\xfe not utf-8\n".to_vec();
        bytes.extend_from_slice(valid.as_bytes());
        std::fs::write(d.join("history.jsonl"), bytes).unwrap();
        let r = History::open(&d, 60_000);
        assert_eq!((r.ring.len(), r.lines), (1, 3), "a line that is not UTF-8 is skipped, not the whole file");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn file_is_rewritten_from_the_ring_when_it_doubles() {
        let d = tempdir("history-rewrite");
        let now = now_ms();
        let mut h = History::open(&d, 50_000);
        for i in 0..100 {
            h.push(point(now - 1_000_000 + i * 10_000, 1.0));
        }
        let lines = std::fs::read_to_string(d.join("history.jsonl")).unwrap().lines().count();
        assert!(lines <= 2 * h.ring.len() + 16, "file kept {lines} lines for a ring of {}", h.ring.len());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn range_raises_the_step_to_fit_1000_points_and_buckets() {
        let d = tempdir("history-range");
        let mut h = History::open(&d, u64::MAX / 2);
        let t0 = now_ms() - 1_000_000;
        for i in 0..20 {
            h.push(point(t0 + i * 10_000, if i % 5 == 4 { 50.0 } else { 0.0 }));
        }
        let (step, pts) = h.range(t0, t0 + 200_000, 10_000);
        assert_eq!((step, pts.len()), (10_000, 20));
        let (step, pts) = h.range(t0, t0 + 200_000, 50_000);
        assert_eq!((step, pts.len()), (50_000, 4));
        assert_eq!(pts[0].host.cpu_pct, 10.0);
        assert_eq!(pts[0].containers["c1"].cpu_pct, 5.0);
        assert_eq!(pts[0].top["c1"][0].cpu_pct, 10.0);
        assert_eq!(h.range(t0, t0 + 200_000, 1000).0, 10_000, "never below 10 s");
        assert_eq!(h.range(t0, t0 + 86_400_000, 1000).0, 86_400);
        std::fs::remove_dir_all(d).unwrap();
    }
}
