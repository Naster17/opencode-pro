import path from "node:path"
import { mkdir } from "node:fs/promises"

const outfile = path.join(process.cwd(), ".artifacts", "unit", "junit.xml")
await mkdir(path.dirname(outfile), { recursive: true })

const proc = Bun.spawn(
  [process.execPath, "test", "--timeout", "60000", "--reporter=junit", `--reporter-outfile=${outfile}`],
  {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  },
)

const code = await proc.exited
process.exit(code)
