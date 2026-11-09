//! The process walk: every numeric `/proc/<pid>` (no threads), its container from the cgroup path, then per-name sums. One file read per process and tick (`stat`); `cgroup` is read once per process lifetime.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;

/// One process as read on one tick. `container` is the 64-hex docker id, `None` for a host process.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcRaw {
    pub pid: u32,
    pub comm: String,
    pub jiffies: u64,
    pub rss: u64,
    pub container: Option<String>,
    /// start time in jiffies since boot (stat field 22)
    pub start: u64,
}

/// Same-named processes of one container summed over one interval.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcAgg {
    pub comm: String,
    pub pids: Vec<u32>,
    pub cpu_pct: f64,
    pub rss: u64,
    pub container: Option<String>,
}

/// What one `/proc/<pid>/stat` read gives.
#[derive(Debug, Clone, PartialEq)]
pub struct PidStat {
    pub comm: String,
    /// utime + stime
    pub jiffies: u64,
    /// field 22, in jiffies since boot: with the pid it names one process, since pids are reused
    pub start: u64,
    /// field 24, resident pages: the same count `statm` gives, so that file is not read too
    pub rss_pages: u64,
}

/// `/proc/<pid>/stat`; the comm may hold spaces and parentheses, so it ends at the last `)`. `rss_pages` is 0 when the line is cut before field 24.
pub fn parse_pid_stat(s: &str) -> Option<PidStat> {
    let open = s.find('(')?;
    let close = s.rfind(')')?;
    if close < open {
        return None;
    }
    let comm = s[open + 1..close].to_string();
    let f: Vec<&str> = s[close + 1..].split_whitespace().collect();
    let utime: u64 = f.get(11)?.parse().ok()?;
    let stime: u64 = f.get(12)?.parse().ok()?;
    let start = f.get(19).and_then(|x| x.parse().ok()).unwrap_or(0);
    let rss_pages = f.get(21).and_then(|x| x.parse().ok()).unwrap_or(0);
    Some(PidStat { comm, jiffies: utime + stime, start, rss_pages })
}

pub(crate) fn is_docker_id(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The docker container id in a `/proc/<pid>/cgroup` path (`docker-<id>.scope` or `/docker/<id>`), `None` for the host.
pub fn parse_cgroup(s: &str) -> Option<String> {
    s.lines().flat_map(|l| l.splitn(3, ':').nth(2).unwrap_or("").split('/')).find_map(|seg| {
        let id = seg.strip_prefix("docker-").and_then(|x| x.strip_suffix(".scope")).unwrap_or(seg);
        is_docker_id(id).then(|| id.to_string())
    })
}

/// The page size from `/proc/self/auxv` (`AT_PAGESZ` = 6 among native-endian u64 pairs), 4096 when unreadable.
pub fn page_size() -> u64 {
    static PAGE: OnceLock<u64> = OnceLock::new();
    *PAGE.get_or_init(|| {
        let b = fs::read("/proc/self/auxv").unwrap_or_default();
        b.chunks_exact(16)
            .map(|c| (u64::from_ne_bytes(c[..8].try_into().unwrap()), u64::from_ne_bytes(c[8..].try_into().unwrap())))
            .find(|&(k, _)| k == 6)
            .map(|(_, v)| v)
            .filter(|&v| v > 0)
            .unwrap_or(4096)
    })
}

/// The walk with its memory: each process's container, by pid and start time. A process does not change container, so its `cgroup` file is read once, on the first tick that sees it.
#[derive(Default)]
pub struct Walker {
    containers: HashMap<u32, (u64, Option<String>)>,
    buf: String,
}

impl Walker {
    /// Every process under `proc_root`; a pid whose files vanish mid-read and kernel threads (no resident pages) are skipped. Forgets the processes that are gone.
    pub fn walk(&mut self, proc_root: &Path) -> Vec<ProcRaw> {
        let page = page_size();
        let Ok(rd) = fs::read_dir(proc_root) else { return Vec::new() };
        let mut out = Vec::new();
        let mut seen = HashMap::with_capacity(self.containers.len());
        for e in rd.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
            let dir = e.path();
            self.buf.clear();
            let Ok(mut f) = fs::File::open(dir.join("stat")) else { continue };
            if f.read_to_string(&mut self.buf).is_err() {
                continue;
            }
            let Some(st) = parse_pid_stat(&self.buf) else { continue };
            if st.rss_pages == 0 {
                continue; // kernel thread
            }
            let container = match self.containers.get(&pid) {
                Some((start, c)) if *start == st.start => c.clone(),
                _ => match fs::read_to_string(dir.join("cgroup")) {
                    Ok(cg) => parse_cgroup(&cg),
                    Err(_) => continue,
                },
            };
            seen.insert(pid, (st.start, container.clone()));
            out.push(ProcRaw { pid, comm: st.comm, jiffies: st.jiffies, rss: st.rss_pages * page, container, start: st.start });
        }
        self.containers = seen;
        out
    }
}

/// One walk without memory, for one-off reads.
pub fn walk(proc_root: &Path) -> Vec<ProcRaw> {
    Walker::default().walk(proc_root)
}

/// Sums `cur` per `(container, comm)`; CPU is the jiffies delta against `prev` as a share of the host's delta (0-100). A pid absent from `prev` that started after every process `prev` saw was born since that walk, so all its jiffies count; one that started earlier (the walk skipped it, or `prev` is empty because the walk failed) would count its whole lifetime, so it contributes 0, as does a pid reused under another name or container, or whose counter went back. Keeps entries with CPU above 0 or more than 1 MiB resident.
pub fn aggregate(prev: &[ProcRaw], cur: &[ProcRaw], host_delta_jiffies: u64) -> Vec<ProcAgg> {
    let before: HashMap<u32, &ProcRaw> = prev.iter().map(|p| (p.pid, p)).collect();
    let newest = prev.iter().map(|p| p.start).max();
    let mut groups: HashMap<(Option<&str>, &str), (Vec<u32>, u64, u64)> = HashMap::new();
    for p in cur {
        let d = match before.get(&p.pid) {
            Some(b) if b.comm == p.comm && b.container == p.container => p.jiffies.saturating_sub(b.jiffies),
            Some(_) => 0,
            // known limit: a process born and gone between two walks is never seen, and a process's CPU between its last walk and its exit is lost (both still count in the container's cgroup total)
            None if newest.is_some_and(|n| p.start > n) => p.jiffies,
            None => 0,
        };
        let g = groups.entry((p.container.as_deref(), p.comm.as_str())).or_default();
        g.0.push(p.pid);
        g.1 += d;
        g.2 += p.rss;
    }
    let mut out: Vec<ProcAgg> = groups
        .into_iter()
        .map(|((container, comm), (mut pids, d, rss))| {
            pids.sort_unstable();
            let cpu_pct = if host_delta_jiffies == 0 { 0.0 } else { (d as f64 / host_delta_jiffies as f64 * 100.0).min(100.0) };
            ProcAgg { comm: comm.to_string(), pids, cpu_pct, rss, container: container.map(str::to_string) }
        })
        .filter(|a| a.cpu_pct > 0.0 || a.rss > 1 << 20)
        .collect();
    out.sort_by(|a, b| b.cpu_pct.total_cmp(&a.cpu_pct).then(b.rss.cmp(&a.rss)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tempdir;
    use std::fs;

    #[test]
    fn pid_stat_splits_at_the_last_paren() {
        assert_eq!(parse_pid_stat("123 (Web Content) S 1 1 1 0 -1 4194560 0 0 0 0 7 3 0 0 20 0 1 0 100 5000 300 0\n"), Some(PidStat { comm: "Web Content".into(), jiffies: 10, start: 100, rss_pages: 300 }));
        assert_eq!(parse_pid_stat("1 (a) b) R 0 0 0 0 0 0 0 0 0 0 1 2 0 0\n"), Some(PidStat { comm: "a) b".into(), jiffies: 3, start: 0, rss_pages: 0 }));
        assert_eq!(parse_pid_stat("garbage\n"), None);
    }

    #[test]
    fn cgroup_finds_the_docker_id_in_both_layouts_and_none_for_host() {
        let id = "a".repeat(64);
        assert_eq!(parse_cgroup(&format!("0::/system.slice/docker-{id}.scope\n")), Some(id.clone()));
        assert_eq!(parse_cgroup(&format!("0::/docker/{id}\n")), Some(id.clone()));
        assert_eq!(parse_cgroup("0::/init.scope\n"), None);
        assert_eq!(parse_cgroup("0::/\n"), None);
    }

    #[test]
    fn walk_skips_a_vanished_pid() {
        let dir = tempdir("walk");
        let id = "c".repeat(64);
        for pid in ["7", "4242"] {
            let p = dir.join(pid);
            fs::create_dir_all(&p).unwrap();
            fs::write(p.join("stat"), format!("{pid} (node) S 1 1 1 0 -1 0 0 0 0 0 5 5 0 0 20 0 1 0 100 1000 10\n")).unwrap();
            fs::write(p.join("cgroup"), format!("0::/system.slice/docker-{id}.scope\n")).unwrap();
        }
        fs::create_dir_all(dir.join("self")).unwrap();
        fs::remove_file(dir.join("4242/cgroup")).unwrap();
        let procs = walk(&dir);
        assert!(procs.iter().all(|p| p.pid != 4242));
        let p = procs.iter().find(|p| p.pid == 7).expect("complete pid listed");
        assert_eq!((p.comm.as_str(), p.jiffies, p.rss, p.container.as_deref()), ("node", 10, 10 * page_size(), Some(id.as_str())));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn walker_reads_cgroup_once_per_process() {
        let dir = tempdir("walker");
        let (a, b) = ("a".repeat(64), "b".repeat(64));
        let p = dir.join("7");
        fs::create_dir_all(&p).unwrap();
        let stat = |start: u32| format!("7 (node) S 1 1 1 0 -1 0 0 0 0 0 5 5 0 0 20 0 1 0 {start} 1000 10\n");
        fs::write(p.join("stat"), stat(100)).unwrap();
        fs::write(p.join("cgroup"), format!("0::/system.slice/docker-{a}.scope\n")).unwrap();
        let mut w = Walker::default();
        assert_eq!(w.walk(&dir)[0].container.as_deref(), Some(a.as_str()));
        // same process: the remembered container, even with the file gone
        fs::remove_file(p.join("cgroup")).unwrap();
        assert_eq!(w.walk(&dir)[0].container.as_deref(), Some(a.as_str()));
        // the pid reused by a new process (other start time): read again
        fs::write(p.join("stat"), stat(200)).unwrap();
        fs::write(p.join("cgroup"), format!("0::/docker/{b}\n")).unwrap();
        assert_eq!(w.walk(&dir)[0].container.as_deref(), Some(b.as_str()));
        // gone: forgotten
        fs::remove_dir_all(&p).unwrap();
        assert!(w.walk(&dir).is_empty() && w.containers.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn walk_drops_kernel_threads() {
        let dir = tempdir("kthread");
        let p = dir.join("2");
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("stat"), "2 (kthreadd) S 0 0 0 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 1 0 0\n").unwrap();
        fs::write(p.join("cgroup"), "0::/\n").unwrap();
        assert!(walk(&dir).is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn aggregate_sums_same_name_per_container_and_drops_idle_small() {
        let c = Some("b".repeat(64));
        let prev = vec![ProcRaw { pid: 1, comm: "node".into(), jiffies: 100, rss: 0, container: c.clone(), start: 0 }, ProcRaw { pid: 2, comm: "node".into(), jiffies: 100, rss: 0, container: c.clone(), start: 0 }];
        let cur = vec![ProcRaw { pid: 1, comm: "node".into(), jiffies: 150, rss: 4 << 20, container: c.clone(), start: 0 }, ProcRaw { pid: 2, comm: "node".into(), jiffies: 150, rss: 4 << 20, container: c.clone(), start: 0 }, ProcRaw { pid: 3, comm: "sleep".into(), jiffies: 0, rss: 100, container: None, start: 0 }];
        let a = aggregate(&prev, &cur, 400);
        assert_eq!(a.len(), 1);
        assert_eq!((a[0].comm.as_str(), a[0].pids.clone(), a[0].cpu_pct, a[0].rss), ("node", vec![1, 2], 25.0, 8 << 20));
    }

    #[test]
    fn aggregate_ignores_a_reused_pid_and_a_counter_going_back() {
        let prev = vec![ProcRaw { pid: 1, comm: "git".into(), jiffies: 100, rss: 0, container: None, start: 0 }, ProcRaw { pid: 2, comm: "node".into(), jiffies: 900, rss: 0, container: None, start: 0 }];
        let cur = vec![ProcRaw { pid: 1, comm: "claude".into(), jiffies: 300, rss: 0, container: None, start: 0 }, ProcRaw { pid: 2, comm: "node".into(), jiffies: 10, rss: 0, container: None, start: 0 }];
        assert!(aggregate(&prev, &cur, 400).is_empty());
    }

    #[test]
    fn aggregate_counts_a_process_born_since_the_last_walk_whole() {
        let prev = vec![ProcRaw { pid: 1, comm: "bash".into(), jiffies: 5, rss: 0, container: None, start: 100 }];
        let cur = vec![ProcRaw { pid: 1, comm: "bash".into(), jiffies: 5, rss: 0, container: None, start: 100 }, ProcRaw { pid: 9, comm: "git".into(), jiffies: 40, rss: 0, container: None, start: 200 }];
        let a = aggregate(&prev, &cur, 400);
        assert_eq!((a.len(), a[0].comm.as_str(), a[0].cpu_pct), (1, "git", 10.0), "all its CPU time fell in this interval");
    }

    #[test]
    fn aggregate_never_counts_the_lifetime_of_a_process_the_last_walk_missed() {
        // the previous walk failed (empty) or skipped a pid that started before the newest process it saw: its jiffies are a lifetime, not this interval
        let old = ProcRaw { pid: 8, comm: "node".into(), jiffies: 90_000, rss: 0, container: None, start: 50 };
        assert!(aggregate(&[], std::slice::from_ref(&old), 400).is_empty());
        let prev = vec![ProcRaw { pid: 1, comm: "bash".into(), jiffies: 5, rss: 0, container: None, start: 100 }];
        assert!(aggregate(&prev, &[old], 400).is_empty());
    }
}
