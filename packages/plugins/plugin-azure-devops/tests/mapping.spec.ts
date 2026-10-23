import { describe, expect, it } from "vitest";
import {
  azureStateForPaperclipStatus,
  developerAgentKey,
  htmlToText,
  isSyncDue,
  issueDescription,
  paperclipStatusForAzureState,
  parseSettings,
  priorityForAzure,
  repositoriesFromTags,
} from "../src/mapping.js";

describe("azure devops mapping", () => {
  it("skips companies without required settings", () => {
    expect(parseSettings({ organizationUrl: "https://dev.azure.com/acme" })).toBeNull();
    const settings = parseSettings({
      organizationUrl: "https://dev.azure.com/acme",
      project: "Shop",
      personalAccessToken: { type: "secret_ref", secretId: "s1" },
      syncIntervalMinutes: 0,
    });
    expect(settings?.syncIntervalMinutes).toBe(15);
    expect(settings?.doneState).toBe("Closed");
  });

  it("gates scheduled syncs by the configured interval", () => {
    const now = new Date("2026-10-23T10:15:00Z");
    expect(isSyncDue(null, 15, now)).toBe(true);
    expect(isSyncDue("2026-10-23T10:05:00Z", 15, now)).toBe(false);
    expect(isSyncDue("2026-10-23T10:00:00Z", 15, now)).toBe(true);
  });

  it("maps states and priorities both ways", () => {
    expect(paperclipStatusForAzureState("Active")).toBe("in_progress");
    expect(paperclipStatusForAzureState("Resolved")).toBe("in_review");
    expect(paperclipStatusForAzureState("Done")).toBe("done");
    expect(paperclipStatusForAzureState("New")).toBe("todo");
    expect(azureStateForPaperclipStatus("done", { inProgressState: "Active", doneState: "Closed" })).toBe("Closed");
    expect(azureStateForPaperclipStatus("todo", { inProgressState: "Active", doneState: "Closed" })).toBeNull();
    expect(priorityForAzure(1)).toBe("critical");
    expect(priorityForAzure(undefined)).toBe("medium");
  });

  it("derives stable developer agent keys", () => {
    expect(developerAgentKey("Jane.Doe@Acme.com")).toBe("developer:jane.doe-acme.com");
    expect(developerAgentKey("ACME\\jdoe")).toBe("developer:acme-jdoe");
  });

  it("lists repositories from repo: tags in the task description", () => {
    expect(repositoriesFromTags("backend; repo:api ; Repo:web-app")).toEqual(["api", "web-app"]);
    const description = issueDescription(
      { id: 7, rev: 1, url: "", fields: { "System.Tags": "repo:api", "System.Description": "<p>Fix &amp; ship</p>" } },
      { webUrl: "https://dev.azure.com/acme/Shop/_workitems/edit/7", organizationUrl: "https://dev.azure.com/acme/", project: "Shop" },
    );
    expect(description).toContain("- api: https://dev.azure.com/acme/Shop/_git/api");
    expect(description).toContain("Fix & ship");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });
});
