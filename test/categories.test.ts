import { describe, expect, it } from "vitest";
import { categorize } from "../src/tasks/categories.ts";

const bash = (command: string) => categorize("Bash", { command });

describe("categorize", () => {
  it("finds pushes", () => {
    expect(bash("git push origin main")).toEqual(["push"]);
    expect(bash("git  push")).toEqual(["push"]);
    expect(bash("gh pr create --fill")).toEqual(["push"]);
    expect(bash("gh pr merge 12")).toEqual(["push"]);
    expect(bash("gh release create v1")).toEqual(["push"]);
    expect(bash("git pushd")).toEqual([]);
    expect(bash("gh pr view 12")).toEqual([]);
  });

  it("finds deploys", () => {
    for (const c of [
      "vercel deploy --prebuilt",
      "netlify deploy",
      "fly deploy",
      "kubectl apply -f x.yaml",
      "helm upgrade a b",
      "terraform apply",
      "docker push img",
      "docker compose up -d",
      "bash deploy/deploy.sh",
      "./deploy/run.sh",
    ]) {
      expect(bash(c), c).toContain("deploy");
    }
    expect(bash("terraform plan")).toEqual([]);
    expect(bash("docker compose ps")).toEqual([]);
  });

  it("finds deletes", () => {
    for (const c of [
      "rm -rf dist",
      "rm -f a.txt",
      "rm -Rf x",
      "git reset --hard HEAD~1",
      "git clean -fdx",
      "git branch -D topic",
      'psql -c "DROP TABLE users"',
      "drop database app",
    ]) {
      expect(bash(c), c).toContain("delete");
    }
    expect(bash("rm a.txt")).toEqual([]);
    expect(bash("git branch -d merged")).toEqual([]);
    expect(bash("git reset --soft HEAD~1")).toEqual([]);
  });

  it("finds prod and remote hosts in any tool input", () => {
    expect(bash("ssh web-app uptime")).toEqual(["prod"]);
    expect(bash("scp a web-app:/tmp")).toEqual(["prod"]);
    expect(
      categorize("Edit", {
        file_path: "/srv/prod/config.yaml",
        old_string: "a",
        new_string: "b",
      }),
    ).toEqual(["prod"]);
    expect(
      categorize("Read", { file_path: "/srv/production/notes.md" }),
    ).toEqual([]);
    expect(categorize("Grep", { pattern: "productivity" })).toEqual([]);
  });

  it("combines categories and ignores Bash-only matchers for other tools", () => {
    expect(bash("git push && ssh prod deploy")).toEqual([
      "push",
      "deploy",
      "prod",
    ]);
    expect(
      categorize("Write", {
        file_path: "/x/notes.md",
        content: "git push origin main; rm -rf /",
      }),
    ).toEqual([]);
    expect(categorize("Bash", null)).toEqual([]);
    expect(categorize("Bash", "git push")).toEqual(["push"]);
  });
});
