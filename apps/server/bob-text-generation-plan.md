# Plan: Enable Bob Shell for Text Generation

## Overview

Implement headless non-interactive text generation for **Bob Shell** via its standard Agent Client Protocol (ACP) interface (`bob acp`). This will enable Bob to generate commit messages, PR descriptions/titles, branch names, and thread titles directly, eliminating the `Bob Shell does not support text generation` error.

---

## Sub-Tasks

### Sub-Task 1: Update Contract Constants for Bob Defaults

- **Intent**: Define default model constants for Bob in `@t3tools/contracts` so that Bob has default text-generation models mapped.
- **Expected Outcomes**:
  - `DEFAULT_MODEL_BY_PROVIDER` and `DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER` include `BOB_DRIVER_KIND` mapped to `BOB_DEFAULT_MODEL_SLUG` (`bob-build`).
- **Todo List**:
  - [ ] Add `bob` mapping in `packages/contracts/src/model.ts` for `DEFAULT_MODEL_BY_PROVIDER` and `DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER`.
- **Relevant Context**: `packages/contracts/src/model.ts`, `src/provider/acp/BobAcpSupport.ts`
- **Status**: [ ] pending

---

### Sub-Task 2: Implement BobTextGeneration via ACP Runtime

- **Intent**: Replace the stub in `BobTextGeneration.ts` with a full implementation that launches a scoped Bob ACP session (`makeBobAcpRuntime`), sends prompt text, listens for streaming message chunks, extracts structured JSON, and returns sanitized results.
- **Expected Outcomes**:
  - `makeBobTextGeneration(bobSettings, environment)` implements:
    - `generateCommitMessage`
    - `generatePrContent`
    - `generateBranchName`
    - `generateThreadTitle`
  - Proper timeout and error wrapping with `TextGenerationError`.
- **Todo List**:
  - [ ] Update `src/textGeneration/BobTextGeneration.ts` following the proven pattern in `GrokTextGeneration.ts`.
  - [ ] Wire ACP output parsing with `extractJsonObject` and schema decoding.
  - [ ] Add sanitization for outputs using `TextGenerationUtils.ts` and `sanitizeFeatureBranchName` / `sanitizeBranchFragment`.
- **Relevant Context**: `src/textGeneration/BobTextGeneration.ts`, `src/textGeneration/GrokTextGeneration.ts`, `src/provider/acp/BobAcpSupport.ts`
- **Status**: [ ] pending

---

### Sub-Task 3: Update Bob Driver & Server Settings

- **Intent**: Connect `BobDriver` to pass configuration and environment into `makeBobTextGeneration`, and remove Bob from `DRIVERS_WITHOUT_TEXT_GENERATION`.
- **Expected Outcomes**:
  - `BobDriver.ts` instantiates `makeBobTextGeneration(effectiveConfig, processEnv)`.
  - `serverSettings.ts` removes `bob` from `DRIVERS_WITHOUT_TEXT_GENERATION`, allowing automatic fallback and selection of Bob for text generation.
- **Todo List**:
  - [ ] In `src/provider/Drivers/BobDriver.ts`, pass `effectiveConfig` and `processEnv` to `makeBobTextGeneration`.
  - [ ] In `src/serverSettings.ts`, remove `"bob"` from `DRIVERS_WITHOUT_TEXT_GENERATION` (or remove the set if empty).
- **Relevant Context**: `src/provider/Drivers/BobDriver.ts`, `src/serverSettings.ts`
- **Status**: [ ] pending

---

### Sub-Task 4: Add Unit Tests for BobTextGeneration

- **Intent**: Ensure robust test coverage for Bob text generation using a mock ACP agent CLI wrapper.
- **Expected Outcomes**:
  - `src/textGeneration/BobTextGeneration.test.ts` tests commit message, branch name, PR content, and thread title generation against mock ACP responses.
  - Verifies error cases (empty output, invalid JSON, timeouts).
- **Todo List**:
  - [ ] Create `src/textGeneration/BobTextGeneration.test.ts` patterned after `GrokTextGeneration.test.ts`.
  - [ ] Run test suite to verify all text generation cases pass.
- **Relevant Context**: `src/textGeneration/GrokTextGeneration.test.ts`, `scripts/acp-mock-agent.ts`
- **Status**: [ ] pending
