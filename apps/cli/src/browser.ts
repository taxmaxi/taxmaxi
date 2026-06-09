import { spawn } from "node:child_process"

export const openBrowser = (url: string): boolean => {
  const command =
    process.platform === "darwin"
      ? { cmd: "open", args: [url] }
      : process.platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : { cmd: "xdg-open", args: [url] }

  try {
    const child = spawn(command.cmd, command.args, {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    return true
  } catch {
    return false
  }
}
