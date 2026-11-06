import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deploymentDefaults,
  consoleLink,
  taggedImage,
  deploymentCommands,
  deployReference,
  scaleCommands,
} from "../src/main/resources/META-INF/resources/deployment.mjs";
import {
  fresh,
  decode,
} from "../src/main/resources/META-INF/resources/session.mjs";
test("image references are OCI tags, not registry web pages or shell commands", () => {
  const s = deploymentDefaults();
  assert.equal(taggedImage(s.image), true);
  assert.equal(
    taggedImage(
      "https://quay.io/repository/danieloh30/high-perf-java?tab=info",
    ),
    false,
  );
  assert.equal(taggedImage("quay.io/me/demo:x';touch /tmp/no"), false);
  assert.match(deploymentCommands(s).build, /demo.sh image/);
  assert.match(deploymentCommands(s).push, /--push$/);
  assert.match(deploymentCommands(s).run, /127.0.0.1:8082:8080/);
});
test("console links never accept scripts, embedded credentials or auth callbacks", () => {
  assert.equal(consoleLink("javascript:alert(1)"), null);
  assert.equal(consoleLink("https://user:secret@console.example"), null);
  assert.equal(
    consoleLink("https://console.example/?access_token=secret"),
    null,
  );
  assert.equal(
    consoleLink("https://console.example/topology/ns/demo?view=graph"),
    "https://console.example/topology/ns/demo?view=graph",
  );
});
test("only a matching published Jib receipt promotes deployment to a digest reference", () => {
  const s = deploymentDefaults();
  s.receipt = {
    builder: "quarkus-container-image-jib",
    runtime: "jvm",
    image: s.image,
    platform: s.platform,
    digest: "sha256:" + "a".repeat(64),
    published: false,
  };
  assert.equal(deployReference(s), s.image);
  s.receipt.published = true;
  assert.match(deployReference(s), /@sha256:/);
  s.receipt.image = "quay.io/other/app:tag";
  assert.equal(deployReference(s), s.image);
});
test("scaling commands use concise defaults and retain explicit overrides; old phases migrate", () => {
  const s = deploymentDefaults();
  assert.equal(s.image, "quay.io/danieloh30/high-perf-java:1.0");
  assert.equal(scaleCommands(s).out, "./demo.sh scale 100");
  assert.equal(scaleCommands(s).inside, "./demo.sh scale 1");
  s.namespace = "my-project";
  s.deployment = "my-app";
  assert.equal(
    scaleCommands(s).out,
    "./demo.sh scale 100 --namespace 'my-project' --deployment 'my-app'",
  );
  s.namespace = "x; oc delete all";
  assert.equal(scaleCommands(s), null);
  const old = fresh();
  delete old.presentationVersion;
  delete old.deployment;
  old.phase = 4;
  const restored = decode(JSON.stringify(old));
  assert.equal(restored.phase, 5);
  assert.equal(restored.deployment.platform, "linux/amd64");
});
