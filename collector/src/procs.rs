//! The process walk: every numeric `/proc/<pid>` (no threads), its container from the cgroup path, then per-name sums.

use std::collections::HashMap;
use std::fs;
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

/// `(comm, utime + stime)` from `/proc/<pid>/stat`; the comm may hold spaces and parentheses, so it ends at the last `)`.
pub fn parse_pid_stat(s: &str) -> Option<(String, u64)> {
    let open = s.find('(')?;
    let close = s.rfind(')')?;
    if close < open {
        return None;
    }
    let comm = s[open + 1..close].to_string();
    let f: Vec<&str> = s[close + 1..].split_whitespace().collect();
    let utime: u64 = f.get(11)?.parse().ok()?;
    let stime: u64 = f.get(12)?.parse().ok()?;
    Some((comm, utime + stime))
}

/// Resident set size in bytes from `/proc/<pid>/statm` (second field, in pages); 0 when unreadable.
pub fn parse_statm_rss(s: &str, page: u64) -> u64 {
    s.split_whitespace().nth(1).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0) * page
}

fn is_docker_id(s: &str) -> bool {
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

fn read_pid(dir: &Path, pid: u32, page: u64) -> Option<ProcRaw> {
    let (comm, jiffies) = parse_pid_stat(&fs::read_to_string(dir.join("stat")).ok()?)?;
    let rss = parse_statm_rss(&fs::read_to_string(dir.join("statm")).ok()?, page);
    if rss == 0 {
        return None; // kernel thread
    }
    let container = parse_cgroup(&fs::read_to_string(dir.join("cgroup")).ok()?);
    Some(ProcRaw { pid, comm, jiffies, rss, container })
}

/// Every process under `proc_root`; a pid whose files vanish mid-read and kernel threads are skipped.
pub fn walk(proc_root: &Path) -> Vec<ProcRaw> {
    let page = page_size();
    let Ok(rd) = fs::read_dir(proc_root) else { return Vec::new() };
    rd.flatten()
        .filter_map(|e| {
            let pid: u32 = e.file_name().to_str()?.parse().ok()?;
            read_pid(&e.path(), pid, page)
        })
        .collect()
}

/// Sums `cur` per `(container, comm)`; CPU is the jiffies delta against `prev` as a share of the host's delta (0-100). A pid absent from `prev`, reused under another name or container, or whose counter went back contributes 0. Keeps entries with CPU above 0 or more than 1 MiB resident.
pub fn aggregate(prev: &[ProcRaw], cur: &[ProcRaw], host_delta_jiffies: u64) -> Vec<ProcAgg> {
    let before: HashMap<u32, &ProcRaw> = prev.iter().map(|p| (p.pid, p)).collect();
    let mut groups: HashMap<(Option<&str>, &str), (Vec<u32>, u64, u64)> = HashMap::new();
    for p in cur {
        let d = match before.get(&p.pid) {
            Some(b) if b.comm == p.comm && b.container == p.container => p.jiffies.saturating_sub(b.jiffies),
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
        assert_eq!(parse_pid_stat("123 (Web Content) S 1 1 1 0 -1 4194560 0 0 0 0 7 3 0 0 20 0 1 0 100 0 0\n"), Some(("Web Content".into(), 10)));
        assert_eq!(parse_pid_stat("1 (a) b) R 0 0 0 0 0 0 0 0 0 0 1 2 0 0\n"), Some(("a) b".into(), 3)));
    }

    #[test]
    fn statm_rss_is_resident_pages_times_page_size() {
        assert_eq!(parse_statm_rss("5000 300 100 1 0 200 0\n", 4096), 300 * 4096);
        assert_eq!(parse_statm_rss("garbage\n", 4096), 0);
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
            fs::write(p.join("stat"), format!("{pid} (node) S 1 1 1 0 -1 0 0 0 0 0 5 5 0 0 20 0 1 0 100 0 0\n")).unwrap();
            fs::write(p.join("cgroup"), format!("0::/system.slice/docker-{id}.scope\n")).unwrap();
            fs::write(p.join("statm"), "100 10 0 0 0 0 0\n").unwrap();
        }
        fs::create_dir_all(dir.join("self")).unwrap();
        fs::remove_file(dir.join("4242/statm")).unwrap();
        let procs = walk(&dir);
        assert!(procs.iter().all(|p| p.pid != 4242));
        let p = procs.iter().find(|p| p.pid == 7).expect("complete pid listed");
        assert_eq!((p.comm.as_str(), p.jiffies, p.container.as_deref()), ("node", 10, Some(id.as_str())));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn walk_drops_kernel_threads() {
        let dir = tempdir("kthread");
        let p = dir.join("2");
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("stat"), "2 (kthreadd) S 0 0 0 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 1 0 0\n").unwrap();
        fs::write(p.join("cgroup"), "0::/\n").unwrap();
        fs::write(p.join("statm"), "0 0 0 0 0 0 0\n").unwrap();
        assert!(walk(&dir).is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn aggregate_sums_same_name_per_container_and_drops_idle_small() {
        let c = Some("b".repeat(64));
        let prev = vec![ProcRaw { pid: 1, comm: "node".into(), jiffies: 100, rss: 0, container: c.clone() }, ProcRaw { pid: 2, comm: "node".into(), jiffies: 100, rss: 0, container: c.clone() }];
        let cur = vec![ProcRaw { pid: 1, comm: "node".into(), jiffies: 150, rss: 4 << 20, container: c.clone() }, ProcRaw { pid: 2, comm: "node".into(), jiffies: 150, rss: 4 << 20, container: c.clone() }, ProcRaw { pid: 3, comm: "sleep".into(), jiffies: 0, rss: 100, container: None }];
        let a = aggregate(&prev, &cur, 400);
        assert_eq!(a.len(), 1);
        assert_eq!((a[0].comm.as_str(), a[0].pids.clone(), a[0].cpu_pct, a[0].rss), ("node", vec![1, 2], 25.0, 8 << 20));
    }

    #[test]
    fn aggregate_ignores_a_reused_pid_and_a_counter_going_back() {
        let prev = vec![ProcRaw { pid: 1, comm: "git".into(), jiffies: 100, rss: 0, container: None }, ProcRaw { pid: 2, comm: "node".into(), jiffies: 900, rss: 0, container: None }];
        let cur = vec![ProcRaw { pid: 1, comm: "claude".into(), jiffies: 300, rss: 0, container: None }, ProcRaw { pid: 2, comm: "node".into(), jiffies: 10, rss: 0, container: None }];
        assert!(aggregate(&prev, &cur, 400).is_empty());
    }
}
