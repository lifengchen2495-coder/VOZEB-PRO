import type { OmniClothingProject, OmniClothingSegment } from "@/lib/omni-clothing-contract";

// 飞书公开样例的服装替换规则，服装细节由本次参考图和用户说明提供。
export function buildOmniClothingPrompt(project: Pick<OmniClothingProject, "garmentDescription" | "audioStrategy" | "referenceImages">, segment: Pick<OmniClothingSegment, "startSeconds" | "endSeconds" | "durationSeconds" | "generationDurationSeconds">) {
    return [
        "Edit the supplied source video segment. Replace ONLY the outfit with the target clothing from the reference images. The reference images define the clothing, never the person's identity, pose, background or camera.",
        `Target clothing details: ${project.garmentDescription.trim() || "Use the exact garment shown consistently across the uploaded reference images."}`,
        `Use all ${project.referenceImages.length} clothing reference images to match the front, back, side and detail views. The outfit must be IDENTICAL in every visible detail: color, neckline, sleeves, silhouette, waist, fabric texture, stitching, fastenings, trim and decorative elements. Do not simplify or invent clothing details.`,
        "Preserve the original person's face, identity, hairstyle, body proportions, skin, hands and accessories. Lock ALL person movements EXACTLY as in the original video: same walking path, same turning motion, same gestures, same expressions and same timing. Do not copy a model's face from the clothing images.",
        "Maintain absolute consistency with the original background, camera angles, camera motion, lighting, shadows and framing. Preserve the original shot order. Keep realistic fabric folds, occlusion and motion that follow the original body movement.",
        `This segment covers ${segment.startSeconds.toFixed(3)}–${segment.endSeconds.toFixed(3)} seconds of the source. Preserve its ${segment.durationSeconds.toFixed(3)} seconds of action without speeding up, slowing down or changing the action order.${segment.generationDurationSeconds > segment.durationSeconds + 0.01 ? ` The model output is ${segment.generationDurationSeconds} seconds; after the source action ends, hold the last frame. The extra tail will be trimmed when merging.` : ""}`,
        project.audioStrategy === "preserve"
            ? "Preserve the original speaking motion and timing. Do not invent dialogue, music or new audio. The original source audio will be restored during merging."
            : "Output a silent video. Do not generate speech, music or sound effects.",
        "No logos, captions, subtitles, watermarks or added text. No face replacement, new people, new background, camera redesign, extra limbs or visual deformation.",
    ].join("\n\n");
}
