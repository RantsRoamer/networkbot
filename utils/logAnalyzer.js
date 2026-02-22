// utils/logAnalyzer.js
// Log parsing and analysis utilities

/**
 * Extract common log patterns (errors, warnings, timestamps)
 */
function extractLogPatterns(snippet) {
  const patterns = {
    errors: [],
    warnings: [],
    timestamps: [],
    ipAddresses: [],
    urls: [],
  };

  const lines = snippet.split('\n');
  
  lines.forEach((line, index) => {
    // Extract error patterns
    if (/error|exception|fatal|critical/i.test(line)) {
      patterns.errors.push({ line: index + 1, content: line.trim() });
    }
    
    // Extract warning patterns
    if (/warn|warning/i.test(line) && !/error/i.test(line)) {
      patterns.warnings.push({ line: index + 1, content: line.trim() });
    }
    
    // Extract timestamps (common formats)
    const timestampMatch = line.match(/\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}|\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}/);
    if (timestampMatch) {
      patterns.timestamps.push(timestampMatch[0]);
    }
    
    // Extract IP addresses
    const ipMatch = line.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    if (ipMatch) {
      patterns.ipAddresses.push(ipMatch[0]);
    }
    
    // Extract URLs
    const urlMatch = line.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      patterns.urls.push(urlMatch[0]);
    }
  });

  return patterns;
}

/**
 * Analyze log snippet and return structured information
 */
async function analyzeLogSnippet(snippet) {
  if (!snippet || snippet.trim().length === 0) {
    return { summary: 'Empty log snippet provided.', patterns: null };
  }

  const patterns = extractLogPatterns(snippet);
  
  const summary = {
    totalLines: snippet.split('\n').length,
    errorCount: patterns.errors.length,
    warningCount: patterns.warnings.length,
    hasTimestamps: patterns.timestamps.length > 0,
    uniqueIPs: [...new Set(patterns.ipAddresses)].length,
    hasUrls: patterns.urls.length > 0,
  };

  return {
    summary,
    patterns: {
      errors: patterns.errors.slice(0, 5), // Limit to first 5
      warnings: patterns.warnings.slice(0, 5),
      timestamps: [...new Set(patterns.timestamps)].slice(0, 3),
      ipAddresses: [...new Set(patterns.ipAddresses)].slice(0, 5),
      urls: patterns.urls.slice(0, 3),
    },
  };
}

module.exports = { analyzeLogSnippet, extractLogPatterns };
