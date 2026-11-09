//! One tick: read host, cgroups and processes, turn the deltas against the previous tick into shares of the whole host.

use crate::cgroups::{self, CgRaw};
use crate::docker::{self, ContainerInfo};
use crate::history::now_ms;
use crate::proc::{self, HostRaw};
use crate::procs::{self, ProcRaw};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Microseconds of CPU time per jiffy (USER_HZ is 100 on Linux).
const USEC_PER_JIFFY: u64 = 10_000;
const NAMES_EVERY: Duration = Duration::from_secs(10);
/// How long an id Docker did not list twice in a row is not asked about again (the 10 s refresh still runs).
const MISS_FOR: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSample {
    pub ncpu: u32,
    pub cpu_pct: f64,
    pub steal_pct: f64,
    pub iowait_pct: f64,
    pub mem_total: u64,
    pub mem_used: u64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub psi_cpu_some10: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSample {
    pub id: String,
    pub name: String,
    pub image: String,
    pub dockbench: bool,
    pub cpu_pct: f64,
    pub mem_used: u64,
    pub mem_limit: u64,
}

/// Same-named processes of one container (or `"host"`) summed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcSample {
    pub comm: String,
    pub pids: Vec<u32>,
    pub container: String,
    pub cpu_pct: f64,
    pub rss: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub at: u64,
    pub interval_ms: u64,
    pub host: HostSample,
    pub containers: Vec<ContainerSample>,
    pub processes: Vec<ProcSample>,
}

#[derive(Debug, Clone)]
pub struct SamplerCfg {
    pub proc_root: PathBuf,
    pub cg_root: PathBuf,
    pub docker_sock: PathBuf,
    pub interval_ms: u64,
}

struct Raw {
    host: HostRaw,
    cgs: Vec<CgRaw>,
    procs: Vec<ProcRaw>,
}

pub struct Sampler {
    prev: Option<Raw>,
    names: HashMap<String, ContainerInfo>,
    names_at: Option<Instant>,
    /// None after a first miss (asked again on the next tick: Docker can list a container a moment after its cgroup appears), the time of a repeat miss after that
    misses: HashMap<String, Option<Instant>>,
    walker: procs::Walker,
    cfg: SamplerCfg,
}

fn pct(part: u64, whole: u64) -> f64 {
    if whole == 0 { 0.0 } else { (part as f64 / whole as f64 * 100.0).clamp(0.0, 100.0) }
}

impl Sampler {
    pub fn new(cfg: SamplerCfg) -> Sampler {
        Sampler { prev: None, names: HashMap::new(), names_at: None, misses: HashMap::new(), walker: procs::Walker::default(), cfg }
    }

    /// Refreshes the id → name map every 10 s or when a cgroup id is unknown and was not missed twice in a row in the last minute; a failed refresh keeps the old map, and a name stays while its cgroup still exists.
    fn refresh_names(&mut self, cgs: &[CgRaw]) {
        let due = self.names_at.is_none_or(|t| t.elapsed() >= NAMES_EVERY);
        let known = |id: &String| self.names.contains_key(id) || self.misses.get(id).is_some_and(|t| t.is_some_and(|t| t.elapsed() < MISS_FOR));
        if !due && cgs.iter().all(|c| known(&c.id)) {
            return;
        }
        let now = Instant::now();
        self.names_at = Some(now);
        if let Ok(list) = docker::list_containers(&self.cfg.docker_sock) {
            let mut names: HashMap<String, ContainerInfo> = list.into_iter().map(|c| (c.id.clone(), c)).collect();
            for c in cgs {
                if let Some(old) = self.names.remove(&c.id) {
                    names.entry(c.id.clone()).or_insert(old);
                }
            }
            self.names = names;
        }
        let before = std::mem::take(&mut self.misses);
        self.misses = cgs.iter().filter(|c| !self.names.contains_key(&c.id)).map(|c| (c.id.clone(), before.contains_key(&c.id).then_some(now))).collect();
    }

    /// Reads one sample; `None` on the first call (no deltas yet) or when the host files cannot be read.
    pub fn tick(&mut self) -> Option<Snapshot> {
        let host = proc::read_host_at(&self.cfg.proc_root).ok()?;
        let cur = Raw { host, cgs: cgroups::list(&self.cfg.cg_root), procs: self.walker.walk(&self.cfg.proc_root) };
        self.refresh_names(&cur.cgs);
        let Some(prev) = self.prev.replace(cur) else { return None };
        let cur = self.prev.as_ref().unwrap();
        let (a, b) = (&prev.host.cpu, &cur.host.cpu);
        let dt = b.total.saturating_sub(a.total);
        let host = HostSample {
            ncpu: b.ncpu,
            cpu_pct: pct(b.busy.saturating_sub(a.busy), dt),
            steal_pct: pct(b.steal.saturating_sub(a.steal), dt),
            iowait_pct: pct(b.iowait.saturating_sub(a.iowait), dt),
            mem_total: cur.host.mem.total,
            mem_used: cur.host.mem.used,
            load1: cur.host.load.0,
            load5: cur.host.load.1,
            load15: cur.host.load.2,
            psi_cpu_some10: cur.host.psi,
        };
        let before: HashMap<&str, u64> = prev.cgs.iter().map(|c| (c.id.as_str(), c.cpu_usec)).collect();
        let mut containers: Vec<ContainerSample> = cur
            .cgs
            .iter()
            .map(|c| {
                let used = before.get(c.id.as_str()).map_or(0, |&p| c.cpu_usec.saturating_sub(p));
                let info = self.names.get(&c.id);
                ContainerSample {
                    id: c.id.clone(),
                    name: info.map_or_else(|| c.id[..12.min(c.id.len())].to_string(), |i| i.name.clone()),
                    image: info.map_or_else(String::new, |i| i.image.clone()),
                    dockbench: info.is_some_and(|i| i.dockbench),
                    cpu_pct: pct(used, dt * USEC_PER_JIFFY),
                    mem_used: c.mem_current.saturating_sub(c.inactive_file),
                    mem_limit: c.mem_max.unwrap_or(host.mem_total),
                }
            })
            .collect();
        containers.sort_by(|x, y| x.name.cmp(&y.name));
        let processes = procs::aggregate(&prev.procs, &cur.procs, dt)
            .into_iter()
            .map(|p| ProcSample { comm: p.comm, pids: p.pids, container: p.container.unwrap_or_else(|| "host".into()), cpu_pct: p.cpu_pct, rss: p.rss })
            .collect();
        Some(Snapshot { at: now_ms(), interval_ms: self.cfg.interval_ms, host, containers, processes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tempdir;
    use std::fs;
    use std::path::Path;

    /// Writes a fake `/proc` (host files and one pid in the container) and a fake cgroup root with that container's scope.
    fn world(proc_root: &Path, cg_root: &Path, id: &str, host_total: u64, cg_usec: u64, pid_jiffies: u64) {
        fs::create_dir_all(proc_root.join("77")).unwrap();
        let idle = host_total / 2;
        let user = host_total - idle;
        fs::write(proc_root.join("stat"), format!("cpu  {user} 0 0 {idle} 0 0 0 0 0 0\ncpu0 0 0 0 0\ncpu1 0 0 0 0\n")).unwrap();
        fs::write(proc_root.join("meminfo"), "MemTotal: 1000 kB\nMemAvailable: 400 kB\n").unwrap();
        fs::write(proc_root.join("loadavg"), "1.5 1.0 0.5 1/100 77\n").unwrap();
        fs::write(proc_root.join("77/stat"), format!("77 (node) S 1 1 1 0 -1 0 0 0 0 0 {pid_jiffies} 0 0 0 20 0 1 0 100 1000 600\n")).unwrap();
        fs::write(proc_root.join("77/cgroup"), format!("0::/system.slice/docker-{id}.scope\n")).unwrap();
        let scope = cg_root.join(format!("system.slice/docker-{id}.scope"));
        fs::create_dir_all(&scope).unwrap();
        fs::write(scope.join("cpu.stat"), format!("usage_usec {cg_usec}\n")).unwrap();
        fs::write(scope.join("memory.current"), "3000\n").unwrap();
        fs::write(scope.join("memory.stat"), "inactive_file 1000\n").unwrap();
        fs::write(scope.join("memory.max"), "max\n").unwrap();
    }

    #[test]
    fn tick_needs_two_reads_and_clamps_counter_resets() {
        let d = tempdir("sampler");
        let (p, c) = (d.join("proc"), d.join("cg"));
        let id = "d".repeat(64);
        let mut s = Sampler::new(SamplerCfg { proc_root: p.clone(), cg_root: c.clone(), docker_sock: d.join("none.sock"), interval_ms: 2000 });
        world(&p, &c, &id, 1000, 1_000_000, 10);
        assert!(s.tick().is_none());
        // 800 host jiffies later = 8 s of all-core time; the container used 2 s of it, the pid 200 jiffies
        world(&p, &c, &id, 1800, 3_000_000, 210);
        let snap = s.tick().expect("second tick has deltas");
        assert_eq!(snap.host.ncpu, 2);
        assert_eq!(snap.host.cpu_pct, 50.0);
        assert_eq!((snap.host.mem_total, snap.host.mem_used), (1000 * 1024, 600 * 1024));
        let ct = &snap.containers[0];
        assert_eq!((ct.name.as_str(), ct.cpu_pct, ct.mem_used, ct.mem_limit), (&id[..12], 25.0, 2000, 1000 * 1024));
        let pr = snap.processes.iter().find(|x| x.comm == "node").unwrap();
        assert_eq!((pr.container.as_str(), pr.cpu_pct, pr.pids.clone()), (id.as_str(), 25.0, vec![77]));
        // the container was recreated: its counter starts low again
        world(&p, &c, &id, 2600, 500, 220);
        assert_eq!(s.tick().unwrap().containers[0].cpu_pct, 0.0);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn an_id_docker_does_not_know_twice_is_asked_again_only_after_a_minute() {
        use std::io::{Read, Write};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let d = tempdir("sampler-miss");
        let sock = d.join("docker.sock");
        let l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let asked = Arc::new(AtomicUsize::new(0));
        let n = asked.clone();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten() {
                let _ = s.read(&mut [0u8; 1024]);
                n.fetch_add(1, Ordering::SeqCst);
                let _ = s.write_all(b"HTTP/1.0 200 OK\r\n\r\n[]");
            }
        });
        let mut s = Sampler::new(SamplerCfg { proc_root: d.join("proc"), cg_root: d.join("cg"), docker_sock: sock, interval_ms: 2000 });
        let cgs = vec![CgRaw { id: "f".repeat(64), cpu_usec: 0, mem_current: 0, inactive_file: 0, mem_max: None }];
        s.refresh_names(&cgs);
        s.refresh_names(&cgs);
        assert_eq!(asked.load(Ordering::SeqCst), 2, "a first miss is asked again on the next tick");
        s.refresh_names(&cgs);
        assert_eq!(asked.load(Ordering::SeqCst), 2, "a repeat miss is remembered");
        let old = Instant::now().checked_sub(Duration::from_secs(61)).unwrap();
        s.misses.values_mut().for_each(|t| *t = Some(old));
        s.refresh_names(&cgs);
        assert_eq!(asked.load(Ordering::SeqCst), 3, "asked again after a minute");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn host_process_is_grouped_as_host() {
        let d = tempdir("sampler-host");
        let (p, c) = (d.join("proc"), d.join("cg"));
        let mut s = Sampler::new(SamplerCfg { proc_root: p.clone(), cg_root: c.clone(), docker_sock: d.join("none.sock"), interval_ms: 2000 });
        world(&p, &c, &"e".repeat(64), 1000, 0, 0);
        fs::write(p.join("77/cgroup"), "0::/init.scope\n").unwrap();
        s.tick();
        world(&p, &c, &"e".repeat(64), 2000, 0, 100);
        fs::write(p.join("77/cgroup"), "0::/init.scope\n").unwrap();
        let snap = s.tick().unwrap();
        assert_eq!(snap.processes[0].container, "host");
        fs::remove_dir_all(d).unwrap();
    }
}
