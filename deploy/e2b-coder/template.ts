/**
 * agent-os-coder — the Model-B "iterate-in-box" sandbox toolchain (ADR-0047), E2B **v2** SDK.
 *
 * E2B deprecated the v1 Dockerfile build (`e2b template build --dockerfile` now no-ops), so the
 * template is defined here with the v2 builder instead of e2b.Dockerfile/e2b.toml. We still base
 * on e2bdev/code-interpreter so the sandbox keeps BOTH surfaces the e2b adapter drives:
 *   - runCode()      → the Jupyter kernel (the code-interpreter image provides it), and
 *   - commands.run() → real bash,
 * then layer the compiled-language toolchains so `go test` / `mvn test` / `npm test` run for real
 * inside the session (the whole point of Model B over the Code-Execution "blind editor").
 *
 * v2 gotchas baked in below (both verified against the e2b@2.x type defs):
 *   - The default user is `user`, not root → privileged steps pass { user: "root" }.
 *     (aptInstall runs privileged on its own, so it needs no user override.)
 *   - setEnvs() is BUILD-TIME ONLY — it does not persist into the running sandbox. So Go is put on
 *     the RUN-time PATH by symlinking into /usr/local/bin (already on PATH), NOT by exporting PATH.
 *
 * Build + publish with `bun run build` (see build.ts / README.md).
 */
import { Template } from "e2b";

// Pinned toolchains — the distro packages lag, and coder builds want current toolchains.
const GO_VERSION = "1.22.5";
const GRADLE_VERSION = "8.10.2"; // JVM builds use Gradle (not Maven); repos with ./gradlew work too.

export const template = Template()
  .fromImage("e2bdev/code-interpreter:latest")
  // git + a JDK from the distro, plus unzip for the Gradle distribution below.
  .aptInstall(["git", "ca-certificates", "curl", "unzip", "default-jdk"], { noInstallRecommends: true })
  // Go — install the pinned tarball, then symlink onto the runtime PATH (setEnvs would only
  // affect the build, not the running sandbox).
  .runCmd(
    [
      `curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz`,
      "ln -sf /usr/local/go/bin/go /usr/local/bin/go",
      "ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt",
    ],
    { user: "root" },
  )
  // Gradle — pinned distribution zip (the distro package is far behind), symlinked onto PATH. A
  // JDK is already present; most real repos also carry a ./gradlew wrapper, which needs no system
  // Gradle at all — this covers the ones that don't.
  .runCmd(
    [
      `curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip`,
      "unzip -q /tmp/gradle.zip -d /opt && rm /tmp/gradle.zip",
      `ln -sf /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle`,
    ],
    { user: "root" },
  )
  // Node 20 LTS (NodeSource) — a current node/npm for JS/TS repos.
  .runCmd(
    "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y --no-install-recommends nodejs",
    { user: "root" },
  )
  // The e2bdev/code-interpreter base ships a STALE JAVA_HOME (`/usr/lib/jvm/jdk-`, a broken
  // interpolation pointing at a non-existent dir). Gradle/gradlew honour JAVA_HOME over PATH, so
  // they die on it — at BOTH build and run time (setEnvs is build-only, so it can't fix runtime).
  // Point that exact path at the real JDK *root* so the inherited JAVA_HOME resolves everywhere.
  // (Placed after the toolchain installs so those expensive layers stay cached across rebuilds.)
  .runCmd('ln -sfn "$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")" /usr/lib/jvm/jdk-', {
    user: "root",
  })
  // Fail the build if any toolchain is missing — surfaces version drift at build time, not at the
  // first coder run. One check per step (as the default `user`, i.e. the runtime identity): E2B's
  // BuildError names the failing command, so a broken tool is identified from the error alone.
  .runCmd("go version")
  .runCmd("java -version")
  .runCmd("gradle -version")
  .runCmd("node --version")
  .runCmd("git --version");
