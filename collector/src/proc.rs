//! Host-wide figures from `/proc` (not namespaced, so a container sees the whole host).

use serde::Serialize;
use std::fs;
use std::io;
use std::path::Path;

/// Cumulative jiffies of the `cpu` line of `/proc/stat`, plus the number of cores.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct CpuTimes {
    pub busy: u64,
    pub total: u64,
    pub steal: u64,
    pub iowait: u64,
    pub ncpu: u32,
}

/// Host memory in bytes; `used` is `MemTotal - MemAvailable`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct Mem {
    pub total: u64,
    pub used: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct HostRaw {
    pub cpu: CpuTimes,
    pub mem: Mem,
    pub load: (f64, f64, f64),
    pub psi: f64,
}

/// Parses `/proc/stat`: `total` sums the first eight columns (user..steal), `busy = total - idle - iowait`.
pub fn parse_stat(s: &str) -> Option<CpuTimes> {
    let mut cpu = None;
    let mut ncpu = 0u32;
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix("cpu") {
            if rest.starts_with(|c: char| c.is_ascii_digit()) {
                ncpu += 1;
            } else if rest.starts_with(' ') {
                let v: Vec<u64> = rest.split_whitespace().take(8).map(|x| x.parse().unwrap_or(0)).collect();
                if v.len() < 8 {
                    return None;
                }
                let total: u64 = v.iter().sum();
                cpu = Some(CpuTimes { busy: total.saturating_sub(v[3] + v[4]), total, steal: v[7], iowait: v[4], ncpu: 0 });
            }
        }
    }
    cpu.map(|c| CpuTimes { ncpu: ncpu.max(1), ..c })
}

fn meminfo_kb(s: &str, key: &str) -> Option<u64> {
    s.lines().find_map(|l| l.strip_prefix(key)?.strip_prefix(':')?.split_whitespace().next()?.parse().ok())
}

pub fn parse_meminfo(s: &str) -> Option<Mem> {
    let total = meminfo_kb(s, "MemTotal")? * 1024;
    let avail = meminfo_kb(s, "MemAvailable")? * 1024;
    Some(Mem { total, used: total.saturating_sub(avail) })
}

pub fn parse_loadavg(s: &str) -> Option<(f64, f64, f64)> {
    let mut it = s.split_whitespace().map(|x| x.parse::<f64>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

/// The `avg10` of the `some` line of a PSI file such as `/proc/pressure/cpu`.
pub fn parse_pressure_some10(s: &str) -> Option<f64> {
    let line = s.lines().find(|l| l.starts_with("some "))?;
    line.split_whitespace().find_map(|f| f.strip_prefix("avg10=")?.parse().ok())
}

/// Reads the host figures under `root` (normally `/proc`); PSI reads 0 when the kernel has no pressure files.
pub fn read_host_at(root: &Path) -> io::Result<HostRaw> {
    let bad = |what: &str| io::Error::new(io::ErrorKind::InvalidData, format!("cannot parse {what}"));
    let cpu = parse_stat(&fs::read_to_string(root.join("stat"))?).ok_or_else(|| bad("stat"))?;
    let mem = parse_meminfo(&fs::read_to_string(root.join("meminfo"))?).ok_or_else(|| bad("meminfo"))?;
    let load = parse_loadavg(&fs::read_to_string(root.join("loadavg"))?).ok_or_else(|| bad("loadavg"))?;
    let psi = fs::read_to_string(root.join("pressure/cpu")).ok().and_then(|s| parse_pressure_some10(&s)).unwrap_or(0.0);
    Ok(HostRaw { cpu, mem, load, psi })
}

pub fn read_host() -> io::Result<HostRaw> {
    read_host_at(Path::new("/proc"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_sums_eight_columns_and_counts_cores() {
        let c = parse_stat("cpu  100 0 100 700 100 0 0 50 0 0\ncpu0 1 2 3 4\ncpu1 1 2 3 4\nintr 0\n").unwrap();
        assert_eq!((c.busy, c.total, c.steal, c.iowait, c.ncpu), (250, 1050, 50, 100, 2));
    }

    #[test]
    fn meminfo_used_is_total_minus_available_in_bytes() {
        let m = parse_meminfo("MemTotal:       8000 kB\nMemFree:         1000 kB\nMemAvailable:    3000 kB\n").unwrap();
        assert_eq!((m.total, m.used), (8000 * 1024, 5000 * 1024));
    }

    #[test]
    fn loadavg_and_pressure_parse() {
        assert_eq!(parse_loadavg("27.02 22.89 17.52 19/1097 11471\n"), Some((27.02, 22.89, 17.52)));
        assert_eq!(parse_pressure_some10("some avg10=81.53 avg60=84.93 avg300=83.61 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"), Some(81.53));
        assert_eq!(parse_stat("intr 0\n"), None);
    }
}
