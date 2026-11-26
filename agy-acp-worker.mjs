import net from "node:net";
import { spawn } from "node:child_process";

const PORT = Number(process.env.AGY_ACP_WORKER_PORT || "18796");
const AGY_BIN = process.env.AGY_BIN || "agy";

const server = net.createServer((socket) => {
  const proc = spawn(AGY_BIN, ["acp", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  socket.pipe(proc.stdin);
  proc.stdout.pipe(socket);

  const cleanup = () => {
    try { proc.kill(); } catch {}
    try { socket.destroy(); } catch {}
  };

  socket.on("close", cleanup);
  socket.on("error", cleanup);
  proc.on("exit", () => {
    try { socket.end(); } catch {}
  });
});

server.listen(PORT, "127.0.0.1");
