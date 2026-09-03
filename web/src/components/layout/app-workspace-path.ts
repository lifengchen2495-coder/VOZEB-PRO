export function isFullscreenWorkspacePath(pathname: string) {
    return /^\/(?:canvas|drama|remake)\/[^/]+(?:\/|$)/.test(pathname);
}
