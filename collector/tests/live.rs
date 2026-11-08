//! Read-only tests against the live system the dev container sees: shapes and ranges, never host-wide content.

#[test]
fn host_reads_from_the_live_system() {
    let h = dockbench_collector::proc::read_host().unwrap();
    assert!(h.cpu.total > 0 && h.cpu.busy <= h.cpu.total && h.cpu.ncpu >= 1);
    assert!(h.mem.total > 0 && h.mem.used <= h.mem.total);
    assert!(h.load.0 >= 0.0 && (0.0..=100.0).contains(&h.psi));
}
