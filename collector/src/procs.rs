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

/// The host's uptime from `uptime` under `proc_root`, in jiffies since boot like a process's start time (USER_HZ is 100); `None` when unreadable.
pub fn uptime_jiffies(proc_root: &Path) -> Option<u64> {
    let s = fs::read_to_string(proc_root.join("uptime")).ok()?;
    let secs: f64 = s.split_whitespace().next()?.parse().ok()?;
    Some((secs * 100.0).round() as u64)
}

/// Sums `cur` per `(container, comm)`; CPU is the jiffies delta against `prev` as a share of the host's delta (0-100). A pid is the same process as in `prev` when its start time matches (a renamed process keeps counting). A new process, or a reused pid, that started at or after `prev_at` (the uptime in jiffies when the previous walk began) was born since that walk, so all its jiffies count; one that started earlier (the walk skipped it or failed), or any unseen pid when `prev_at` is unknown, would count its whole lifetime, so it contributes 0, as does a counter that went back. Keeps entries with CPU above 0 or more than 1 MiB resident.
pub fn aggregate(prev: &[ProcRaw], prev_at: Option<u64>, cur: &[ProcRaw], host_delta_jiffies: u64) -> Vec<ProcAgg> {
    let before: HashMap<u32, &ProcRaw> = prev.iter().map(|p| (p.pid, p)).collect();
    let mut groups: HashMap<(Option<&str>, &str), (Vec<u32>, u64, u64)> = HashMap::new();
    for p in cur {
        let d = match before.get(&p.pid) {
            Some(b) if b.start == p.start => p.jiffies.saturating_sub(b.jiffies),
            // known limit: a process born and gone between two walks is never seen, and a process's CPU between its last walk and its exit is lost (both still count in the container's cgroup total)
            _ if prev_at.is_some_and(|t| p.start >= t) => p.jiffies,
            _ => 0,
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
        let a = aggregate(&prev, None, &cur, 400);
        assert_eq!(a.len(), 1);
        assert_eq!((a[0].comm.as_str(), a[0].pids.clone(), a[0].cpu_pct, a[0].rss), ("node", vec![1, 2], 25.0, 8 << 20));
    }

    #[test]
    fn aggregate_matches_a_pid_by_start_time() {
        let prev = vec![ProcRaw { pid: 1, comm: "git".into(), jiffies: 100, rss: 0, container: None, start: 10 }, ProcRaw { pid: 2, comm: "node".into(), jiffies: 900, rss: 0, container: None, start: 10 }, ProcRaw { pid: 3, comm: "git".into(), jiffies: 500, rss: 0, container: None, start: 20 }];
        // pid 1 was renamed by exec, pid 2's counter went back, pid 3 is a new git reusing the pid of one that exited
        let cur = vec![ProcRaw { pid: 1, comm: "claude".into(), jiffies: 140, rss: 0, container: None, start: 10 }, ProcRaw { pid: 2, comm: "node".into(), jiffies: 10, rss: 0, container: None, start: 10 }, ProcRaw { pid: 3, comm: "git".into(), jiffies: 80, rss: 0, container: None, start: 30 }];
        let a = aggregate(&prev, Some(25), &cur, 400);
        assert_eq!(a.iter().map(|x| (x.comm.as_str(), x.cpu_pct)).collect::<Vec<_>>(), vec![("git", 20.0), ("claude", 10.0)]);
    }

    #[test]
    fn aggregate_counts_a_process_born_since_the_last_walk_whole() {
        let prev = vec![ProcRaw { pid: 1, comm: "bash".into(), jiffies: 5, rss: 0, container: None, start: 100 }];
        let cur = vec![ProcRaw { pid: 1, comm: "bash".into(), jiffies: 5, rss: 0, container: None, start: 100 }, ProcRaw { pid: 9, comm: "git".into(), jiffies: 40, rss: 0, container: None, start: 200 }];
        let a = aggregate(&prev, Some(150), &cur, 400);
        assert_eq!((a.len(), a[0].comm.as_str(), a[0].cpu_pct), (1, "git", 10.0), "all its CPU time fell in this interval");
    }

    #[test]
    fn aggregate_never_counts_the_lifetime_of_a_process_the_last_walk_missed() {
        // the previous walk failed (empty) or skipped a pid that started before it: its jiffies are a lifetime, not this interval
        let old = ProcRaw { pid: 8, comm: "node".into(), jiffies: 90_000, rss: 0, container: None, start: 50 };
        assert!(aggregate(&[], Some(150), std::slice::from_ref(&old), 400).is_empty());
        let prev = vec![ProcRaw { pid: 1, comm: "bash".into(), jiffies: 5, rss: 0, container: None, start: 100 }];
        assert!(aggregate(&prev, Some(150), std::slice::from_ref(&old), 400).is_empty());
        // the previous walk's time unknown: any unseen pid, however late it started
        let late = ProcRaw { start: 500, ..old };
        assert!(aggregate(&prev, None, &[late], 400).is_empty());
    }

    #[test]
    fn aggregate_judges_an_unseen_pid_by_the_last_walks_time_not_by_the_newest_start_it_saw() {
        // a quiet host: the newest process the previous walk saw started at 1 s, the walk itself ran at 1 h; pid 8 started in between but was skipped (swapped out)
        let prev = vec![ProcRaw { pid: 1, comm: "bash".into(), jiffies: 5, rss: 0, container: None, start: 100 }];
        let skipped = ProcRaw { pid: 8, comm: "node".into(), jiffies: 90_000, rss: 0, container: None, start: 200_000 };
        assert!(aggregate(&prev, Some(360_000), &[skipped], 400).is_empty(), "a lifetime, not this interval");
        let born = ProcRaw { pid: 9, comm: "git".into(), jiffies: 40, rss: 0, container: None, start: 360_050 };
        let a = aggregate(&prev, Some(360_000), &[born], 400);
        assert_eq!((a.len(), a[0].comm.as_str(), a[0].cpu_pct), (1, "git", 10.0), "born since the previous walk: all its CPU time counts");
    }

    #[test]
    fn uptime_reads_jiffies_since_boot() {
        let dir = tempdir("uptime");
        assert_eq!(uptime_jiffies(&dir), None);
        fs::write(dir.join("uptime"), "3600.07 7000.00\n").unwrap();
        assert_eq!(uptime_jiffies(&dir), Some(360_007));
        fs::remove_dir_all(dir).unwrap();
    }
}
