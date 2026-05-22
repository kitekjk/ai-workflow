import { describe, expect, it } from "vitest";
import { configuredCredentialEnvKeys, credentialEnvAllowlist, redactSecrets } from "../../backend/src/runtime/secrets";

describe("runtime secret handling", () => {
  it("keeps credential environment keys on an explicit allowlist", () => {
    expect(credentialEnvAllowlist()).toEqual([
      "JIRA_API_TOKEN",
      "CONFLUENCE_API_TOKEN",
      "GITHUB_TOKEN",
      "WORKFLOW_APP_API_TOKEN",
      "WORKFLOW_RUNNER_TOKENS",
      "LOCAL_RUNNER_TOKEN",
      "WORKFLOW_MYSQL_PASSWORD",
      "WORKFLOW_MYSQL_ROOT_PASSWORD"
    ]);
    expect(
      configuredCredentialEnvKeys({
        JIRA_API_TOKEN: "jira-token",
        GITHUB_TOKEN: "ghp_secret",
        WORKFLOW_APP_API_TOKEN: "app-secret",
        UNRELATED_TOKEN: "not-used-by-runtime"
      })
    ).toEqual(["JIRA_API_TOKEN", "GITHUB_TOKEN", "WORKFLOW_APP_API_TOKEN"]);
  });

  it("redacts secret-looking keys, known env values, authorization headers, and token query params", () => {
    expect(
      redactSecrets(
        {
          status: "failed",
          apiToken: "jira-token",
          nested: {
            message: "GitHub returned Bearer ghp_secret",
            url: "https://example.com/callback?token=ghp_secret&ok=1",
            safe: "visible"
          }
        },
        {
          env: {
            JIRA_API_TOKEN: "jira-token",
            GITHUB_TOKEN: "ghp_secret",
            WORKFLOW_RUNNER_TOKENS: "runner-a:runner-secret"
          }
        }
      )
    ).toEqual({
      status: "failed",
      apiToken: "[REDACTED]",
      nested: {
        message: "GitHub returned Bearer [REDACTED]",
        url: "https://example.com/callback?token=[REDACTED]&ok=1",
        safe: "visible"
      }
    });
    expect(
      redactSecrets("runner failed with runner-secret", {
        env: {
          WORKFLOW_RUNNER_TOKENS: JSON.stringify({
            "runner-a": "runner-secret"
          })
        }
      })
    ).toBe("runner failed with [REDACTED]");
  });
});
