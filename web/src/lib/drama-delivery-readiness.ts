import type { DramaEpisode } from "@/lib/drama-project-contract";

export function dramaEpisodeDeliveryIssue(episode: DramaEpisode) {
    if (episode.contentStale) return "剧本或上游设定已修改，请重新分析并审核分镜后再交付";
    if (episode.shots.some((shot) => shot.productionStale)) return "部分镜头保留的是旧版素材，请重新生成待更新镜头后再交付";
    return undefined;
}
