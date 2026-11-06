package org.acme;

import io.quarkus.test.junit.QuarkusTest;
import jakarta.inject.Inject;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

@QuarkusTest
class DemoEvidenceTest {
    @Inject DemoEvidence evidence;
    @TempDir Path directory;

    @Test
    void evidenceMustBelongToCurrentProcess() throws Exception {
        Path file = directory.resolve("evidence.json");
        Files.writeString(file, "{\"process_id\":\"old-process\",\"costs\":{\"build_seconds\":12}}");
        assertEquals("not-collected", evidence.read(file.toString(), "current-process").get("status"));
        Map<String, Object> result = evidence.read(file.toString(), "old-process");
        assertEquals("collected", result.get("status"));
        assertNotNull(result.get("data"));
    }

    @Test
    void missingOrMalformedEvidenceNeverCreatesMeasurements() throws Exception {
        assertEquals("not-collected", evidence.read(null, "p").get("status"));
        Path file = directory.resolve("bad.json");
        Files.writeString(file, "not JSON");
        assertEquals("not-collected", evidence.read(file.toString(), "p").get("status"));
        assertEquals("not-collected", evidence.read(directory.resolve("missing").toString(), "p").get("status"));
        assertEquals("not-collected", RuntimeMeasurements.measured(-1, "test", "now").get("status"));
    }
    @Test
    void sourceMatchedJibReceiptAndScaleObservationStaySeparateFromProcessMemory() throws Exception {
        Path evidenceDir = Files.createDirectories(directory.resolve("evidence"));
        Path imageDir = Files.createDirectories(directory.resolve("images"));
        Path scaleDir = Files.createDirectories(directory.resolve("scales"));
        Path file = evidenceDir.resolve("p.json");
        Files.writeString(file, "{\"process_id\":\"p\",\"source_hash\":\"source-a\"}");
        Files.writeString(imageDir.resolve("latest.json"), "{\"builder\":\"quarkus-container-image-jib\",\"source_hash\":\"source-a\",\"image_bytes\":123}");
        Files.writeString(scaleDir.resolve("latest.json"), "{\"kind\":\"scale\",\"status\":\"complete\",\"target\":100}");
        Map<?, ?> data = (Map<?, ?>) evidence.read(file.toString(), "p").get("data");
        assertNotNull(data.get("image"));
        assertNotNull(data.get("scale"));
        Files.writeString(imageDir.resolve("latest.json"), "{\"builder\":\"quarkus-container-image-jib\",\"source_hash\":\"different\"}");
        data = (Map<?, ?>) evidence.read(file.toString(), "p").get("data");
        assertNull(data.get("image"));
    }
}
