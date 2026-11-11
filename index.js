import { spawn } from "node:child_process";
import process from "node:process";

const server = spawn(
  process.execPath,
  ["--import", "tsx", "server/index.ts"],
  { env: process.env, stdio: "inherit" },
);
let forwardedSignal;

server.once("error", (error) => {
  console.error("Não foi possível iniciar o servidor UNO ARENA:", error);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    forwardedSignal = signal;
    server.kill(signal);
  });
}

server.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === forwardedSignal ? 0 : 1);
});
