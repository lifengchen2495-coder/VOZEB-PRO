export function isFullscreenWorkspacePath(pathname: string) {
    return /^\/(?:canvas|drama|remake|remake15|remake60|remake-product|remake-person|omni-clothing|omni-remake|bangbang)\/[^/]+(?:\/|$)/.test(pathname);
}
