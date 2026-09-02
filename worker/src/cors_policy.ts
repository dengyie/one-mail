/**
 * CORS origin validator for Worker endpoints.
 * Explicitly allows deployed frontend domains, configured FRONTEND_URL,
 * local dev servers, and legitimate subdomains while preventing suffix hijacking
 * (e.g., evil-mangoqwq.com).
 */
export const resolveCorsOrigin = (origin: string, frontendUrl?: string): string => {
    if (!origin) return '';
    const configuredFrontend = frontendUrl ? frontendUrl.split(',').map(s => s.trim()) : [];
    const allowed = new Set([
        'https://inbox.mangoqwq.com',
        'https://mail.mangoqwq.com',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:4173',
        'http://127.0.0.1:4173',
        ...configuredFrontend,
    ].filter(Boolean));
    if (allowed.has(origin)) return origin;

    try {
        const url = new URL(origin);
        const isAllowedDomain = (hostname: string, base: string) =>
            hostname === base || hostname.endsWith(`.${base}`);
        if (isAllowedDomain(url.hostname, 'mangoqwq.com') ||
            isAllowedDomain(url.hostname, 'mangoqwq.cc.cd') ||
            url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
            return origin;
        }
    } catch {}
    return '';
};
