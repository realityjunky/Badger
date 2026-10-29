import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { sha256 } from "../util.js";

const execFileAsync = promisify(execFile);
let cachedHostIdentity: Promise<string | null> | undefined;

async function readHostIdentity(): Promise<string | null> {
  try {
    let parts: string[];
    if (process.platform === "linux") {
      // PIDs are comparable only within the same boot and PID namespace.
      parts = await Promise.all([
        fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        fs.readlink("/proc/self/ns/pid"),
      ]);
    } else if (process.platform === "darwin") {
      const result = await execFileAsync(
        "/usr/sbin/sysctl",
        ["-n", "kern.hostuuid", "kern.boottime"],
        { timeout: 3_000, maxBuffer: 16 * 1024 },
      );
      parts = result.stdout.trim().split("\n");
    } else if (process.platform === "win32") {
      const executable = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const result = await execFileAsync(
        executable,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance Win32_ComputerSystemProduct).UUID; (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('O')",
        ],
        { timeout: 3_000, maxBuffer: 16 * 1024, windowsHide: true },
      );
      parts = result.stdout.trim().split(/\r?\n/u);
    } else {
      return null;
    }
    if (parts.length !== 2 || parts.some((part) => !part.trim())) return null;
    return sha256(
      JSON.stringify([
        "badger-run-host-v1",
        process.platform,
        ...parts.map((part) => part.trim()),
      ]),
    );
  } catch {
    // An unavailable identity must never turn a foreign PID into a local one.
    return null;
  }
}

export function workflowRunHostIdentity(): Promise<string | null> {
  return (cachedHostIdentity ??= readHostIdentity());
}
