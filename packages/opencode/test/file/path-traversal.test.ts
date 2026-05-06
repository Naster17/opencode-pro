import { test, expect, describe } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { containsPath } from "../../src/project/instance-context"
import { provideInstance, tmpdir } from "../fixture/fixture"

const run = <A, E>(eff: Effect.Effect<A, E, File.Service>) =>
  Effect.runPromise(provideInstance(Instance.directory)(eff.pipe(Effect.provide(File.defaultLayer))))
const read = (file: string) => run(File.Service.use((svc) => svc.read(file)))
const list = (dir?: string) => run(File.Service.use((svc) => svc.list(dir)))
const root = process.platform === "win32" ? "C:/" : "/"
const outside = (...parts: string[]) => path.join(root, ...parts)
const project = outside("project")
const projectSrc = path.join(project, "src")

describe("Filesystem.contains", () => {
  test("allows paths within project", () => {
    expect(Filesystem.contains(project, projectSrc)).toBe(true)
    expect(Filesystem.contains(project, path.join(projectSrc, "file.ts"))).toBe(true)
    expect(Filesystem.contains(project, project)).toBe(true)
  })

  test("blocks ../ traversal", () => {
    expect(Filesystem.contains(project, path.join(project, "..", "etc"))).toBe(false)
    expect(Filesystem.contains(project, path.join(projectSrc, "..", "..", "etc"))).toBe(false)
    expect(Filesystem.contains(project, outside("etc", "passwd"))).toBe(false)
  })

  test("blocks absolute paths outside project", () => {
    expect(Filesystem.contains(project, outside("etc", "passwd"))).toBe(false)
    expect(Filesystem.contains(project, outside("tmp", "file"))).toBe(false)
    expect(Filesystem.contains(outside("home", "user", "project"), outside("home", "user", "other"))).toBe(false)
  })

  test("handles prefix collision edge cases", () => {
    expect(Filesystem.contains(project, outside("project-other", "file"))).toBe(false)
    expect(Filesystem.contains(project, outside("projectfile"))).toBe(false)
  })
})

/*
 * Integration tests for read() and list() path traversal protection.
 *
 * These tests verify the HTTP API code path is protected. The HTTP endpoints
 * in server.ts (GET /file/content, GET /file) call read()/list()
 * directly - they do NOT go through ReadTool or the agent permission layer.
 *
 * This is a SEPARATE code path from ReadTool, which has its own checks.
 */
describe("File.read path traversal protection", () => {
  test("rejects ../ traversal attempting to read /etc/passwd", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "allowed.txt"), "allowed content")
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(read("../../../etc/passwd")).rejects.toThrow("Access denied: path escapes project directory")
      },
    })
  })

  test("rejects deeply nested traversal", async () => {
    await using tmp = await tmpdir()

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(read("src/nested/../../../../../../../etc/passwd")).rejects.toThrow(
          "Access denied: path escapes project directory",
        )
      },
    })
  })

  test("allows valid paths within project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "valid.txt"), "valid content")
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await read("valid.txt")
        expect(result.content).toBe("valid content")
      },
    })
  })
})

describe("File.list path traversal protection", () => {
  test("rejects ../ traversal attempting to list /etc", async () => {
    await using tmp = await tmpdir()

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(list("../../../etc")).rejects.toThrow("Access denied: path escapes project directory")
      },
    })
  })

  test("allows valid subdirectory listing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "file.txt"), "content")
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await list("subdir")
        expect(Array.isArray(result)).toBe(true)
      },
    })
  })
})

describe("containsPath", () => {
  test("returns true for path inside directory", async () => {
    await using tmp = await tmpdir({ git: true })

    await WithInstance.provide({
      directory: tmp.path,
      fn: () => {
        expect(containsPath(path.join(tmp.path, "foo.txt"), Instance.current)).toBe(true)
        expect(containsPath(path.join(tmp.path, "src", "file.ts"), Instance.current)).toBe(true)
      },
    })
  })

  test("returns true for path inside worktree but outside directory (monorepo subdirectory scenario)", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "packages", "lib")
    await fs.mkdir(subdir, { recursive: true })

    await WithInstance.provide({
      directory: subdir,
      fn: () => {
        // .opencode at worktree root, but we're running from packages/lib
        expect(containsPath(path.join(tmp.path, ".opencode", "state"), Instance.current)).toBe(true)
        // sibling package should also be accessible
        expect(containsPath(path.join(tmp.path, "packages", "other", "file.ts"), Instance.current)).toBe(true)
        // worktree root itself
        expect(containsPath(tmp.path, Instance.current)).toBe(true)
      },
    })
  })

  test("returns false for path outside both directory and worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const sibling = path.join(path.dirname(tmp.path), "other-project")

    await WithInstance.provide({
      directory: tmp.path,
      fn: () => {
        expect(containsPath(path.join(sibling, "passwd"), Instance.current)).toBe(false)
        expect(containsPath(sibling, Instance.current)).toBe(false)
      },
    })
  })

  test("returns false for path with .. escaping worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    await WithInstance.provide({
      directory: tmp.path,
      fn: () => {
        expect(containsPath(path.join(tmp.path, "..", "escape.txt"), Instance.current)).toBe(false)
      },
    })
  })

  test("handles directory === worktree (running from repo root)", async () => {
    await using tmp = await tmpdir({ git: true })
    const sibling = path.join(path.dirname(tmp.path), "outside.txt")

    await WithInstance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.directory).toBe(Instance.worktree)
        expect(containsPath(path.join(tmp.path, "file.txt"), Instance.current)).toBe(true)
        expect(containsPath(sibling, Instance.current)).toBe(false)
      },
    })
  })

  test("non-git project does not allow arbitrary paths via sandbox worktree", async () => {
    await using tmp = await tmpdir() // no git: true

    await WithInstance.provide({
      directory: tmp.path,
      fn: () => {
        const outsideWorktree = path.join(path.dirname(Instance.worktree), "outside")
        expect(containsPath(path.join(tmp.path, "file.txt"), Instance.current)).toBe(true)
        expect(containsPath(path.join(outsideWorktree, "passwd"), Instance.current)).toBe(false)
        expect(containsPath(outsideWorktree, Instance.current)).toBe(false)
      },
    })
  })
})
