import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { BobSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverBobSkills } from "./BobSkills.ts";

const dummyConfig: BobSettings = {
  enabled: true,
  binaryPath: "",
  apiKey: "",
  customModels: [],
};

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverBobSkills", (it) => {
  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bob-skills-" });
      const userHome = path.join(tempDir, "user-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(workspace, ".bob", "skills"),
        "test-project-skill",
        `---
name: test-project-skill
description: Project skill description
---
# Project Skill
`,
      );

      yield* writeSkill(
        path.join(userHome, ".bob", "skills"),
        "test-user-skill",
        `---
name: test-user-skill
description: User skill description
metadata:
  disable-model-invocation: true
---
# User Skill
`,
      );

      const skills = yield* discoverBobSkills(dummyConfig, workspace, { HOME: userHome });

      assert.strictEqual(skills.length, 2);
      const [projectSkill, userSkill] = skills;
      assert.isDefined(projectSkill);
      assert.isDefined(userSkill);
      assert.strictEqual(projectSkill.name, "test-project-skill");
      assert.strictEqual(projectSkill.scope, "project");
      assert.strictEqual(projectSkill.description, "Project skill description");
      assert.strictEqual(projectSkill.userInvocationOnly, undefined);

      assert.strictEqual(userSkill.name, "test-user-skill");
      assert.strictEqual(userSkill.scope, "user");
      assert.strictEqual(userSkill.description, "User skill description");
      assert.strictEqual(userSkill.userInvocationOnly, true);
    }),
  );

  it.effect("respects skill precedence where project overrides user skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bob-skills-" });
      const userHome = path.join(tempDir, "user-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(workspace, ".bob", "skills"),
        "shared-skill",
        `---
name: shared-skill
description: Workspace override
---
`,
      );

      yield* writeSkill(
        path.join(userHome, ".bob", "skills"),
        "shared-skill",
        `---
name: shared-skill
description: User global
---
`,
      );

      const skills = yield* discoverBobSkills(dummyConfig, workspace, { HOME: userHome });

      assert.strictEqual(skills.length, 1);
      const [skill] = skills;
      assert.isDefined(skill);
      assert.strictEqual(skill.name, "shared-skill");
      assert.strictEqual(skill.scope, "project");
      assert.strictEqual(skill.description, "Workspace override");
    }),
  );
});
