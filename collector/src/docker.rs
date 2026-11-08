//! Container names, images and the `dockbench` label from the Docker socket: only `GET /containers/json`, never the stats endpoint.

use serde::Deserialize;
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub dockbench: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Item {
    id: String,
    #[serde(default)]
    names: Vec<String>,
    #[serde(default)]
    image: String,
    #[serde(default)]
    labels: Option<HashMap<String, String>>,
}

/// The running containers, over one HTTP/1.0 request on the unix socket (the daemon closes the connection after the answer).
pub fn list_containers(sock: &Path) -> io::Result<Vec<ContainerInfo>> {
    let mut s = UnixStream::connect(sock)?;
    s.set_read_timeout(Some(Duration::from_secs(5)))?;
    s.set_write_timeout(Some(Duration::from_secs(5)))?;
    s.write_all(b"GET /containers/json HTTP/1.0\r\nHost: docker\r\n\r\n")?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf)?;
    let bad = |m: String| io::Error::new(io::ErrorKind::InvalidData, m);
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| bad("no header end".into()))?;
    let head = String::from_utf8_lossy(&buf[..split]);
    let status = head.lines().next().unwrap_or("");
    if status.split_whitespace().nth(1) != Some("200") {
        return Err(bad(format!("docker answered {status}")));
    }
    let items: Vec<Item> = serde_json::from_slice(&buf[split + 4..]).map_err(|e| bad(e.to_string()))?;
    Ok(items
        .into_iter()
        .map(|i| ContainerInfo {
            name: i.names.first().map(|n| n.trim_start_matches('/').to_string()).unwrap_or_else(|| i.id.chars().take(12).collect()),
            dockbench: i.labels.as_ref().and_then(|l| l.get("dockbench")).is_some_and(|v| v == "true"),
            image: i.image,
            id: i.id,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tempdir;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;

    fn fake_docker(status: &str, body: &str) -> (std::path::PathBuf, std::thread::JoinHandle<String>) {
        let sock = tempdir("docker").join("docker.sock");
        let l = UnixListener::bind(&sock).unwrap();
        let resp = format!("HTTP/1.0 {status}\r\nContent-Type: application/json\r\n\r\n{body}");
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut req = [0u8; 1024];
            let n = s.read(&mut req).unwrap();
            s.write_all(resp.as_bytes()).unwrap();
            String::from_utf8_lossy(&req[..n]).into_owned()
        });
        (sock, h)
    }

    #[test]
    fn docker_list_parses_names_images_and_label() {
        let (a, b) = ("a".repeat(64), "b".repeat(64));
        let body = format!(r#"[{{"Id":"{a}","Names":["/dockbench-shop"],"Image":"ghcr.io/x/dockbench:latest","Labels":{{"dockbench":"true"}}}},{{"Id":"{b}","Names":["/portainer"],"Image":"portainer/portainer-ce","Labels":{{}}}}]"#);
        let (sock, h) = fake_docker("200 OK", &body);
        let got = list_containers(&sock).unwrap();
        assert!(h.join().unwrap().starts_with("GET /containers/json HTTP/1.0\r\n"));
        assert_eq!(got, vec![
            ContainerInfo { id: a, name: "dockbench-shop".into(), image: "ghcr.io/x/dockbench:latest".into(), dockbench: true },
            ContainerInfo { id: b, name: "portainer".into(), image: "portainer/portainer-ce".into(), dockbench: false },
        ]);
    }

    #[test]
    fn docker_list_fails_on_a_non_200_and_a_missing_socket() {
        let (sock, h) = fake_docker("500 Internal Server Error", "{}");
        assert!(list_containers(&sock).is_err());
        h.join().unwrap();
        assert!(list_containers(std::path::Path::new("/nonexistent/docker.sock")).is_err());
    }
}
