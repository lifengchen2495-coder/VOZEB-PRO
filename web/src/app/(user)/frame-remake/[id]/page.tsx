import { FrameRemakeWorkspace } from "./workspace";
export default async function FrameRemakeProjectPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <FrameRemakeWorkspace key={id} id={id} />;
}
