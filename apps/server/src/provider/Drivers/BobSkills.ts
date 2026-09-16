import * as NodeOS from "node:os";

import type { BobSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

type BobSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const VALID_SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
      readonly userInvocable?: boolean;
    };

function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const metadata =
    typeof record.metadata === "object" && record.metadata !== null
      ? (record.metadata as Record<string, unknown>)
      : undefined;

  const disableModelInvocation =
    parseFrontmatterBoolean(record["disable-model-invocation"]) ??
    (metadata ? parseFrontmatterBoolean(metadata["disable-model-invocation"]) : undefined);

  const userInvocable =
    parseFrontmatterBoolean(record["user-invocable"]) ??
    (metadata ? parseFrontmatterBoolean(metadata["user-invocable"]) : undefined);

  return {
    kind: "parsed",
    ...(description ? { description } : {}),
    ...(disableModelInvocation === true ? { userInvocationOnly: true } : {}),
    ...(userInvocable === false ? { userInvocable: false } : {}),
  };
}

/**
 * Resolve Bob skills across workspace and user global directories.
 * Precedence: workspace project (.bob/skills > .agents/skills > .claude/skills)
 * then user global (~/.bob/skills > ~/.agents/skills > ~/.claude/skills).
 */
export const discoverBobSkills = Effect.fn("discoverBobSkills")(function* (
  _config: BobSettings,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const userHome = environment?.HOME || NodeOS.homedir();

  const roots: ReadonlyArray<{ directory: string; scope: BobSkillScope }> = [
    ...(cwd
      ? [
          { directory: path.join(cwd, ".bob", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".claude", "skills"), scope: "project" as const },
        ]
      : []),
    { directory: path.join(userHome, ".bob", "skills"), scope: "user" as const },
    { directory: path.join(userHome, ".agents", "skills"), scope: "user" as const },
    { directory: path.join(userHome, ".claude", "skills"), scope: "user" as const },
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const name = entry.trim();
      if (!name || !VALID_SKILL_NAME_PATTERN.test(name)) {
        continue;
      }

      if (skillsByName.has(name)) {
        continue;
      }

      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const userInvocationOnly =
        frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true;

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
        ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
          ? { userInvocable: false }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
