//! Read-only tests against the live system the dev container sees: shapes and ranges, never host-wide content.

use dockbench_collector::procs::walk;
use std::path::Path;

#[test]
fn walk_finds_this_test_process_by_comm() {
    let me = std::process::id();
    let procs = walk(Path::new("/proc"));
    let p = procs.iter().find(|p| p.pid == me).expect("own pid listed");
    assert!(p.rss > 0 && !p.comm.is_empty());
}

#[test]
fn host_reads_from_the_live_system() {
    let h = dockbench_collector::proc::read_host().unwrap();
    assert!(h.cpu.total > 0 && h.cpu.busy <= h.cpu.total && h.cpu.ncpu >= 1);
    assert!(h.mem.total > 0 && h.mem.used <= h.mem.total);
    assert!(h.load.0 >= 0.0 && (0.0..=100.0).contains(&h.psi));
}
