# Java 25 Compatibility Warnings

## Issue
When running Maven with Java 25, you may see warnings about deprecated `sun.misc.Unsafe` methods:

```
WARNING: A terminally deprecated method in sun.misc.Unsafe has been called
WARNING: sun.misc.Unsafe::objectFieldOffset has been called by com.google.common.util.concurrent.AbstractFuture$UnsafeAtomicHelper
```

## Root Cause
These warnings originate from **Guava library** (version 33.2.1) used by Maven 3.9.9. The Guava library uses deprecated `sun.misc.Unsafe` APIs that will be removed in a future Java release.

## What We've Fixed
1. ✅ **Jansi native access warnings** - Resolved via `.mvn/jvm.config`
2. ✅ **Quarkus Maven extension argLine warnings** - Fixed in `pom.xml`
3. ✅ **Deprecated quarkus-junit5 artifact** - Updated to `quarkus-junit`
4. ✅ **Upgraded Maven** from 3.9.6 to 3.9.9 (latest stable)

## Remaining Warnings
The `sun.misc.Unsafe` warnings **cannot be suppressed** in Java 25 as they are hardcoded JVM warnings. These are:
- **Informational only** - they don't affect functionality
- **From Maven's dependencies** - not from your application code
- **Will be fixed** when Guava releases a Java 25-compatible version

## Workarounds

### Option 1: Use the Quiet Wrapper (Recommended)
Use `./mvnw-quiet` instead of `./mvnw` to filter out these specific warnings:

```bash
./mvnw-quiet clean compile
./mvnw-quiet quarkus:dev
```

### Option 2: Accept the Warnings
These warnings are harmless and can be safely ignored. They indicate that Maven's dependencies use deprecated APIs, but this doesn't affect your application.

### Option 3: Downgrade to Java 21 LTS
If the warnings are problematic for your workflow:

```bash
sdk use java 21.0.x-tem
```

## Future Resolution
These warnings will disappear when:
- Guava releases a version that doesn't use `sun.misc.Unsafe`
- Maven upgrades to the newer Guava version
- Or when you upgrade to a future Java version where these APIs are removed (forcing library updates)