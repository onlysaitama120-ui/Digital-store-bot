function formatProduct(raw) {
    const lines = raw.split(String.fromCharCode(13, 10));
    const result = [];
    for (const line of lines) {
        result.push(line);
    }
    // Also split on lone newlines
    const combined = result.join(String.fromCharCode(10));
    return combined.trim();
}
