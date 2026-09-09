import { createHmac, timingSafeEqual } from "node:crypto";

import { isProviderReadSignaturePurpose, REFERENCE_ASSET_LONG_SIGNATURE_PURPOSE, REFERENCE_ASSET_SIGNATURE_PURPOSE, type ReferenceAssetSignaturePurpose } from "@/lib/reference-asset-url";

const SIGNED_URL_TTL_SECONDS = 15 * 60;
const LONG_SIGNED_URL_TTL_SECONDS = 90 * 60;
const GENERATION_ASSET_SIGNATURE_SCOPE = "generation";

export type ReferenceAssetSigningOptions = { purpose?: ReferenceAssetSignaturePurpose };

export function createSignedReferenceAssetUrl(token: string, origin: string, ownerUserId: string, now = Date.now(), options: ReferenceAssetSigningOptions = {}) {
    return createSignedAssetUrl("reference-assets", token, token, ownerUserId, origin, now, options);
}

export function createSignedGenerationAssetUrl(token: string, origin: string, ownerUserId: string, now = Date.now(), options: ReferenceAssetSigningOptions = {}) {
    return createSignedAssetUrl("generation-log-assets", token, scopedGenerationToken(token), ownerUserId, origin, now, options);
}

export function signReferenceAssetInputUrl(value: string, origin: string, ownerUserId: string, now = Date.now(), options: ReferenceAssetSigningOptions = {}) {
    return signAssetInputUrl(value, "/api/reference-assets/", origin, ownerUserId, (token) => createSignedReferenceAssetUrl(token, origin, ownerUserId, now, options));
}

export function signGenerationAssetInputUrl(value: string, origin: string, ownerUserId: string, now = Date.now(), options: ReferenceAssetSigningOptions = {}) {
    return signAssetInputUrl(value, "/api/generation-log-assets/", origin, ownerUserId, (token) => createSignedGenerationAssetUrl(token, origin, ownerUserId, now, options));
}

function signAssetInputUrl(value: string, prefix: string, origin: string, ownerUserId: string, createSignedUrl: (token: string) => string) {
    const raw = value.trim();
    if (!raw) return "";
    let url: URL;
    try {
        url = new URL(raw, normalizeOrigin(origin));
    } catch {
        return raw;
    }
    if (!url.pathname.startsWith(prefix)) return raw;
    const token = url.pathname
        .slice(prefix.length)
        .split("/")
        .map((part) => decodeURIComponent(part))
        .join("/");
    return ownerUserId.trim() ? createSignedUrl(token) || raw : raw;
}

export function verifyReferenceAssetSignature(token: string, purpose: string | null, expiresValue: string | null, signature: string | null, ownerUserId: string, now = Date.now()) {
    return verifyAssetSignature(token, purpose, expiresValue, signature, ownerUserId, now);
}

export function verifyGenerationAssetSignature(token: string, purpose: string | null, expiresValue: string | null, signature: string | null, ownerUserId: string, now = Date.now()) {
    return verifyAssetSignature(scopedGenerationToken(token), purpose, expiresValue, signature, ownerUserId, now);
}

function createSignedAssetUrl(route: "reference-assets" | "generation-log-assets", token: string, signedToken: string, ownerUserId: string, origin: string, now: number, options: ReferenceAssetSigningOptions) {
    const secret = signingSecret();
    const normalizedOrigin = normalizeOrigin(origin);
    const owner = ownerUserId.trim();
    const purpose = options.purpose ?? REFERENCE_ASSET_SIGNATURE_PURPOSE;
    if (!secret || !normalizedOrigin || !token || !owner || !isProviderReadSignaturePurpose(purpose)) return "";
    const expires = Math.floor(now / 1000) + signatureTtlSeconds(purpose);
    const signature = sign(signedToken, purpose, expires, owner, secret);
    const path = token.split("/").map(encodeURIComponent).join("/");
    return `${normalizedOrigin}/api/${route}/${path}?purpose=${purpose}&expires=${expires}&signature=${signature}`;
}

function verifyAssetSignature(token: string, purpose: string | null, expiresValue: string | null, signature: string | null, ownerUserId: string, now: number) {
    const secret = signingSecret();
    const owner = ownerUserId.trim();
    const expires = Number(expiresValue);
    const nowSeconds = Math.floor(now / 1000);
    if (!secret || !token || !owner || !isProviderReadSignaturePurpose(purpose) || !signature || !Number.isInteger(expires) || expires <= nowSeconds || expires > nowSeconds + signatureTtlSeconds(purpose)) return false;
    const expected = Buffer.from(sign(token, purpose, expires, owner, secret));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function signatureTtlSeconds(purpose: ReferenceAssetSignaturePurpose) {
    return purpose === REFERENCE_ASSET_LONG_SIGNATURE_PURPOSE ? LONG_SIGNED_URL_TTL_SECONDS : SIGNED_URL_TTL_SECONDS;
}

function scopedGenerationToken(token: string) {
    return `${GENERATION_ASSET_SIGNATURE_SCOPE}\0${token}`;
}

function sign(token: string, purpose: string, expires: number, ownerUserId: string, secret: string) {
    return createHmac("sha256", secret).update(`v1\0${purpose}\0${expires}\0${ownerUserId}\0${token}`).digest("base64url");
}

function signingSecret() {
    return process.env.VOZEB_PRO_REFERENCE_ASSET_SIGNING_KEY?.trim() || process.env.VOZEB_PRO_ENCRYPTION_KEY?.trim() || "";
}

function normalizeOrigin(value: string) {
    try {
        const url = new URL(value.trim());
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
    } catch {
        return "";
    }
}
