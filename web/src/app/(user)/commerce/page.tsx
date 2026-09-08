import { ArrowUpRight, Clapperboard, ImagePlus } from "lucide-react";
import Link from "next/link";

import { commerceImageTool, commerceVideoTools } from "@/constant/commerce-tools";

export default function CommercePage() {
    return (
        <main className="h-full overflow-y-auto bg-background text-foreground">
            <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
                <header className="border-b border-border pb-5 sm:pb-6">
                    <h1 className="text-xl font-semibold sm:text-2xl">电商创作</h1>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">选择视频复刻方式，或为你的商品制作图片。</p>
                </header>

                <section aria-labelledby="commerce-images" className="py-6">
                    <h2 id="commerce-images" className="mb-3 flex items-center gap-2 text-sm font-semibold"><ImagePlus className="size-4" aria-hidden="true" />商品图片</h2>
                    <Link href={`/${commerceImageTool.slug}`} className="group flex items-center gap-4 rounded-lg border border-border bg-muted/25 p-4 transition-colors hover:border-primary/40 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:p-5">
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-background text-primary"><ImagePlus className="size-5" aria-hidden="true" /></span>
                        <div className="min-w-0 flex-1">
                            <h3 className="text-base font-semibold">{commerceImageTool.label}</h3>
                            <p className="mt-1 text-sm leading-6 text-muted-foreground">{commerceImageTool.description}</p>
                        </div>
                        <ArrowUpRight className="size-5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
                    </Link>
                </section>

                <section aria-labelledby="commerce-videos" className="pb-5">
                    <h2 id="commerce-videos" className="mb-3 flex items-center gap-2 text-sm font-semibold"><Clapperboard className="size-4" aria-hidden="true" />视频复刻</h2>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {commerceVideoTools.map((tool) => {
                            const Icon = tool.icon;
                            return (
                                <Link key={tool.slug} href={`/${tool.slug}`} className="group flex items-start gap-3 rounded-lg border border-border p-4 transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                                    <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                    <div className="min-w-0 flex-1">
                                        <h3 className="text-sm font-semibold leading-6">{tool.label}</h3>
                                        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{tool.description}</p>
                                    </div>
                                    <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
                                </Link>
                            );
                        })}
                    </div>
                </section>
            </div>
        </main>
    );
}
