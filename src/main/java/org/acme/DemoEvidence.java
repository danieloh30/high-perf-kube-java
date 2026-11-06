package org.acme;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/** Read-only bridge from the terminal launcher. Never accepts a path from HTTP. */
@ApplicationScoped
public class DemoEvidence {
    @Inject ObjectMapper mapper;

    public Map<String, Object> read(String processId) {
        return read(System.getProperty("demo.evidence.path"), processId);
    }

    Map<String, Object> read(String configuredPath, String processId) {
        if (configuredPath == null || configuredPath.isBlank())
            return Map.of("status", "not-collected", "reason", "Start with ./demo.sh up to attach build and launch evidence.");
        try {
            Path path = Path.of(configuredPath);
            if (!Files.isRegularFile(path) || Files.size(path) > 1_048_576)
                return Map.of("status", "not-collected", "reason", "Launcher evidence is not available yet.");
            Map<String, Object> data = mapper.readValue(path.toFile(), new TypeReference<Map<String, Object>>() {});
            if (!processId.equals(data.get("process_id")))
                return Map.of("status", "not-collected", "reason", "Evidence belongs to a different process; excluded.");
            return Map.of("status", "collected", "data", data);
        } catch (Exception e) {
            return Map.of("status", "not-collected", "reason", "Launcher evidence could not be read; no values inferred.");
        }
    }
}
