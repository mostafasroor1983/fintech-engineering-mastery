package com.fintechmastery.recon;

import java.util.Map;

public record IngestResult(long fileId, boolean alreadyImported, int lines, int matched, Map<BreakType, Integer> breaks) {
}
