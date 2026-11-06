export function deploymentDefaults() {
  return {
    image: "quay.io/danieloh30/high-perf-java:1.0",
    platform: "linux/amd64",
    consoleUrl: "",
    namespace: "high-perf-java",
    deployment: "high-perf-java",
    applicationUrl: "",
  };
}
export function taggedImage(value) {
  return (
    typeof value === "string" &&
    /^[a-z0-9.-]+(?::[0-9]+)?\/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(
      value,
    )
  );
}
export function consoleLink(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      ["access_token", "id_token", "token", "code"].some((k) =>
        url.searchParams.has(k),
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function deploymentCommands(settings) {
  if (
    !taggedImage(settings.image) ||
    !["linux/amd64", "linux/arm64"].includes(settings.platform)
  )
    return null;
  const args = `--image '${settings.image}' --platform '${settings.platform}'`;
  return {
    build: `./demo.sh image ${args}`,
    push: `./demo.sh image ${args} --push`,
    run: `podman run --rm --pull=never -p 127.0.0.1:8082:8080 --cpus=2 --memory=512m -e JAVA_TOOL_OPTIONS='-Xms64m -Xmx256m -XX:ActiveProcessorCount=2' '${settings.image}'`,
  };
}
export function matchingReceipt(settings) {
  const r = settings.receipt;
  return r?.builder === "quarkus-container-image-jib" &&
    r.runtime === "jvm" &&
    r.image === settings.image &&
    r.platform === settings.platform &&
    /^sha256:[a-f0-9]{64}$/.test(r.digest)
    ? r
    : null;
}
export function deployReference(settings) {
  if (!taggedImage(settings.image)) return null;
  const receipt = matchingReceipt(settings);
  return receipt?.published
    ? settings.image.replace(/:[^/:]+$/, "") + "@" + receipt.digest
    : settings.image;
}

export function scaleCommands(settings) {
  if (
    !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(settings.namespace) ||
    !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(settings.deployment)
  )
    return null;
  const args = [
    settings.namespace === "high-perf-java"
      ? ""
      : ` --namespace '${settings.namespace}'`,
    settings.deployment === "high-perf-java"
      ? ""
      : ` --deployment '${settings.deployment}'`,
  ].join("");
  return {
    out: `./demo.sh scale 100${args}`,
    inside: `./demo.sh scale 1${args}`,
  };
}
