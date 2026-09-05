# SSH sailing

Single-handed dinghy sailing in your terminal — the first game built on
[`@tellus/engine`](../../packages/engine/README.md).

```bash
ssh -p 4010 <host>
```

Trim the sail, mind the true wind, round the buoys. The ocean is a sum of
travelling waves evaluated per vertex; the boat heels and accelerates from a
small physical model of sail force vs. apparent wind.

```
src/
  server/    ssh2 server + session (input, HUD, ANSI diffing)
  sailing/   the boat physics: wind, hull, sail forces
  scene/     scene assembly: ocean mesh, boat, buoys, chase camera
```

On first run the server prints the `ssh-keygen` command for its host key
(`assets/host.key`, gitignored). `SAIL_PORT` overrides the port.
