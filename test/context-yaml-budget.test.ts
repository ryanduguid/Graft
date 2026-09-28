import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readNodes } from "../src/context/node-file.js";
import { tmpRepo } from "./helpers.js";

function parseNode(frontmatter: string) {
  const dir = tmpRepo("yaml-budget");
  try {
    writeFileSync(join(dir, "sample.md"), `---\n${frontmatter}---\n\n# Fixture\n`);
    return readNodes(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mergeTargets = "  - <<: *arr\n".repeat(101);
const emptySources = {
  flow: "arr: &arr [" + Array(100).fill("{}").join(",") + "]\n",
  block: "arr: &arr\n" + "  - {}\n".repeat(100),
  aliases: "empty: &empty {}\narr: &arr [" + Array(100).fill("*empty").join(",") + "]\n",
};

for (const [syntax, source] of Object.entries(emptySources)) {
  test(`context YAML counts empty ${syntax} merge sources against its work budget`, () => {
    // Each sequence stays within the separate 100-source limit.
    assert.throws(
      () => parseNode(source + "targets:\n" + mergeTargets),
      /merge keys exceeded maxTotalMergeKeys/,
    );
  });
}

test("context YAML retains ordinary metadata, aliases and named mapping merges", () => {
  const [node] = parseNode(
    "defaults: &defaults {name: Ordinary, type: concept}\n" +
    "<<: *defaults\nslug: ordinary\n" +
    "refs: &refs [{path: src/example.ts, hash: fixture}]\nsources: *refs\n" +
    "sources_digest: fixture\nlinks: [{to: neighbour, relation: uses}]\n",
  );
  assert.deepEqual(node, {
    slug: "ordinary", name: "Ordinary", type: "concept",
    sources: [{ path: "src/example.ts", hash: "fixture" }],
    sourcesDigest: "fixture", links: [{ to: "neighbour", relation: "uses" }],
  });
});

test("context YAML permits small empty mapping merges", () => {
  const [node] = parseNode("arr: &arr [{}, {}]\n<<: *arr\nslug: small\nname: Small\n");
  assert.equal(node.slug, "small");
  assert.equal(node.name, "Small");
});

test("context YAML retains the existing keyed merge budget", () => {
  const keys = Array.from({ length: 100 }, (_, i) => `k${i}: 1`).join(",");
  assert.throws(
    () => parseNode(`arr: &arr {${keys}}\ntargets:\n${mergeTargets}`),
    /merge keys exceeded maxTotalMergeKeys/,
  );
});
