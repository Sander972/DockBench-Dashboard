//! Container totals from cgroup v2: the docker scopes under `/sys/fs/cgroup`, the files Docker's own stats are computed from.

use std::fs;
use crate::procs::is_docker_id;
use std::path::Path;

/// One container's cumulative CPU time and memory as read on one tick.
#[derive(Debug, Clone, PartialEq)]
pub struct CgRaw {
    pub id: String,
    pub cpu_usec: u64,
    pub mem_current: u64,
    pub inactive_file: u64,
    pub mem_max: Option<u64>,
}

/// `usage_usec` of a `cpu.stat` file.
pub fn parse_cpu_stat(s: &str) -> Option<u64> {
    s.lines().find_map(|l| l.strip_prefix("usage_usec ")?.trim().parse().ok())
}

/// `inactive_file` of a `memory.stat` file, 0 when absent.
pub fn parse_memory_stat_inactive_file(s: &str) -> u64 {
    s.lines().find_map(|l| l.strip_prefix("inactive_file ")?.trim().parse().ok()).unwrap_or(0)
}

/// `memory.max`: `None` for `max` (no limit).
pub fn parse_memory_max(s: &str) -> Option<u64> {
    s.trim().parse().ok()
}

/// Reads one cgroup directory; `None` when its CPU or memory files cannot be read.
pub fn read_one(dir: &Path, id: &str) -> Option<CgRaw> {
    let cpu_usec = parse_cpu_stat(&fs::read_to_string(dir.join("cpu.stat")).ok()?)?;
    let mem_current = fs::read_to_string(dir.join("memory.current")).ok()?.trim().parse().ok()?;
    let inactive_file = fs::read_to_string(dir.join("memory.stat")).map(|s| parse_memory_stat_inactive_file(&s)).unwrap_or(0);
    let mem_max = fs::read_to_string(dir.join("memory.max")).ok().and_then(|s| parse_memory_max(&s));
    Some(CgRaw { id: id.to_string(), cpu_usec, mem_current, inactive_file, mem_max })
}


/// Every docker container cgroup under `cg_root`, in the systemd layout (`system.slice/docker-<id>.scope`) and the cgroupfs one (`docker/<id>`).
pub fn list(cg_root: &Path) -> Vec<CgRaw> {
    let mut out = Vec::new();
    for (sub, prefix, suffix) in [("system.slice", "docker-", ".scope"), ("docker", "", "")] {
        let Ok(rd) = fs::read_dir(cg_root.join(sub)) else { continue };
        for e in rd.flatten() {
            let name = e.file_name();
            let Some(id) = name.to_str().and_then(|n| n.strip_prefix(prefix)?.strip_suffix(suffix)) else { continue };
            if is_docker_id(id) {
                out.extend(read_one(&e.path(), id));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tempdir;
    use std::fs;

    #[test]
    fn cgroup_files_parse() {
        assert_eq!(parse_cpu_stat("usage_usec 123456\nuser_usec 1\nsystem_usec 2\n"), Some(123456));
        assert_eq!(parse_memory_stat_inactive_file("anon 10\nfile 20\ninactive_file 7\nactive_file 13\n"), 7);
        assert_eq!(parse_memory_max("max\n"), None);
        assert_eq!(parse_memory_max("2147483648\n"), Some(2147483648));
    }

    fn scope(dir: &std::path::Path, usec: u64) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("cpu.stat"), format!("usage_usec {usec}\nuser_usec 1\n")).unwrap();
        fs::write(dir.join("memory.current"), "5000\n").unwrap();
        fs::write(dir.join("memory.stat"), "anon 1\ninactive_file 1000\n").unwrap();
        fs::write(dir.join("memory.max"), "max\n").unwrap();
    }

    #[test]
    fn read_one_reads_a_scope_dir() {
        let d = tempdir("cg-one");
        scope(&d, 42);
        assert_eq!(read_one(&d, "x"), Some(CgRaw { id: "x".into(), cpu_usec: 42, mem_current: 5000, inactive_file: 1000, mem_max: None }));
        assert_eq!(read_one(&d.join("missing"), "y"), None);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn list_scans_both_layouts_and_skips_other_dirs() {
        let root = tempdir("cg-list");
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        scope(&root.join(format!("system.slice/docker-{a}.scope")), 1);
        scope(&root.join(format!("docker/{b}")), 2);
        scope(&root.join("system.slice/cron.service"), 3);
        let mut ids: Vec<(String, u64)> = list(&root).into_iter().map(|c| (c.id, c.cpu_usec)).collect();
        ids.sort();
        assert_eq!(ids, vec![(a, 1), (b, 2)]);
        fs::remove_dir_all(root).unwrap();
    }
}
