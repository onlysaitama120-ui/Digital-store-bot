function formatProduct(raw) {
    let text = raw;
    const NL = String.fromCharCode(10);
    const ARROW = String.fromCharCode(8594);

    // If text has no newlines (flat paste), split by known section markers
    if (!text.includes(NL)) {
        // Split before emoji colons and unicode emojis
        text = text.replace(/([:📺🎬🎵📱🎮🎧])/g, NL + '$1');
        // Split before arrows
        const arrowPat = new RegExp(ARROW + ' ', 'g');
        text = text.replace(arrowPat, NL + ARROW + ' ');
    }

    // Clean up multiple blank lines
    while (text.includes(NL + NL + NL)) {
        text = text.split(NL + NL + NL).join(NL + NL);
    }
    return text.trim();
}
