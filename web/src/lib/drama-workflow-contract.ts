export type DramaWorkflowStage = "story" | "characters" | "beats" | "script";

export type DramaStoryData = {
    logline: string;
    genre: string;
    audience: string;
    worldRules: string;
    coreConflict: string;
    adaptationMode: "original" | "faithful" | "free";
    lockedFacts: string;
    targetDuration: number;
    episodeCount: number;
};

export type DramaCharacterBiography = {
    id: string;
    name: string;
    aliases: string[];
    role: string;
    background: string;
    motivation: string;
    personality: string;
    relationships: string;
    arc: string;
    visualIdentity: string;
    voiceStyle: string;
    signatureAction: string;
};

export type DramaCharactersData = { characters: DramaCharacterBiography[] };

export type DramaBeatsData = {
    outline: string;
    hook: string;
    nextPreview: string;
    beats: Array<{ id: string; title: string; duration: number; description: string; emotion: string; payoff: string }>;
};

export type DramaScriptData = {
    scenes: Array<{
        id: string;
        title: string;
        location: string;
        time: string;
        lighting: string;
        blocks: Array<{ id: string; type: "action" | "dialogue" | "narration"; speaker: string; text: string }>;
    }>;
};

export type DramaWorkflowDataByStage = {
    story: DramaStoryData;
    characters: DramaCharactersData;
    beats: DramaBeatsData;
    script: DramaScriptData;
};

export type DramaWorkflowArtifactFor<S extends DramaWorkflowStage> = S extends DramaWorkflowStage
    ? {
          id: string;
          stage: S;
          episodeId?: string;
          version: number;
          createdAt: string;
          source: "manual" | "ai";
          methodVersion: string;
          status: "candidate" | "adopted";
          inputFingerprint: string;
          adoptedFingerprint?: string;
          instructions?: string;
          data: DramaWorkflowDataByStage[S];
      }
    : never;

export type DramaWorkflowArtifact = { [S in DramaWorkflowStage]: DramaWorkflowArtifactFor<S> }[DramaWorkflowStage];

export type DramaWorkflow = { schemaVersion: 1; artifacts: DramaWorkflowArtifact[] };
